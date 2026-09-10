import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BetType, Prisma, RateKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PERMISSIONS } from '../rbac/permissions.constants';
import { effectiveTier, isStaff, resolveScopeOwnerId } from '../rbac/scope.util';
import { BET_TYPES, DEFAULT_RATES } from './rates.constants';
import { RateEntryDto } from './dto/update-rates.dto';

type Tx = Prisma.TransactionClient;

@Injectable()
export class RatesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------
  // Seeding — called from account creation, inside that same transaction
  // ---------------------------------------------------------------------

  /** A new Admin starts from the house default card. */
  async seedAdminDefaultCard(tx: Tx, adminId: string) {
    await tx.rate.createMany({
      data: BET_TYPES.map((betType) => ({
        ownerId: adminId,
        kind: RateKind.DEFAULT,
        betType,
        multiplier: DEFAULT_RATES[betType],
      })),
    });
  }

  /**
   * A new Agent inherits its Admin's DEFAULT card as GIVEN, and starts out
   * passing exactly that on (GIVING seeded equal to GIVEN). Copied by value
   * rather than referenced: a later edit to the Admin's default is a change
   * to the template for *future* Agents, not a silent repricing of every
   * Agent already operating under agreed terms.
   *
   * `overrides`, when given, replaces the inherited template outright — the
   * caller has explicitly priced every bet type for this Agent rather than
   * accepting the Admin's default wholesale. Caller (UsersService) is
   * responsible for having already checked it's a complete set.
   */
  async seedAgentCardsFrom(
    tx: Tx,
    agentId: string,
    adminId: string,
    overrides?: RateEntryDto[],
  ) {
    let source: { betType: BetType; multiplier: number }[];
    if (overrides) {
      source = overrides.map(({ betType, multiplier }) => ({ betType, multiplier }));
    } else {
      const template = await tx.rate.findMany({
        where: { ownerId: adminId, kind: RateKind.DEFAULT },
      });

      // An Admin created before rate cards existed has no template; fall
      // back to the house defaults so an Agent is never left without a card.
      source = template.length
        ? template.map((rate) => ({ betType: rate.betType, multiplier: rate.multiplier }))
        : BET_TYPES.map((betType) => ({ betType, multiplier: DEFAULT_RATES[betType] }));
    }

    await tx.rate.createMany({
      data: source.flatMap(({ betType, multiplier }) => [
        { ownerId: agentId, kind: RateKind.GIVEN, betType, multiplier },
        { ownerId: agentId, kind: RateKind.GIVING, betType, multiplier },
      ]),
    });
  }

  /**
   * A Player's own override card — priced explicitly by its Agent at
   * creation, rather than riding the Agent's GIVING card live. Optional:
   * called only when the Agent supplied one.
   *
   * **Revision 2026-08-05 (explicit sign-off): no longer capped by the
   * Agent's GIVING card**, for the same reason `updateGivingCard` isn't
   * capped by GIVEN — an Agent may price a Player better than its own
   * standard rate and carry the difference itself. See that method for the
   * full reasoning.
   */
  async seedPlayerCardFrom(tx: Tx, playerId: string, agentId: string, overrides: RateEntryDto[]) {

    await tx.rate.createMany({
      data: overrides.map(({ betType, multiplier }) => ({
        ownerId: playerId,
        kind: RateKind.PLAYING,
        betType,
        multiplier,
      })),
    });
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  private cardFor(ownerId: string, kind: RateKind) {
    return this.prisma.rate.findMany({
      where: { ownerId, kind },
      orderBy: { betType: 'asc' },
      select: { betType: true, multiplier: true, updatedAt: true },
    });
  }

  /**
   * The cards the caller is entitled to see, shaped by tier:
   * - Admin: its own DEFAULT template.
   * - Agent: GIVEN (read-only, set by its Admin) and GIVING (its own).
   * - Player: its own PLAYING override if its Agent set one at creation,
   *   otherwise the GIVING card of the Agent it sits under, read live — the
   *   rates it actually plays at either way. A Player never sees anything
   *   upstream of that.
   * - Platform Admin: nothing. It has no rate authority anywhere.
   */
  async myCards(requester: AuthenticatedUser) {
    const ownerId = resolveScopeOwnerId(requester);

    switch (effectiveTier(requester)) {
      case 'ADMIN':
        return { kind: 'ADMIN' as const, default: await this.cardFor(ownerId, RateKind.DEFAULT) };

      case 'AGENT':
        return {
          kind: 'AGENT' as const,
          given: await this.cardFor(ownerId, RateKind.GIVEN),
          giving: await this.cardFor(ownerId, RateKind.GIVING),
        };

      case 'PLAYER': {
        if (!requester.agentId) return { kind: 'PLAYER' as const, playing: [] };
        const own = await this.cardFor(ownerId, RateKind.PLAYING);
        return {
          kind: 'PLAYER' as const,
          playing: own.length ? own : await this.cardFor(requester.agentId, RateKind.GIVING),
        };
      }

      default:
        throw new ForbiddenException('This account tier has no rate card');
    }
  }

  /**
   * An Admin inspecting one of its own Agents' cards. Read-only on purpose:
   * an Admin sets what an Agent is GIVEN at creation, but the Agent's GIVING
   * card is the Agent's own decision within that cap.
   */
  async agentCards(agentId: string, requester: AuthenticatedUser) {
    if (effectiveTier(requester) !== 'ADMIN') {
      throw new ForbiddenException('Only an Admin may inspect an Agent rate card');
    }
    const ownerId = resolveScopeOwnerId(requester);

    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, accountType: 'AGENT', createdById: ownerId },
      select: { id: true, username: true, agentShare: true },
    });
    // 404 rather than 403 for an Agent outside this Admin's subtree, matching
    // the rest of the API — existence isn't information the caller is owed.
    if (!agent) throw new NotFoundException('Agent not found');

    return {
      agent,
      given: await this.cardFor(agentId, RateKind.GIVEN),
      giving: await this.cardFor(agentId, RateKind.GIVING),
    };
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  private assertCanEditRates(requester: AuthenticatedUser) {
    if (!requester.permissions.includes(PERMISSIONS.RATE_MANAGE)) {
      throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.RATE_MANAGE}`);
    }
  }

  /**
   * A native Admin's or Agent's authority over its own rate card is
   * intrinsic to the tier, not granted: nothing in this system assigns
   * roles to either native tier, the same way a native Agent moderating its
   * own Players needs no grant (see UsersService.requiredPermissionToManage
   * for the same split applied to account management). The permission
   * exists so a tier can delegate this to its own staff — so it is
   * required of ADMIN_STAFF/AGENT_STAFF and only of them.
   */
  private assertCanEditOwnCard(requester: AuthenticatedUser) {
    if (isStaff(requester)) this.assertCanEditRates(requester);
  }

  private async upsertCard(ownerId: string, kind: RateKind, entries: RateEntryDto[]) {
    // One transaction so a rejected row can't leave half a card applied.
    await this.prisma.$transaction(
      entries.map((entry) =>
        this.prisma.rate.upsert({
          where: { ownerId_kind_betType: { ownerId, kind, betType: entry.betType } },
          update: { multiplier: entry.multiplier },
          create: { ownerId, kind, betType: entry.betType, multiplier: entry.multiplier },
        }),
      ),
    );
    return this.cardFor(ownerId, kind);
  }

  /** An Admin's template for Agents it creates from here on. */
  async updateDefaultCard(entries: RateEntryDto[], requester: AuthenticatedUser) {
    if (effectiveTier(requester) !== 'ADMIN') {
      throw new ForbiddenException('Only an Admin has a default rate card');
    }
    this.assertCanEditOwnCard(requester);
    return this.upsertCard(resolveScopeOwnerId(requester), RateKind.DEFAULT, entries);
  }

  /**
   * An Agent's GIVING card — what its Players actually play at.
   *
   * **Revision 2026-08-05 (explicit sign-off): no longer capped by GIVEN.**
   * This previously rejected any rate above what the Agent was given, on the
   * grounds that paying out more than you received breaks the profit split.
   * That was wrong about the domain: an Agent deliberately offering a better
   * rate than it receives — and absorbing the difference itself on a win —
   * is the normal way an Agent competes for players. In the user's words:
   * "agent can give whatever he wants... the market rate is 9x agent gives
   * me so my hundred becomes 900 where the admin only gives 8x to agent so
   * agent has to add 1x to the winning of the player."
   *
   * The difference is not lost, it's the Agent's own liability — which is
   * exactly why `Prediction.agentOddsMultiplier` now records the admin-side
   * rate alongside the player-side one, so that per-tier split stays
   * computable at settlement time.
   */
  async updateGivingCard(entries: RateEntryDto[], requester: AuthenticatedUser) {
    if (effectiveTier(requester) !== 'AGENT') {
      throw new ForbiddenException('Only an Agent has a giving rate card');
    }
    this.assertCanEditOwnCard(requester);
    return this.upsertCard(resolveScopeOwnerId(requester), RateKind.GIVING, entries);
  }
}
