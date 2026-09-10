import { PredictionType } from '@prisma/client';

/**
 * Everything a day's result implies, derived from the two panas a Platform
 * Admin actually types. Nothing else is entered by hand — a jodi or a sangam
 * that disagreed with its own open/close panas would be unresolvable, so they
 * are computed rather than captured.
 *
 * Pure functions, no Prisma, no I/O: this is the part worth being able to
 * reason about (and later test) in isolation from the settlement writes that
 * consume it.
 */

/**
 * The "single" (ank) for a pana: its digits summed, mod 10. `368` → 17 → 7.
 *
 * Note this is a plain digit sum — unlike pana *ordering*, where '0' sorts as
 * if it were 10 (see isValidPana), here '0' contributes 0. The two rules look
 * similar and are not the same one; conflating them silently shifts every
 * single/jodi/sangam result involving a zero.
 */
export function singleFromPana(pana: string): number {
  return ([...pana].reduce((sum, d) => sum + Number(d), 0)) % 10;
}

/** 3 digits, non-decreasing with '0' ordering as 10. Mirrors the DB's is_valid_pana. */
export function isValidPana(pana: string): boolean {
  if (!/^[0-9]{3}$/.test(pana)) return false;
  const v = [...pana].map((d) => (d === '0' ? 10 : Number(d)));
  return v[0] <= v[1] && v[1] <= v[2];
}

/**
 * Which single pana-family a result pana belongs to. Exactly one applies, so
 * on any given day two of the three pana bet types simply cannot win — that's
 * the domain, not a gap in the settlement.
 */
export function panaFamily(pana: string): 'SINGLE' | 'DOUBLE' | 'TRIPLE' {
  const [a, b, c] = [...pana];
  if (a === b && b === c) return 'TRIPLE';
  if (a === b || b === c || a === c) return 'DOUBLE';
  return 'SINGLE';
}

export interface DerivedResult {
  openPana: string;
  closePana: string | null;
  /** Digit-sum of openPana, mod 10. */
  openSingle: number;
  /** Digit-sum of closePana, mod 10. Null until the close result is entered. */
  closeSingle: number | null;
}

export function derive(openPana: string, closePana: string | null): DerivedResult {
  return {
    openPana,
    closePana,
    openSingle: singleFromPana(openPana),
    closeSingle: closePana === null ? null : singleFromPana(closePana),
  };
}

/**
 * Which prediction types become settleable once a given side's result is in.
 *
 * The open result alone settles only the open-side types. Everything
 * else — both Sangams and the Jodi — needs *both* panas, because each
 * combines a value from each side, so they wait for the close result even
 * though they're open-*cutoff* types. Cutoff group and settlement group are
 * deliberately different questions: you bet on a Jodi before the open, but
 * it can't be graded until the close.
 */
export const OPEN_SETTLED_TYPES: PredictionType[] = [
  PredictionType.OPEN_SINGLE,
  PredictionType.OPEN_SINGLE_PANA,
  PredictionType.OPEN_DOUBLE_PANA,
  PredictionType.OPEN_TRIPLE_PANA,
];

export const CLOSE_SETTLED_TYPES: PredictionType[] = [
  PredictionType.CLOSE_SINGLE,
  PredictionType.CLOSE_SINGLE_PANA,
  PredictionType.CLOSE_DOUBLE_PANA,
  PredictionType.CLOSE_TRIPLE_PANA,
  PredictionType.JODI,
  PredictionType.HALF_SANGAM,
  PredictionType.FULL_SANGAM,
];

/**
 * Does `pickedNumber` win, given the derived result?
 *
 * Returns false rather than throwing for a type whose result isn't in yet —
 * callers only ever pass types from the matching *_SETTLED_TYPES list, so
 * that case means a programming error upstream, not a losing bet. It's
 * guarded rather than trusted because paying out on a half-known result is
 * the worst failure mode available here.
 */
export function isWinner(
  type: PredictionType,
  pickedNumber: string,
  r: DerivedResult,
): boolean {
  const openFamily = panaFamily(r.openPana);
  const closeFamily = r.closePana === null ? null : panaFamily(r.closePana);

  switch (type) {
    case PredictionType.OPEN_SINGLE:
      return pickedNumber === String(r.openSingle);
    case PredictionType.CLOSE_SINGLE:
      return r.closeSingle !== null && pickedNumber === String(r.closeSingle);

    // A pana bet wins only if the result pana is *that* family — 368 settles
    // OPEN_SINGLE_PANA and loses OPEN_DOUBLE_PANA/OPEN_TRIPLE_PANA outright.
    case PredictionType.OPEN_SINGLE_PANA:
      return openFamily === 'SINGLE' && pickedNumber === r.openPana;
    case PredictionType.OPEN_DOUBLE_PANA:
      return openFamily === 'DOUBLE' && pickedNumber === r.openPana;
    case PredictionType.OPEN_TRIPLE_PANA:
      return openFamily === 'TRIPLE' && pickedNumber === r.openPana;

    case PredictionType.CLOSE_SINGLE_PANA:
      return closeFamily === 'SINGLE' && pickedNumber === r.closePana;
    case PredictionType.CLOSE_DOUBLE_PANA:
      return closeFamily === 'DOUBLE' && pickedNumber === r.closePana;
    case PredictionType.CLOSE_TRIPLE_PANA:
      return closeFamily === 'TRIPLE' && pickedNumber === r.closePana;

    case PredictionType.JODI:
      return r.closeSingle !== null && pickedNumber === `${r.openSingle}${r.closeSingle}`;

    // Two winning forms, both valid: the open single against the close pana,
    // or the open pana against the close single.
    case PredictionType.HALF_SANGAM:
      if (r.closePana === null || r.closeSingle === null) return false;
      return (
        pickedNumber === `${r.openSingle}-${r.closePana}` ||
        pickedNumber === `${r.openPana}-${r.closeSingle}`
      );

    case PredictionType.FULL_SANGAM:
      return r.closePana !== null && pickedNumber === `${r.openPana}-${r.closePana}`;

    default:
      return false;
  }
}
