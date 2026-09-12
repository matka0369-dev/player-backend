import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerSource, LedgerWallet, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PERMISSIONS } from '../rbac/permissions.constants';
import { effectiveTier, resolveScopeOwnerId } from '../rbac/scope.util';

type Tx = Prisma.TransactionClient;

/** Sanity bound on a single grant — not a currency limit, a fat-finger guard. */
export const MAX_GRANT = 10_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** [start, end) in UTC for the calendar day `date` (a "YYYY-MM-DD" string)
 *  names. Ledger entries carry no per-user timezone, so the day boundary is
 *  plain UTC rather than trying to guess whose local day a caller means. */
function utcDayRange(date: string): { gte: Date; lt: Date } {
  const gte = new Date(`${date}T00:00:00.000Z`);
  return { gte, lt: new Date(gte.getTime() + 24 * 60 * 60 * 1000) };
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The one way a balance is ever allowed to move.
   *
   * Writes the append-only ledger entry and the cached balance column in a
   * single transaction, so the cache can never disagree with the ledger that
   * is its source of truth. Callers pass their own `tx` when the movement has
   * to be atomic with something else (an opening balance belongs to the
   * account creation that caused it, not to a second request that might not
   * happen).
   *
   * `wallet` picks which of the two balances moves — MAIN by default;
   * settlement pays winners into WINNINGS. The entry records it so
   * `balanceAfter` is never ambiguous about which column it snapshots.
   *
   * Closed-loop in the sense that matters: there is no path in or out of
   * this system, and a token is never denominated in or convertible to
   * currency. It is deliberately *not* supply-conserving — settlement
   * destroys a stake and creates a payout, neither with a counterparty (see
   * ARCHITECTURE.md "wallets no longer conserve"). What stays invariant is
   * that only an Admin can mint, and that each user's cached balance equals
   * their own ledger sum per wallet — which this method is what guarantees.
   * Note this moves *one* account — see `transfer` for the paired form that
   * moves tokens between two without creating any.
   */
  async applyDelta(
    tx: Tx,
    params: {
      userId: string;
      delta: number;
      source: LedgerSource;
      wallet?: LedgerWallet;
      performedById?: string | null;
      predictionId?: string | null;
      note?: string;
      /**
       * Let this movement take the balance below zero. Reserved for
       * RESULT_CORRECTION: a payout being clawed back may already have been
       * staked on another bet, and refusing the claw-back would leave the
       * ledger asserting a payout the corrected result says never happened.
       * A deficit is the honest record of that, and the Player simply cannot
       * bet again until it is covered — the placement path reads the same
       * balance and its own guard still applies.
       *
       * Every other caller must leave this off; the overdraft guard is what
       * stops an Agent handing out more than it holds.
       */
      allowNegative?: boolean;
    },
  ) {
    if (!Number.isInteger(params.delta) || params.delta === 0) {
      throw new BadRequestException('delta must be a non-zero integer');
    }

    const wallet = params.wallet ?? LedgerWallet.MAIN;
    const isWinnings = wallet === LedgerWallet.WINNINGS;

    // Conditional update doubles as the row lock and the overdraft check:
    // if the balance moved underneath us, or would go negative, zero rows
    // match and we fail rather than writing a ledger entry that lies.
    const sufficient = params.delta < 0 && !params.allowNegative
      ? isWinnings
        ? { winningsBalance: { gte: -params.delta } }
        : { balance: { gte: -params.delta } }
      : {};

    const guarded = await tx.user.updateMany({
      where: { id: params.userId, ...sufficient },
      data: isWinnings
        ? { winningsBalance: { increment: params.delta } }
        : { balance: { increment: params.delta } },
    });

    if (guarded.count === 0) {
      const exists = await tx.user.findUnique({
        where: { id: params.userId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Account not found');
      throw new BadRequestException('Insufficient balance');
    }

    const after = await tx.user.findUniqueOrThrow({
      where: { id: params.userId },
      select: { balance: true, winningsBalance: true },
    });

    return tx.tokenLedgerEntry.create({
      data: {
        userId: params.userId,
        delta: params.delta,
        wallet,
        balanceAfter: isWinnings ? after.winningsBalance : after.balance,
        source: params.source,
        performedById: params.performedById ?? null,
        predictionId: params.predictionId ?? null,
        note: params.note,
      },
      // Explicit, and specifically excluding `seq`: it is a BigInt, several
      // callers return this row straight to the client, and JSON.stringify
      // throws on BigInt rather than degrading. `seq` exists to ORDER BY —
      // nothing outside this service needs to read it.
      select: {
        id: true,
        userId: true,
        delta: true,
        wallet: true,
        balanceAfter: true,
        source: true,
        performedById: true,
        predictionId: true,
        note: true,
        createdAt: true,
      },
    });
  }

  /**
   * Whether `requester` may **mint** tokens into `targetId` — i.e. create
   * supply out of nothing via an `ADMIN_GRANT`.
   *
   * Admin tier only (an Admin, or its own ADMIN_STAFF holding the delegated
   * permission), and only downward into that Admin's own subtree.
   *
   * **Minting stays closed to Agents even after the 2026-08-05 revision that
   * gave them token authority over their own Players** — that authority is
   * strictly the ability to hand along tokens they already hold, gated
   * separately by `assertCanTransfer`. Keeping the two gates distinct is what
   * makes "only an Admin can increase total supply" checkable rather than
   * merely intended.
   */
  private async assertCanFund(targetId: string, requester: AuthenticatedUser) {
    // Agents may move their own tokens (see transfer/assertCanTransfer) but
    // may never create any. Checked as an explicit tier gate rather than
    // relying on the emergent fact that nothing can currently grant an Agent
    // the permission: that is a property of today's role wiring, not a
    // guarantee, and this boundary must not depend on it staying true.
    if (requester.accountType === 'AGENT' || requester.accountType === 'AGENT_STAFF') {
      // Covers both directions: this gate now guards destroying supply
      // (TOKEN_SURRENDER) as well as creating it, and an Agent refused a burn
      // should not be told it cannot "create" tokens.
      throw new ForbiddenException(
        'Agents cannot create or destroy tokens — you can only transfer your own to your players',
      );
    }
    // Same reasoning as the Agent case: Platform Admin provisions Admins and
    // nothing else, and never holds any role (its `permissions` is always
    // empty) — so "Missing required permission" would misleadingly suggest a
    // role grant fixes this. It doesn't; the tier itself has no token
    // authority. See users.service.ts create() for the identical guard at
    // the other doorway (opening balance at account creation).
    if (requester.accountType === 'PLATFORM_ADMIN') {
      throw new ForbiddenException('Platform Admin has no token authority');
    }
    // Native ADMIN's token authority is intrinsic — mirrors every other
    // native-Admin capability in this codebase (see
    // UsersService.requiredPermissionToManage). Only its staff
    // (ADMIN_STAFF) needs the explicit permission, since staff have no
    // authority of their own to fall back on.
    if (
      requester.accountType !== 'ADMIN' &&
      !requester.permissions.includes(PERMISSIONS.TOKEN_ADMINISTER)
    ) {
      throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.TOKEN_ADMINISTER}`);
    }

    const ownerId = resolveScopeOwnerId(requester);
    const tier = effectiveTier(requester);

    // Nobody funds themselves — that would be minting with no counterparty
    // and no upstream account it came out of.
    if (targetId === ownerId || targetId === requester.id) {
      throw new ForbiddenException('An account cannot fund itself');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, accountType: true, createdById: true, agentId: true },
    });
    if (!target) throw new NotFoundException('Account not found');

    // Admin tier only, and only downward into its own subtree: accounts it
    // created, or Players sitting under one of its Agents.
    const inScope =
      tier === 'ADMIN' &&
      (target.createdById === ownerId ||
        (target.accountType === 'PLAYER' &&
          !!target.agentId &&
          (await this.prisma.user.count({
            where: { id: target.agentId, createdById: ownerId },
          })) > 0));

    if (!inScope) throw new NotFoundException('Account not found');
    return target;
  }

  /**
   * Opening balance applied during account creation. Runs inside the caller's
   * transaction so a funded account is never observably created without its
   * ledger entry.
   */
  async grantOpeningBalance(
    tx: Tx,
    params: { userId: string; amount: number; performedById: string },
  ) {
    if (params.amount <= 0) {
      throw new BadRequestException('Opening balance must be greater than zero');
    }
    if (params.amount > MAX_GRANT) {
      throw new BadRequestException(`Opening balance cannot exceed ${MAX_GRANT}`);
    }
    return this.applyDelta(tx, {
      userId: params.userId,
      delta: params.amount,
      source: LedgerSource.ADMIN_GRANT,
      performedById: params.performedById,
      note: 'Opening balance at account creation',
    });
  }

  /**
   * Whether `requester` may move its **own** tokens to or from `playerId`.
   *
   * Native Agent only, and only for a Player that belongs to it. Deliberately
   * separate from `assertCanFund`: that gate governs minting, this one
   * governs handing along supply that already exists. An Agent passes this
   * one and fails that one — which is the whole shape of the 2026-08-05
   * revision ("agent offers tokens to his users out of his wallet").
   *
   * AGENT_STAFF gains nothing here. Staff never get token authority anywhere
   * in this hierarchy, and an Agent's own wallet is the last place to start.
   */
  private async assertCanTransfer(playerId: string, requester: AuthenticatedUser) {
    if (requester.accountType !== 'AGENT') {
      throw new ForbiddenException('Only an Agent may transfer tokens to its own players');
    }
    if (playerId === requester.id) {
      throw new ForbiddenException('An account cannot transfer to itself');
    }

    // 404 rather than 403 for someone else's Player, matching the rest of the
    // API — existence isn't information the caller is owed.
    const player = await this.prisma.user.findFirst({
      where: { id: playerId, accountType: 'PLAYER', agentId: requester.id },
      select: { id: true, username: true },
    });
    if (!player) throw new NotFoundException('Player not found');
    return player;
  }

  /**
   * An Agent moving its own tokens to or from one of its Players.
   *
   * `delta > 0` hands tokens down (agent → player); `delta < 0` claws them
   * back (player → agent). Either way it's **two** ledger rows written in one
   * transaction — the source negative, the destination positive — so the
   * ledger continues to sum to exactly what has been minted. `applyDelta`'s
   * conditional-update guard on the negative leg is what stops an Agent
   * handing out more than it holds (or clawing back more than the Player
   * has); if it fires, the whole transaction rolls back and neither side
   * moved.
   *
   * Both legs touch the MAIN wallet only. Winnings are settlement's to write.
   */
  async transfer(
    playerId: string,
    delta: number,
    requester: AuthenticatedUser,
    note?: string,
  ) {
    const player = await this.assertCanTransfer(playerId, requester);

    if (!Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException('Amount must be a non-zero whole number');
    }
    if (Math.abs(delta) > MAX_GRANT) {
      throw new BadRequestException(`A single transfer cannot exceed ${MAX_GRANT}`);
    }

    const [fromId, toId] = delta > 0 ? [requester.id, playerId] : [playerId, requester.id];
    const amount = Math.abs(delta);
    const defaultNote =
      delta > 0 ? `Transfer to ${player.username}` : `Reclaimed from ${player.username}`;

    return this.prisma.$transaction(async (tx) => {
      // Debit first: if the source can't cover it, nothing else has happened
      // yet and the rollback is trivially clean.
      await this.applyDelta(tx, {
        userId: fromId,
        delta: -amount,
        source: LedgerSource.AGENT_TRANSFER,
        performedById: requester.id,
        note: note ?? defaultNote,
      });

      return this.applyDelta(tx, {
        userId: toId,
        delta: amount,
        source: LedgerSource.AGENT_TRANSFER,
        performedById: requester.id,
        note: note ?? defaultNote,
      });
    });
  }

  /**
   * Destroy tokens a Player has given up. The exact mirror of `grant`: where
   * that creates supply from nowhere, this removes it to nowhere.
   *
   * Admin-tier, and reuses `assertCanFund` verbatim — the gate is "may this
   * caller change total supply for this account", and the answer must not
   * depend on which direction. That also means an Agent is refused here for
   * the same reason it is refused minting, which is the property worth
   * keeping: supply moves in exactly one tier's hands.
   *
   * Drains MAIN first and falls back to WINNINGS, matching how a stake spends
   * (see prediction-service's debitAcrossWallets) so a Player's two balances
   * are always consumed in one predictable order. The overdraft guard is left
   * ON: unlike a result correction, there is nothing here that must happen
   * regardless — a Player cannot give up more than they hold.
   *
   * Not a withdrawal. Nothing is credited anywhere, no counterparty exists,
   * and no payout destination is recorded, because none exists in this
   * system. See ARCHITECTURE.md "Hard safety boundaries".
   */
  async surrender(
    tx: Tx,
    params: { userId: string; amount: number; performedById: string; note?: string },
  ) {
    if (!Number.isInteger(params.amount) || params.amount <= 0) {
      throw new BadRequestException('Surrender amount must be a positive whole number');
    }

    const holder = await tx.user.findUnique({
      where: { id: params.userId },
      select: { balance: true, winningsBalance: true },
    });
    if (!holder) throw new NotFoundException('Account not found');
    if (holder.balance + holder.winningsBalance < params.amount) {
      throw new BadRequestException('Insufficient balance');
    }

    const fromMain = Math.min(holder.balance, params.amount);
    const fromWinnings = params.amount - fromMain;
    const note = params.note ?? 'Tokens surrendered';

    // Two rows when the amount straddles both wallets: balanceAfter is
    // per-wallet, so a single row covering both would have no honest value.
    let last;
    if (fromMain > 0) {
      last = await this.applyDelta(tx, {
        userId: params.userId,
        delta: -fromMain,
        wallet: LedgerWallet.MAIN,
        source: LedgerSource.TOKEN_SURRENDER,
        performedById: params.performedById,
        note,
      });
    }
    if (fromWinnings > 0) {
      last = await this.applyDelta(tx, {
        userId: params.userId,
        delta: -fromWinnings,
        wallet: LedgerWallet.WINNINGS,
        source: LedgerSource.TOKEN_SURRENDER,
        performedById: params.performedById,
        note,
      });
    }
    return last!;
  }

  /**
   * Public wrapper around the minting gate, so other services can ask "may
   * this caller change supply for this account?" without reaching into a
   * private method or duplicating the rule.
   */
  async assertMaySetSupply(targetId: string, requester: AuthenticatedUser) {
    return this.assertCanFund(targetId, requester);
  }

  /** Ad-hoc grant to an existing in-scope account. */
  async grant(
    targetId: string,
    amount: number,
    requester: AuthenticatedUser,
    note?: string,
  ) {
    await this.assertCanFund(targetId, requester);
    if (amount <= 0) throw new BadRequestException('Grant must be greater than zero');
    if (amount > MAX_GRANT) throw new BadRequestException(`Grant cannot exceed ${MAX_GRANT}`);

    return this.prisma.$transaction((tx) =>
      this.applyDelta(tx, {
        userId: targetId,
        delta: amount,
        source: LedgerSource.ADMIN_GRANT,
        performedById: requester.id,
        note,
      }),
    );
  }

  /**
   * Ledger history visible to the caller. An Admin sees every movement in its
   * subtree, an Agent its own Players', a Player only its own — the same
   * ownership rule the rest of the API uses, applied to money-shaped rows.
   */
  async history(
    requester: AuthenticatedUser,
    limit = 100,
    filters?: {
      /** UTC calendar day, "YYYY-MM-DD". Unset shows every day. */
      date?: string;
      /** ADMIN tier only — narrow to one of the caller's own Agents. Unset
       *  shows every Agent. */
      agentId?: string;
    },
  ) {
    const ownerId = resolveScopeOwnerId(requester);
    const tier = effectiveTier(requester);

    if (filters?.date && !DATE_RE.test(filters.date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    if (filters?.agentId && !UUID_RE.test(filters.agentId)) {
      throw new BadRequestException('agentId must be a UUID');
    }

    let userFilter: Prisma.TokenLedgerEntryWhereInput;

    if (tier === 'ADMIN') {
      const agentIds = (
        await this.prisma.user.findMany({
          where: { accountType: 'AGENT', createdById: ownerId },
          select: { id: true },
        })
      ).map((a) => a.id);

      // An Admin's statement is what it moved on its Agents' own wallets —
      // the grants it made and, for visibility, the transfers those Agents
      // then made out of them. It stops there: what an Agent does with a
      // Player is that Agent's own book, not the Admin's — a Player's stake
      // and settlement rows never appear here, same as an Admin never sees
      // a Player show up in "Your agents".
      if (filters?.agentId) {
        // Checked against this Admin's own agent list first — passing a
        // foreign Admin's agent id must 404, never leak that subtree's ledger.
        if (!agentIds.includes(filters.agentId)) {
          throw new NotFoundException('Agent not found');
        }
        userFilter = { userId: filters.agentId };
      } else {
        userFilter = { userId: { in: agentIds } };
      }
    } else if (tier === 'AGENT') {
      // The Agent's own rows *and* its Players'. Its own were previously
      // excluded by the accountType filter, which left an Agent able to
      // spend a wallet it had no statement for: the ADMIN_GRANT that funded
      // it and the transfer legs it wrote were both invisible to it, even
      // though an Admin looking at the same subtree could see them.
      userFilter = {
        OR: [
          { userId: ownerId },
          { user: { accountType: 'PLAYER', agentId: ownerId } },
        ],
      };
    } else {
      userFilter = { userId: requester.id };
    }

    const where: Prisma.TokenLedgerEntryWhereInput = filters?.date
      ? { AND: [userFilter, { createdAt: utcDayRange(filters.date) }] }
      : userFilter;

    return this.prisma.tokenLedgerEntry.findMany({
      where,
      // By write order, not by clock: createdAt is transaction-start time and
      // can put rows in an order where balance_after doesn't chain. `seq` is
      // deliberately not selected below — it exists to sort by, and emitting
      // a BigInt would break JSON serialization for every consumer.
      orderBy: { seq: 'desc' },
      take: Math.min(limit, 500),
      select: {
        id: true,
        delta: true,
        wallet: true,
        balanceAfter: true,
        source: true,
        note: true,
        createdAt: true,
        user: { select: { id: true, username: true, accountType: true } },
        performedBy: { select: { id: true, username: true } },
      },
    });
  }
}
