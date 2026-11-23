import { PredictionOutcome, PredictionType } from '@prisma/client';

/**
 * The Admin <-> Agent position for one game on one day, derived from that
 * day's graded predictions.
 *
 * Pure — no Prisma, no clock, no I/O — because it decides who owes whom, and
 * that arithmetic deserves to be checkable without a database. The service
 * layer feeds it rows and persists what comes back.
 *
 * Two kinds of row, per the domain:
 *
 *   header — "total amount played": every token this Agent's Players staked
 *            on this game/date. Positive for the Admin, negative for Agent.
 *   line   — one per winning number: `stake × agentOdds`, i.e. what the Admin
 *            owes at the rate it gives *this* Agent. Negative for the Admin.
 *
 * **Signs are expressed once, from the Admin's perspective.** The Agent's
 * position is the exact negation — the two sides operate at one rate against
 * each other — so nothing here stores both.
 */

/** The subset of a graded Prediction this computation needs. */
export interface GradedPrediction {
  typeId: PredictionType;
  pickedNumber: string;
  stake: number;
  /** The admin→agent rate frozen at placement, NOT the player-facing one. */
  agentOddsMultiplier: number;
  outcome: PredictionOutcome;
}

export interface SettlementLineDraft {
  typeId: PredictionType;
  pickedNumber: string;
  stake: number;
  agentOdds: number;
  payout: number;
}

export interface SettlementDraft {
  totalStaked: number;
  totalPayout: number;
  /** totalStaked − totalPayout, from the Admin's side. */
  net: number;
  lines: SettlementLineDraft[];
}

/**
 * Build the position from every prediction of one Agent's Players on one
 * round.
 *
 * `PENDING` rows are **excluded from both sides**: a bet that hasn't been
 * graded is not yet a debt in either direction, and counting its stake while
 * ignoring its possible payout would overstate the Admin's position for as
 * long as the round is half-settled. Since this recomputes from scratch on
 * every result submission, the second pass naturally picks them up.
 *
 * Winners are grouped by (typeId, pickedNumber) so several Players backing
 * the same number produce one line, matching how the dashboard reads.
 * Grouping also folds in differing `agentOddsMultiplier` values correctly by
 * summing actual payouts rather than multiplying a summed stake by one rate
 * — two Players can legitimately hold different agent rates if the Admin
 * changed the card between their bets.
 */
export function computeSettlement(predictions: GradedPrediction[]): SettlementDraft {
  const settled = predictions.filter((p) => p.outcome !== PredictionOutcome.PENDING);

  const totalStaked = settled.reduce((sum, p) => sum + p.stake, 0);

  const byNumber = new Map<string, SettlementLineDraft>();
  for (const p of settled) {
    if (p.outcome !== PredictionOutcome.WON) continue;

    const key = `${p.typeId}|${p.pickedNumber}`;
    const payout = p.stake * p.agentOddsMultiplier;
    const existing = byNumber.get(key);

    if (existing) {
      existing.stake += p.stake;
      existing.payout += payout;
      // Displayed rate stays the one actually applied when they agree, and
      // becomes the blended effective rate when they don't — never a number
      // that was applied to nothing.
      existing.agentOdds =
        existing.stake === 0 ? p.agentOddsMultiplier : Math.round(existing.payout / existing.stake);
    } else {
      byNumber.set(key, {
        typeId: p.typeId,
        pickedNumber: p.pickedNumber,
        stake: p.stake,
        agentOdds: p.agentOddsMultiplier,
        payout,
      });
    }
  }

  const lines = [...byNumber.values()].sort(
    (a, b) => a.typeId.localeCompare(b.typeId) || a.pickedNumber.localeCompare(b.pickedNumber),
  );
  const totalPayout = lines.reduce((sum, l) => sum + l.payout, 0);

  return { totalStaked, totalPayout, net: totalStaked - totalPayout, lines };
}
