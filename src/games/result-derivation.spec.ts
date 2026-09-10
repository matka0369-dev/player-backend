import { PredictionType as T } from '@prisma/client';
import {
  derive,
  isValidPana,
  isWinner,
  panaFamily,
  singleFromPana,
} from './result-derivation';

/**
 * The project's first automated test, and deliberately here: this module
 * decides who gets paid, is pure (no DB, no clock, no auth), and its rules
 * are the kind that look obvious right up until a zero is involved.
 */

describe('singleFromPana', () => {
  it('sums digits mod 10', () => {
    expect(singleFromPana('368')).toBe(7); // 17 -> 7
    expect(singleFromPana('159')).toBe(5); // 15 -> 5
    expect(singleFromPana('123')).toBe(6);
  });

  it("treats '0' as zero when summing, NOT as ten", () => {
    // The trap: '0' sorts as 10 for pana *ordering* (isValidPana) but
    // contributes 0 to the sum. Getting these two rules the same way round
    // silently shifts every result involving a zero.
    expect(singleFromPana('100')).toBe(1);
    expect(singleFromPana('890')).toBe(7);
    expect(singleFromPana('000')).toBe(0);
  });
});

describe('isValidPana', () => {
  it("accepts non-decreasing panas, with '0' ordering as ten", () => {
    expect(isValidPana('368')).toBe(true);
    expect(isValidPana('123')).toBe(true);
    expect(isValidPana('100')).toBe(true); // 1,10,10
    expect(isValidPana('111')).toBe(true);
  });

  it('rejects decreasing panas and malformed input', () => {
    expect(isValidPana('012')).toBe(false); // 10,1,2
    expect(isValidPana('321')).toBe(false);
    expect(isValidPana('12')).toBe(false);
    expect(isValidPana('12a')).toBe(false);
  });
});

describe('panaFamily', () => {
  it('classifies by repeat pattern', () => {
    expect(panaFamily('368')).toBe('SINGLE');
    expect(panaFamily('112')).toBe('DOUBLE');
    expect(panaFamily('100')).toBe('DOUBLE');
    expect(panaFamily('111')).toBe('TRIPLE');
  });
});

describe('isWinner — worked example, open 368 / close 159', () => {
  const r = derive('368', '159');

  it('derives the singles', () => {
    expect(r.openSingle).toBe(7);
    expect(r.closeSingle).toBe(5);
  });

  it.each([
    ['open single, hit', T.OPEN_SINGLE, '7', true],
    ['open single, miss', T.OPEN_SINGLE, '3', false],
    ['close single, hit', T.CLOSE_SINGLE, '5', true],
    ['open single pana, hit', T.OPEN_SINGLE_PANA, '368', true],
    ['close single pana, hit', T.CLOSE_SINGLE_PANA, '159', true],
    ['jodi, hit', T.JODI, '75', true],
    ['jodi, reversed digits miss', T.JODI, '57', false],
    ['half sangam as openSingle-closePana', T.HALF_SANGAM, '7-159', true],
    ['half sangam as openPana-closeSingle', T.HALF_SANGAM, '368-5', true],
    ['half sangam, wrong single', T.HALF_SANGAM, '3-159', false],
    ['full sangam, hit', T.FULL_SANGAM, '368-159', true],
    ['full sangam, sides swapped', T.FULL_SANGAM, '159-368', false],
  ])('%s', (_label, type, picked, expected) => {
    expect(isWinner(type as T, picked as string, r)).toBe(expected);
  });

  it('loses the pana families the result is not, even on an exact digit match', () => {
    // 368 is a single pana, so a double/triple bet on those same digits
    // cannot win — two of the three pana types are unwinnable each day.
    expect(isWinner(T.OPEN_DOUBLE_PANA, '368', r)).toBe(false);
    expect(isWinner(T.OPEN_TRIPLE_PANA, '368', r)).toBe(false);
  });
});

describe('isWinner — open result only, close not yet entered', () => {
  const r = derive('368', null);

  it('settles open-side types', () => {
    expect(isWinner(T.OPEN_SINGLE, '7', r)).toBe(true);
    expect(isWinner(T.OPEN_SINGLE_PANA, '368', r)).toBe(true);
  });

  it('never pays anything needing the close half', () => {
    // Paying out on a half-known result is the worst failure available
    // here, so these are guarded rather than assumed unreachable.
    expect(isWinner(T.JODI, '75', r)).toBe(false);
    expect(isWinner(T.CLOSE_SINGLE, '5', r)).toBe(false);
    expect(isWinner(T.HALF_SANGAM, '7-159', r)).toBe(false);
    expect(isWinner(T.FULL_SANGAM, '368-159', r)).toBe(false);
  });
});

describe('isWinner — double and triple pana results', () => {
  it('pays the double family and nothing else', () => {
    const r = derive('112', null);
    expect(isWinner(T.OPEN_DOUBLE_PANA, '112', r)).toBe(true);
    expect(isWinner(T.OPEN_SINGLE_PANA, '112', r)).toBe(false);
    expect(isWinner(T.OPEN_TRIPLE_PANA, '112', r)).toBe(false);
    expect(r.openSingle).toBe(4);
  });

  it('pays the triple family and nothing else', () => {
    const r = derive('111', null);
    expect(isWinner(T.OPEN_TRIPLE_PANA, '111', r)).toBe(true);
    expect(isWinner(T.OPEN_SINGLE_PANA, '111', r)).toBe(false);
    expect(isWinner(T.OPEN_DOUBLE_PANA, '111', r)).toBe(false);
    expect(r.openSingle).toBe(3);
  });
});
