/** Game / round / bet fixtures, mirroring prisma/demo-seed.ts. */
import { randomUUID } from 'node:crypto';
import type { Api } from './api';
import { testPrisma } from './db';

const TZ = 'Asia/Kolkata';

export function istClock(offsetMinutes: number): string {
  const t = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(t);
  return `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
}
export function istDate(dayOffset = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + dayOffset * 86_400_000));
}
/** The UTC instant of an IST wall time (IST is UTC+5:30, no DST). */
export function istInstant(dateISO: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(`${dateISO}T00:00:00.000Z`).getTime() + (h * 60 + m - 330) * 60_000;
}

export interface Game {
  id: string;
  open: string;
  close: string;
}

/** Platform Admin creates and activates a game; the Admin enables it. */
export async function makeGame(pa: Api, admin: Api, open: string, close: string): Promise<Game> {
  const g = await pa.ok('POST', '/games', {
    name: `G${Math.random().toString(36).slice(2, 8)}`, description: 'test', openTime: open, closeTime: close,
    minStake: 10, maxStake: 50_000, timezone: TZ,
  });
  await pa.ok('PATCH', `/games/${g.id}`, { status: 'ACTIVE' });
  await admin.ok('PATCH', `/games/${g.id}/enablement`, { enabled: true });
  return { id: g.id, open, close };
}

/**
 * Today's round for a game plus bets inserted directly — the cutoff trigger
 * (rightly) refuses bets in a window that has already closed, and a result can
 * only be filed after close, so settlement tests have to seed history.
 */
export async function seedBets(
  game: Game,
  bets: Array<{ userId: string; typeId: string; picked: string; stake: number; odds: number; agentOdds?: number }>,
  date = istDate(0),
): Promise<string> {
  const prisma = testPrisma();
  try {
    const opensAt = new Date(istInstant(date, game.open));
    const closesAt = new Date(istInstant(date, game.close));
    await prisma.$executeRawUnsafe(
      `INSERT INTO rounds (id, game_id, date, opens_at, closes_at, status, updated_at)
       VALUES ($1,$2,$3::date,$4,$5,'OPEN',now()) ON CONFLICT (game_id, date) DO NOTHING`,
      randomUUID(), game.id, date, opensAt, closesAt,
    );
    const round = await prisma.round.findFirstOrThrow({
      where: { gameId: game.id, date: new Date(`${date}T00:00:00.000Z`) },
      select: { id: true },
    });
    await prisma.$executeRawUnsafe('ALTER TABLE predictions DISABLE TRIGGER predictions_enforce_cutoff');
    try {
      for (const b of bets) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO predictions
             (id, user_id, round_id, type_id, picked_number, stake, odds_multiplier,
              agent_odds_multiplier, cutoff_at, outcome, created_at)
           VALUES ($1,$2,$3,$4::prediction_type,$5,$6,$7,$8,$9,'PENDING',$10)`,
          randomUUID(), b.userId, round.id, b.typeId, b.picked, b.stake, b.odds, b.agentOdds ?? b.odds,
          new Date(opensAt.getTime() - 60_000), new Date(opensAt.getTime() - 3_600_000),
        );
      }
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE predictions ENABLE TRIGGER predictions_enforce_cutoff');
    }
    return round.id;
  } finally {
    await prisma.$disconnect();
  }
}
