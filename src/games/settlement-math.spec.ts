import { PredictionOutcome as O, PredictionType as T } from '@prisma/client';
import { GradedPrediction, computeSettlement, splitByShare } from './settlement-math';

/**
 * The arithmetic that decides who owes whom between an Admin and an Agent.
 * Pure, so it's testable without a database — which is also why the numbers
 * below are stated explicitly rather than derived in the test.
 */

function bet(over: Partial<GradedPrediction> = {}): GradedPrediction {
  return {
    typeId: T.OPEN_SINGLE,
    pickedNumber: '7',
    stake: 100,
    agentOddsMultiplier: 8,
    outcome: O.LOST,
    ...over,
  };
}

describe('computeSettlement — the header row (total amount played)', () => {
  it('counts every settled stake, won or lost', () => {
    const r = computeSettlement([
      bet({ stake: 100, outcome: O.LOST }),
      bet({ stake: 50, outcome: O.LOST }),
      bet({ stake: 25, pickedNumber: '3', outcome: O.WON, agentOddsMultiplier: 8 }),
    ]);
    expect(r.totalStaked).toBe(175);
  });

  it('is zero when nothing has been graded', () => {
    const r = computeSettlement([bet({ outcome: O.PENDING }), bet({ outcome: O.PENDING })]);
    expect(r.totalStaked).toBe(0);
    expect(r.totalPayout).toBe(0);
    expect(r.net).toBe(0);
    expect(r.lines).toEqual([]);
  });
});

describe('computeSettlement — PENDING is excluded from both sides', () => {
  it('ignores ungraded bets entirely, not just their payouts', () => {
    // A half-settled round: counting the pending stake while it can't yet
    // produce a payout would overstate the Admin's position until the close.
    const r = computeSettlement([
      bet({ stake: 100, outcome: O.LOST }),
      bet({ stake: 900, outcome: O.PENDING }),
    ]);
    expect(r.totalStaked).toBe(100);
    expect(r.net).toBe(100);
  });
});

describe('computeSettlement — lines, and the sign convention', () => {
  it('prices a winner at the AGENT rate, not the player rate', () => {
    // Player is paid at 9x elsewhere; what the Admin owes the Agent is 8x.
    const r = computeSettlement([
      bet({ stake: 100, pickedNumber: '7', outcome: O.WON, agentOddsMultiplier: 8 }),
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ pickedNumber: '7', stake: 100, agentOdds: 8, payout: 800 });
    expect(r.totalPayout).toBe(800);
  });

  it('nets stake against payout from the ADMIN side', () => {
    // 100 staked and lost, plus 50 staked on a winner at 8x.
    const r = computeSettlement([
      bet({ stake: 100, outcome: O.LOST }),
      bet({ stake: 50, pickedNumber: '3', outcome: O.WON, agentOddsMultiplier: 8 }),
    ]);
    expect(r.totalStaked).toBe(150);
    expect(r.totalPayout).toBe(400);
    // Admin is down 250 on the day; the Agent's position is exactly +250.
    expect(r.net).toBe(-250);
  });

  it('is positive for the Admin on a day with no winners', () => {
    const r = computeSettlement([
      bet({ stake: 100, outcome: O.LOST }),
      bet({ stake: 200, outcome: O.LOST }),
    ]);
    expect(r.net).toBe(300);
    expect(r.lines).toEqual([]);
  });

  it('emits no line for a losing number, even one with stake on it', () => {
    const r = computeSettlement([bet({ pickedNumber: '4', stake: 500, outcome: O.LOST })]);
    expect(r.lines).toEqual([]);
  });
});

describe('computeSettlement — grouping', () => {
  it('folds several players on the same number into one line', () => {
    const r = computeSettlement([
      bet({ pickedNumber: '7', stake: 100, outcome: O.WON, agentOddsMultiplier: 8 }),
      bet({ pickedNumber: '7', stake: 50, outcome: O.WON, agentOddsMultiplier: 8 }),
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ stake: 150, agentOdds: 8, payout: 1200 });
  });

  it('keeps the same number under different bet types apart', () => {
    const r = computeSettlement([
      bet({ typeId: T.OPEN_SINGLE, pickedNumber: '7', stake: 100, outcome: O.WON, agentOddsMultiplier: 8 }),
      bet({ typeId: T.CLOSE_SINGLE, pickedNumber: '7', stake: 100, outcome: O.WON, agentOddsMultiplier: 8 }),
    ]);
    expect(r.lines).toHaveLength(2);
    expect(r.totalPayout).toBe(1600);
  });

  it('sums real payouts when two bets on one number carry different agent rates', () => {
    // Legitimate when the Admin edits the Agent's card between two bets.
    // 100@8 = 800 and 100@6 = 600; the honest total is 1400, and the shown
    // rate is the blended 7x that was actually applied — not 8, not 6.
    const r = computeSettlement([
      bet({ pickedNumber: '7', stake: 100, outcome: O.WON, agentOddsMultiplier: 8 }),
      bet({ pickedNumber: '7', stake: 100, outcome: O.WON, agentOddsMultiplier: 6 }),
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].payout).toBe(1400);
    expect(r.lines[0].stake).toBe(200);
    expect(r.lines[0].agentOdds).toBe(7);
    expect(r.totalPayout).toBe(1400);
  });
});

describe('computeSettlement — idempotence across the two-pass settle', () => {
  it('produces the same result when re-run on unchanged input', () => {
    // Settlement recomputes from scratch on every result submission, so the
    // close pass must not double anything the open pass already counted.
    const rows = [
      bet({ typeId: T.OPEN_SINGLE, stake: 100, outcome: O.LOST }),
      bet({ typeId: T.OPEN_SINGLE_PANA, pickedNumber: '368', stake: 10, outcome: O.WON, agentOddsMultiplier: 130 }),
    ];
    expect(computeSettlement(rows)).toEqual(computeSettlement(rows));
  });

  it('grows correctly when the close pass grades more of the same round', () => {
    const afterOpen = computeSettlement([
      bet({ typeId: T.OPEN_SINGLE, stake: 100, outcome: O.LOST }),
      bet({ typeId: T.JODI, pickedNumber: '75', stake: 20, outcome: O.PENDING }),
    ]);
    expect(afterOpen.totalStaked).toBe(100);
    expect(afterOpen.net).toBe(100);

    const afterClose = computeSettlement([
      bet({ typeId: T.OPEN_SINGLE, stake: 100, outcome: O.LOST }),
      bet({ typeId: T.JODI, pickedNumber: '75', stake: 20, outcome: O.WON, agentOddsMultiplier: 80 }),
    ]);
    // The open stake is counted once, not twice, and the jodi now settles.
    expect(afterClose.totalStaked).toBe(120);
    expect(afterClose.totalPayout).toBe(1600);
    expect(afterClose.net).toBe(-1480);
  });
});

describe('splitByShare: a win is a loss for both tiers', () => {
  it('with the default 9:1 split, the Agent bears a tenth of a loss and the Admin the rest', () => {
    // players won 1 990 more than was staked: net -1 990 from the Admin's side
    expect(splitByShare(-1990, 1)).toEqual({ adminSlice: -1791, agentSlice: -199 });
  });

  it('is the 20% cut example: a 100 bet that wins at 9x costs the Admin 80 x 9', () => {
    // whole position: 100 staked, 900 owed at the rate between the two tiers
    const net = 100 - 100 * 9;
    expect(splitByShare(net, 2)).toEqual({ adminSlice: -640, agentSlice: -160 });
    // the Admin: keeps 80 of the stake and pays 80 x 9 = 720, so -640
    expect(80 - 80 * 9).toBe(-640);
  });

  it('shares a profit the same way', () => {
    expect(splitByShare(1000, 1)).toEqual({ adminSlice: 900, agentSlice: 100 });
  });

  it('gives the old behaviour at a share of 0: the Admin carries everything', () => {
    expect(splitByShare(-1990, 0)).toEqual({ adminSlice: -1990, agentSlice: 0 });
  });

  it('always adds back up to the whole position, whatever the rounding', () => {
    for (const net of [-1999, -1001, -5, -1, 0, 1, 5, 1001, 1999]) {
      for (let share = 0; share <= 10; share++) {
        const { adminSlice, agentSlice } = splitByShare(net, share);
        expect(adminSlice + agentSlice).toBe(net);
      }
    }
  });

  it('rounds half away from zero, the same for a loss as for a profit', () => {
    expect(splitByShare(5, 1)).toEqual({ adminSlice: 5, agentSlice: 0 }); // 4.5 -> 5
    expect(splitByShare(-5, 1)).toEqual({ adminSlice: -5, agentSlice: 0 }); // -4.5 -> -5
  });

  it('clamps a share outside 0..10 and ignores junk', () => {
    expect(splitByShare(100, 25)).toEqual({ adminSlice: 0, agentSlice: 100 });
    expect(splitByShare(100, -3)).toEqual({ adminSlice: 100, agentSlice: 0 });
    expect(splitByShare(100, Number.NaN)).toEqual({ adminSlice: 100, agentSlice: 0 });
  });
});
