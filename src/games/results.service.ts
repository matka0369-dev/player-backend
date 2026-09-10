import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerSource, LedgerWallet, PredictionOutcome, PredictionType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { SubmitResultDto } from './dto/submit-result.dto';
import { CorrectResultDto } from './dto/correct-result.dto';
import {
  CLOSE_SETTLED_TYPES,
  DerivedResult,
  OPEN_SETTLED_TYPES,
  derive,
  isValidPana,
  isWinner,
} from './result-derivation';
import { GradedPrediction, computeSettlement } from './settlement-math';

type Tx = Prisma.TransactionClient;

/**
 * Ceiling for any single payout, and for the per-agent totals derived from
 * them: `predictions.payout`, `settlements.total_payout` and
 * `settlement_lines.payout` are all int4. Exceeding it aborts the settlement
 * transaction, and since a published side cannot be re-submitted, the round
 * is then stuck for everyone who bet on it. prediction-service applies the
 * same bound at placement so this is a backstop, not the primary defence.
 */
export const MAX_PAYOUT = 2_147_483_647;

export interface SettlementSummary {
  gameId: string;
  date: string;
  openPana: string | null;
  closePana: string | null;
  openSingle: number | null;
  closeSingle: number | null;
  /** Which side this call settled — null when it only recorded a pana. */
  settledSide: 'OPEN' | 'CLOSE' | null;
  settledCount: number;
  wonCount: number;
  lostCount: number;
  totalPaidOut: number;
  /** How many Admin<->Agent settlement rows this write produced or refreshed. */
  agentsSettled: number;
}

/**
 * What a correction undid and what it then decided. Carries the reversal
 * figures alongside the ordinary settlement ones, because "48 bets re-graded"
 * is only half the story an operator needs — the other half is how many
 * tokens were taken back and whether that left anyone short.
 */
export interface CorrectionSummary extends Omit<SettlementSummary, 'settledSide'> {
  previousOpenPana: string | null;
  previousClosePana: string | null;
  /** Predictions returned to PENDING before re-grading. */
  predictionsReset: number;
  /** Tokens clawed back out of WINNINGS. */
  payoutsReversed: number;
  /** Accounts the claw-back pushed below zero — expected, not an error. */
  accountsLeftNegative: number;
}

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  /**
   * Record a day's result for a game and settle everything it makes
   * decidable, in one transaction.
   *
   * Entering the open pana settles the open-side types immediately; the
   * close pana settles the rest, including Jodi and both Sangams, which
   * need a value from each side (see result-derivation for why settlement
   * grouping differs from cutoff grouping).
   *
   * Both panas may be submitted in one call, in which case both sides settle
   * — the close leg runs against the same derived result, so a Jodi is
   * graded against the open single that was just recorded rather than a
   * re-read that could disagree.
   *
   * **Idempotent by refusal, not by replay:** a side that already has a pana
   * recorded is rejected rather than re-settled. Re-running settlement would
   * pay winners twice, and silently ignoring a second submission would hide
   * a typo'd correction. Correcting a published result is deliberately not
   * supported here — it needs reversal entries, which is its own feature.
   */
  async submitResult(gameId: string, dto: SubmitResultDto): Promise<SettlementSummary> {
    if (!dto.openPana && !dto.closePana) {
      throw new BadRequestException('Provide at least one of openPana or closePana');
    }
    for (const [label, pana] of [['openPana', dto.openPana], ['closePana', dto.closePana]] as const) {
      if (pana && !isValidPana(pana)) {
        throw new BadRequestException(
          `${label} must be non-decreasing, where 0 counts as ten (e.g. 368 or 100, not 012)`,
        );
      }
    }

    const date = new Date(`${dto.date}T00:00:00.000Z`);

    return this.prisma.$transaction(async (tx) => {
      const round = await tx.round.findFirst({
        where: { gameId, date },
        select: { id: true, openPana: true, closePana: true, status: true, opensAt: true, closesAt: true },
      });
      if (!round) {
        throw new NotFoundException('No round exists for that game on that date');
      }
      if (round.status === 'CANCELLED') {
        throw new BadRequestException('That round was cancelled — nothing to settle');
      }

      // A result may only be filed once its own betting window has shut.
      // Publishing early — including for a round that hasn't happened yet —
      // used to settle everything placed so far while leaving the window
      // open, and every bet arriving after that was debited and then never
      // graded (settlement runs only from here, and a second submission is
      // refused as a duplicate). The placement path now refuses those bets
      // too; this is the other half, stopping the situation from arising.
      const now = new Date();
      if (dto.openPana && now < round.opensAt) {
        throw new BadRequestException(
          `The open window for this round has not closed yet (opens at ${round.opensAt.toISOString()})`,
        );
      }
      if (dto.closePana && now < round.closesAt) {
        throw new BadRequestException(
          `The close window for this round has not closed yet (closes at ${round.closesAt.toISOString()})`,
        );
      }

      if (dto.openPana && round.openPana) {
        throw new ConflictException(`Open result already recorded as ${round.openPana}`);
      }
      if (dto.closePana && round.closePana) {
        throw new ConflictException(`Close result already recorded as ${round.closePana}`);
      }
      // A close result is meaningless without the open one: the Jodi and both
      // Sangams are built from a value on each side, so accepting close-first
      // would settle them against an open single that doesn't exist yet.
      if (dto.closePana && !round.openPana && !dto.openPana) {
        throw new BadRequestException('Record the open result before the close result');
      }

      const openPana = dto.openPana ?? round.openPana;
      const closePana = dto.closePana ?? round.closePana;
      const result = derive(openPana!, closePana);

      await tx.round.update({
        where: { id: round.id },
        data: {
          ...(dto.openPana ? { openPana: dto.openPana } : {}),
          ...(dto.closePana ? { closePana: dto.closePana } : {}),
          // Descriptive only — the cutoff trigger reads CANCELLED and
          // nothing else, so this is for humans reading the row.
          status: closePana ? 'RESULT_PUBLISHED' : 'CLOSED',
        },
      });

      let settledCount = 0;
      let wonCount = 0;
      let lostCount = 0;
      let totalPaidOut = 0;
      let settledSide: 'OPEN' | 'CLOSE' | null = null;

      if (dto.openPana) {
        const r = await this.settleTypes(tx, round.id, OPEN_SETTLED_TYPES, result);
        settledCount += r.settled;
        wonCount += r.won;
        lostCount += r.lost;
        totalPaidOut += r.paidOut;
        settledSide = 'OPEN';
      }
      if (dto.closePana) {
        const r = await this.settleTypes(tx, round.id, CLOSE_SETTLED_TYPES, result);
        settledCount += r.settled;
        wonCount += r.won;
        lostCount += r.lost;
        totalPaidOut += r.paidOut;
        settledSide = 'CLOSE';
      }

      // Same transaction as the grading above, so a settlement row can never
      // describe a set of predictions that didn't actually commit.
      const agentsSettled = await this.writeSettlements(tx, {
        roundId: round.id,
        gameId,
        date,
        openPana: openPana ?? null,
        closePana,
      });

      return {
        gameId,
        date: dto.date,
        openPana: openPana ?? null,
        closePana: closePana ?? null,
        openSingle: result.openSingle,
        closeSingle: result.closeSingle,
        settledSide,
        settledCount,
        wonCount,
        lostCount,
        totalPaidOut,
        agentsSettled,
      };
    });
  }

  /**
   * Replace a published result with a different one, undoing everything the
   * wrong one caused and then grading the round again from scratch.
   *
   * The undo is a reversal, never an edit or a delete. Each payout the wrong
   * result created gets a compensating `RESULT_CORRECTION` row, so the ledger
   * still reads "paid, then clawed back" rather than quietly losing the fact
   * that a payout ever existed. Predictions go back to `PENDING` and the
   * Admin<->Agent settlement is dropped, because both are pure derivations of
   * the result and are cheaper to rebuild than to reconcile.
   *
   * **A claw-back may leave a Player negative, and that is allowed.** Winnings
   * from a wrong result are spendable the moment they land, so by the time an
   * operator notices, some of them may already be staked on another round.
   * Refusing the claw-back in that case would leave the system asserting a
   * payout the corrected result says never happened; a deficit is the honest
   * record instead. Those Players simply cannot bet again until it is covered
   * — the placement path reads the same balance and its own guard still holds.
   *
   * Everything runs in one transaction: a half-corrected round, with some
   * winners un-paid and others not, would be worse than either result.
   */
  async correctResult(
    gameId: string,
    dto: CorrectResultDto,
    requester: AuthenticatedUser,
  ): Promise<CorrectionSummary> {
    if (!dto.openPana && !dto.closePana) {
      throw new BadRequestException('Provide the corrected openPana, closePana, or both');
    }
    for (const [label, pana] of [['openPana', dto.openPana], ['closePana', dto.closePana]] as const) {
      if (pana && !isValidPana(pana)) {
        throw new BadRequestException(
          `${label} must be non-decreasing, where 0 counts as ten (e.g. 368 or 100, not 012)`,
        );
      }
    }

    const date = new Date(`${dto.date}T00:00:00.000Z`);

    return this.prisma.$transaction(async (tx) => {
      const round = await tx.round.findFirst({
        where: { gameId, date },
        select: { id: true, openPana: true, closePana: true, status: true },
      });
      if (!round) throw new NotFoundException('No round exists for that game on that date');
      if (round.status === 'CANCELLED') {
        throw new BadRequestException('That round was cancelled — nothing to correct');
      }
      // Correcting presupposes something to correct. Routing a first-time
      // entry through here would run the whole reversal against nothing and
      // bypass the window guard that submitResult applies.
      if (!round.openPana && !round.closePana) {
        throw new BadRequestException(
          'This round has no result yet — submit it with POST /games/:id/result instead',
        );
      }

      const newOpen = dto.openPana ?? round.openPana;
      const newClose = dto.closePana ?? round.closePana;
      if (newOpen === round.openPana && newClose === round.closePana) {
        throw new BadRequestException(
          'The corrected result is identical to the recorded one — nothing to change',
        );
      }
      // Same rule as submitResult: the Jodi and both Sangams are built from a
      // value on each side, so a close result with no open one cannot grade.
      if (newClose && !newOpen) {
        throw new BadRequestException('Cannot leave a close result without an open result');
      }

      // ---- 1. undo everything the previous result decided ----
      const settled = await tx.prediction.findMany({
        where: { roundId: round.id, outcome: { not: PredictionOutcome.PENDING } },
        select: { id: true, userId: true, typeId: true, pickedNumber: true, outcome: true, payout: true },
      });

      let payoutsReversed = 0;
      const touchedUserIds = new Set<string>();

      for (const p of settled) {
        if (p.outcome === PredictionOutcome.WON && p.payout && p.payout > 0) {
          await this.ledgerService.applyDelta(tx, {
            userId: p.userId,
            delta: -p.payout,
            wallet: LedgerWallet.WINNINGS,
            source: LedgerSource.RESULT_CORRECTION,
            performedById: requester.id,
            predictionId: p.id,
            note: `Reversed ${p.typeId} ${p.pickedNumber} payout after result correction`,
            // The whole point of this path — see the method doc.
            allowNegative: true,
          });
          payoutsReversed += p.payout;
          touchedUserIds.add(p.userId);
        }
      }

      await tx.prediction.updateMany({
        where: { roundId: round.id },
        data: { outcome: PredictionOutcome.PENDING, payout: null },
      });

      // Counted after the reversal and before the re-grade, so it reports the
      // real low-water mark rather than what the new result happens to repay.
      const accountsLeftNegative = touchedUserIds.size
        ? await tx.user.count({
            where: { id: { in: [...touchedUserIds] }, winningsBalance: { lt: 0 } },
          })
        : 0;

      // Derived entirely from the predictions above; rebuilt below.
      await tx.settlement.deleteMany({ where: { roundId: round.id } });

      // ---- 2. record that this happened, before recomputation hides it ----
      await tx.resultCorrection.create({
        data: {
          roundId: round.id,
          previousOpenPana: round.openPana,
          previousClosePana: round.closePana,
          newOpenPana: newOpen,
          newClosePana: newClose,
          predictionsReset: settled.length,
          payoutsReversed,
          accountsLeftNegative,
          performedById: requester.id,
          reason: dto.reason,
        },
      });

      // ---- 3. grade the round again, as if entered correctly first time ----
      await tx.round.update({
        where: { id: round.id },
        data: {
          openPana: newOpen,
          closePana: newClose,
          status: newClose ? 'RESULT_PUBLISHED' : 'CLOSED',
        },
      });

      const result = derive(newOpen!, newClose);
      let settledCount = 0;
      let wonCount = 0;
      let lostCount = 0;
      let totalPaidOut = 0;

      if (newOpen) {
        const r = await this.settleTypes(tx, round.id, OPEN_SETTLED_TYPES, result);
        settledCount += r.settled; wonCount += r.won; lostCount += r.lost; totalPaidOut += r.paidOut;
      }
      if (newClose) {
        const r = await this.settleTypes(tx, round.id, CLOSE_SETTLED_TYPES, result);
        settledCount += r.settled; wonCount += r.won; lostCount += r.lost; totalPaidOut += r.paidOut;
      }

      const agentsSettled = await this.writeSettlements(tx, {
        roundId: round.id,
        gameId,
        date,
        openPana: newOpen ?? null,
        closePana: newClose ?? null,
      });

      return {
        gameId,
        date: dto.date,
        previousOpenPana: round.openPana,
        previousClosePana: round.closePana,
        openPana: newOpen ?? null,
        closePana: newClose ?? null,
        openSingle: result.openSingle,
        closeSingle: result.closeSingle,
        predictionsReset: settled.length,
        payoutsReversed,
        accountsLeftNegative,
        settledCount,
        wonCount,
        lostCount,
        totalPaidOut,
        agentsSettled,
      };
    });
  }

  /** Correction history for a game, newest first. */
  async correctionsForGame(gameId: string) {
    const rows = await this.prisma.resultCorrection.findMany({
      where: { round: { gameId } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        previousOpenPana: true,
        previousClosePana: true,
        newOpenPana: true,
        newClosePana: true,
        predictionsReset: true,
        payoutsReversed: true,
        accountsLeftNegative: true,
        reason: true,
        createdAt: true,
        round: { select: { date: true } },
        performedBy: { select: { id: true, username: true } },
      },
    });
    return rows.map((r) => ({ ...r, date: r.round.date.toISOString().slice(0, 10), round: undefined }));
  }

  /**
   * Recompute and persist the Admin<->Agent position for every Agent with
   * predictions on this round.
   *
   * **Recompute-and-upsert, not append.** A game settles in two passes (open,
   * then close); the second must produce a corrected total rather than a
   * second partial row. Rebuilding from all graded predictions each time
   * makes the write idempotent — running it twice with no new results in
   * between changes nothing.
   *
   * Lines are deleted and rewritten rather than diffed: they're a derived
   * projection of the predictions, cheap to regenerate, and diffing would be
   * a second place for the arithmetic to be subtly wrong.
   */
  private async writeSettlements(
    tx: Tx,
    ctx: {
      roundId: string;
      gameId: string;
      date: Date;
      openPana: string | null;
      closePana: string | null;
    },
  ): Promise<number> {
    const graded = await tx.prediction.findMany({
      where: { roundId: ctx.roundId },
      select: {
        typeId: true,
        pickedNumber: true,
        stake: true,
        agentOddsMultiplier: true,
        outcome: true,
        user: { select: { agentId: true } },
      },
    });

    // Group by the Agent that owns the Player. A Player always has one (only
    // an Agent can create one), but the column is nullable schema-wide, so
    // rows without one are skipped rather than bucketed under a fake key.
    const byAgent = new Map<string, GradedPrediction[]>();
    for (const p of graded) {
      const agentId = p.user.agentId;
      if (!agentId) continue;
      const bucket = byAgent.get(agentId);
      if (bucket) bucket.push(p);
      else byAgent.set(agentId, [p]);
    }

    if (byAgent.size === 0) return 0;

    // Each Agent settles against the Admin that created it.
    const agents = await tx.user.findMany({
      where: { id: { in: [...byAgent.keys()] } },
      select: { id: true, createdById: true },
    });
    const adminOf = new Map(agents.map((a) => [a.id, a.createdById]));

    let written = 0;
    for (const [agentId, predictions] of byAgent) {
      const adminId = adminOf.get(agentId);
      // An Agent with no creator can't have a counterparty — nothing
      // meaningful to record, and inventing one would be worse than skipping.
      if (!adminId) continue;

      const draft = computeSettlement(predictions);

      // Independent of the per-prediction check: enough individually-legal
      // winners on one round can still sum past int4. Same failure mode, so
      // same explicit error rather than a raw overflow from the driver.
      if (draft.totalPayout > MAX_PAYOUT || draft.totalStaked > MAX_PAYOUT) {
        throw new BadRequestException(
          `Settlement for agent ${agentId} totals ${draft.totalPayout} paid on ${draft.totalStaked} staked, ` +
            `above the ${MAX_PAYOUT} limit these columns can hold.`,
        );
      }

      const settlement = await tx.settlement.upsert({
        where: { roundId_agentId: { roundId: ctx.roundId, agentId } },
        create: {
          roundId: ctx.roundId,
          gameId: ctx.gameId,
          date: ctx.date,
          agentId,
          adminId,
          openPana: ctx.openPana,
          closePana: ctx.closePana,
          totalStaked: draft.totalStaked,
          totalPayout: draft.totalPayout,
          net: draft.net,
        },
        update: {
          openPana: ctx.openPana,
          closePana: ctx.closePana,
          totalStaked: draft.totalStaked,
          totalPayout: draft.totalPayout,
          net: draft.net,
        },
        select: { id: true },
      });

      await tx.settlementLine.deleteMany({ where: { settlementId: settlement.id } });
      if (draft.lines.length > 0) {
        await tx.settlementLine.createMany({
          data: draft.lines.map((l) => ({ settlementId: settlement.id, ...l })),
        });
      }
      written++;
    }

    return written;
  }

  /**
   * Grade every still-PENDING prediction of the given types against the
   * derived result, paying winners into their WINNINGS wallet.
   *
   * Scoped to PENDING so a re-entrant call can't double-pay a row that a
   * previous side already settled — belt to the submitResult braces above.
   *
   * A winner is paid `stake × oddsMultiplier`, the Player-side rate frozen
   * at placement. `agentOddsMultiplier` (the admin→agent rate) is recorded
   * on the row but deliberately unused here: who *funds* the payout is a
   * later iteration, per the user's "we are not worried about who pays what
   * not yet". Today the credit is created rather than moved, which is the
   * one place this system knowingly departs from conservation — flagged in
   * ARCHITECTURE.md so it isn't mistaken for an accident.
   */
  private async settleTypes(
    tx: Tx,
    roundId: string,
    types: PredictionType[],
    result: DerivedResult,
  ) {
    const pending = await tx.prediction.findMany({
      where: { roundId, typeId: { in: types }, outcome: PredictionOutcome.PENDING },
      select: { id: true, userId: true, typeId: true, pickedNumber: true, stake: true, oddsMultiplier: true },
    });

    let won = 0;
    let lost = 0;
    let paidOut = 0;

    for (const p of pending) {
      if (isWinner(p.typeId, p.pickedNumber, result)) {
        const payout = p.stake * p.oddsMultiplier;
        // payout is int4. Overflowing it throws deep inside the transaction
        // as a raw Postgres error, which surfaces as a 500 and — because the
        // rollback undoes the pana write too — leaves the round permanently
        // unsettleable, taking every other bet on it down as well. Placement
        // rejects these stakes now, so reaching this means a bet predating
        // that guard: fail with something an operator can act on.
        if (payout > MAX_PAYOUT) {
          throw new BadRequestException(
            `Prediction ${p.id} (${p.typeId} ${p.pickedNumber}, ${p.stake} at ${p.oddsMultiplier}x) ` +
              `would pay ${payout}, above the ${MAX_PAYOUT} the payout column can hold. ` +
              `Settle this round only after voiding or repricing that bet.`,
          );
        }
        await tx.prediction.update({
          where: { id: p.id },
          data: { outcome: PredictionOutcome.WON, payout },
        });
        await this.ledgerService.applyDelta(tx, {
          userId: p.userId,
          delta: payout,
          wallet: LedgerWallet.WINNINGS,
          source: LedgerSource.PREDICTION_PAYOUT,
          predictionId: p.id,
          note: `Won ${p.typeId} on ${p.pickedNumber} at ${p.oddsMultiplier}x`,
        });
        won++;
        paidOut += payout;
      } else {
        await tx.prediction.update({
          where: { id: p.id },
          // payout stays null on a loss — 0 would read as "paid nothing"
          // rather than "never paid", and the stake already left at
          // placement, so there is no second movement to record.
          data: { outcome: PredictionOutcome.LOST },
        });
        lost++;
      }
    }

    return { settled: pending.length, won, lost, paidOut };
  }
}
