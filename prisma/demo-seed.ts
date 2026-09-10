/**
 * Demo data for clicking through the whole product.
 *
 * Builds a realistic hierarchy, three games on an IST clock, two days of
 * already-settled history so the result/settlement dashboards have something
 * in them, and a live game that is still inside its betting window so a
 * demo can actually place a bet rather than just look at one.
 *
 * Everything that *can* go through the real API does, so this exercises the
 * same authorization and ledger paths a user would. The one exception is
 * backdated history: rounds are only generated for today forward, and the
 * cutoff trigger correctly refuses a prediction dated in the past, so those
 * rows are inserted directly with the trigger suspended for the duration.
 * Grading them still runs through POST /games/:id/result, so the payouts and
 * settlements are computed by the real engine rather than faked.
 *
 * Usage:  DATABASE_URL=... npx ts-node prisma/demo-seed.ts
 * Assumes core-service on :3000 and prediction-service on :8080.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const CORE = process.env.CORE_URL ?? 'http://localhost:3000';
const PRED = process.env.PRED_URL ?? 'http://localhost:8080';
const PA = {
  identifier: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'platform-admin@predictsim.local',
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'change-this-immediately-123',
};
/** One password for every demo account — this is throwaway data, not a secret. */
const PW = 'Demo1234!';
const TZ = 'Asia/Kolkata';

const prisma = new PrismaClient();

type Session = { cookie: string | null; id?: string; username?: string };
const S = (): Session => ({ cookie: null });

async function call(s: Session, method: string, base: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (s.cookie) headers.cookie = s.cookie;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of (res as any).headers.getSetCookie?.() ?? []) {
    if (c.startsWith('predictsim_sid=')) s.cookie = c.split(';')[0];
  }
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function login(identifier: string, password: string): Promise<Session> {
  const s = S();
  const r = await call(s, 'POST', CORE, '/auth/login', { identifier, password });
  s.id = r.user.id; s.username = r.user.username;
  return s;
}

/** Wall-clock HH:mm in a zone, offset by whole minutes from now. */
function istClock(offsetMinutes: number) {
  const t = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(t);
  const h = parts.find((p) => p.type === 'hour')!.value;
  const m = parts.find((p) => p.type === 'minute')!.value;
  return `${h}:${m}`;
}
function istDate(dayOffset: number) {
  const t = new Date(Date.now() + dayOffset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t); // YYYY-MM-DD
}
/** The UTC instant of a given IST wall time on a given IST date. */
function istInstant(dateISO: string, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  // IST is UTC+5:30 year-round — no DST to reason about.
  return new Date(`${dateISO}T00:00:00.000Z`).getTime() + (h * 60 + m - 330) * 60_000;
}

const PANAS = ['123', '128', '137', '146', '236', '245', '290', '380', '470', '489'];
const DOUBLES = ['112', '116', '133', '155', '224', '337', '449', '558'];
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

async function main() {
  console.log('→ logging in as platform admin');
  const pa = await login(PA.identifier, PA.password);

  const roles = await call(pa, 'GET', CORE, '/roles');
  const roleId = (n: string) => roles.find((r: any) => r.name === n)?.id;

  // ---------------------------------------------------------------- hierarchy
  console.log('→ building hierarchy');
  const houses = [
    { key: 'mumbai', label: 'Mumbai Central', agents: ['dadar', 'andheri'] },
    { key: 'pune', label: 'Pune Camp', agents: ['kothrud'] },
  ];

  const built: any[] = [];
  for (const h of houses) {
    const admin = await call(pa, 'POST', CORE, '/users', {
      email: `${h.key}@predictsim.demo`, username: `${h.key}_admin`,
      password: PW, accountType: 'ADMIN',
    });
    const adminS = await login(admin.email, PW);

    await call(adminS, 'POST', CORE, '/users', {
      email: `${h.key}.desk@predictsim.demo`, username: `${h.key}_desk`,
      password: PW, accountType: 'ADMIN_STAFF',
      roleIds: [roleId('Token Manager'), roleId('Reporting')].filter(Boolean),
    });

    const agents: any[] = [];
    for (const a of h.agents) {
      const agent = await call(adminS, 'POST', CORE, '/users', {
        email: `${a}@predictsim.demo`, username: `${a}_agent`,
        password: PW, accountType: 'AGENT',
      });
      const agentS = await login(agent.email, PW);

      await call(agentS, 'POST', CORE, '/users', {
        email: `${a}.desk@predictsim.demo`, username: `${a}_desk`,
        password: PW, accountType: 'AGENT_STAFF',
        roleIds: [roleId('Request Manager'), roleId('Reporting')].filter(Boolean),
      });

      // Admin funds the agent's float — the only way an Agent gets tokens.
      await call(adminS, 'POST', CORE, `/ledger/grant/${agent.id}`, {
        amount: 500_000, note: 'Opening float',
      });

      const players: any[] = [];
      for (let i = 1; i <= 3; i++) {
        const p = await call(agentS, 'POST', CORE, '/users', {
          email: `${a}.p${i}@predictsim.demo`, username: `${a}_player${i}`,
          password: PW, accountType: 'PLAYER',
        });
        await call(agentS, 'POST', CORE, `/ledger/transfer/${p.id}`, {
          amount: rnd(8, 20) * 1000, note: 'Opening balance',
        });
        players.push({ ...p, session: await login(p.email, PW) });
      }
      agents.push({ rec: agent, session: agentS, players });
    }
    built.push({ admin, adminS, agents });
  }
  const allPlayers = built.flatMap((h) => h.agents.flatMap((a: any) => a.players));
  console.log(`  ${built.length} admins, ${built.flatMap((h) => h.agents).length} agents, ${allPlayers.length} players`);

  // -------------------------------------------------------------------- games
  console.log('→ creating games (IST clock)');
  const gameDefs = [
    { name: 'Kalyan Morning', open: istClock(-240), close: istClock(-120), live: false },
    { name: 'Milan Day', open: istClock(45), close: istClock(150), live: true },
    { name: 'Rajdhani Night', open: istClock(300), close: istClock(420), live: true },
  ];
  const games: any[] = [];
  for (const g of gameDefs) {
    const created = await call(pa, 'POST', CORE, '/games', {
      name: g.name, description: `${g.name} — demo game`, openTime: g.open,
      closeTime: g.close, minStake: 10, maxStake: 50_000, timezone: TZ,
    });
    await call(pa, 'PATCH', CORE, `/games/${created.id}`, { status: 'ACTIVE' });
    for (const h of built) {
      await call(h.adminS, 'PATCH', CORE, `/games/${created.id}/enablement`, { enabled: true });
    }
    games.push({ ...created, ...g });
    console.log(`  ${g.name}  ${g.open}–${g.close} IST${g.live ? '  (bettable now)' : ''}`);
  }

  // ------------------------------------------------------- backdated history
  // Rounds only generate forward, and the cutoff trigger rightly refuses a
  // past-dated prediction, so history is inserted directly with the trigger
  // suspended. Grading still goes through the real result endpoint below.
  console.log('→ backfilling two days of settled history');
  const history = games[0];
  const pastDays = [istDate(-2), istDate(-1)];

  await prisma.$executeRawUnsafe('ALTER TABLE predictions DISABLE TRIGGER predictions_enforce_cutoff');
  try {
    for (const d of pastDays) {
      const opensAt = new Date(istInstant(d, history.open));
      const closesAt = new Date(istInstant(d, history.close));
      const roundId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO rounds (id, game_id, date, opens_at, closes_at, status, updated_at)
         VALUES ($1,$2,$3::date,$4,$5,'OPEN',now()) ON CONFLICT (game_id, date) DO NOTHING`,
        roundId, history.id, d, opensAt, closesAt,
      );
      const round = await prisma.round.findFirstOrThrow({
        where: { gameId: history.id, date: new Date(`${d}T00:00:00.000Z`) },
        select: { id: true },
      });

      for (const p of allPlayers) {
        for (let n = 0; n < rnd(2, 4); n++) {
          const kind = pick(['OPEN_SINGLE', 'CLOSE_SINGLE', 'JODI', 'OPEN_SINGLE_PANA', 'CLOSE_DOUBLE_PANA']);
          const picked =
            kind.endsWith('SINGLE') ? String(rnd(0, 9))
            : kind === 'JODI' ? `${rnd(0, 9)}${rnd(0, 9)}`
            : kind === 'CLOSE_DOUBLE_PANA' ? pick(DOUBLES)
            : pick(PANAS);
          const stake = rnd(1, 10) * 100;
          const rate = kind.includes('SINGLE') && !kind.includes('PANA') ? 9
            : kind === 'JODI' ? 90 : kind.includes('DOUBLE') ? 280 : 140;
          await prisma.$executeRawUnsafe(
            `INSERT INTO predictions
               (id, user_id, round_id, type_id, picked_number, stake, odds_multiplier,
                agent_odds_multiplier, cutoff_at, outcome, created_at)
             VALUES ($1,$2,$3,$4::prediction_type,$5,$6,$7,$8,$9,'PENDING',$10)`,
            randomUUID(), p.id, round.id, kind, picked, stake, rate, rate,
            new Date(opensAt.getTime() - 60_000), new Date(opensAt.getTime() - 3_600_000),
          );
          // Stake leaves the wallet, same as a live bet would.
          await prisma.$executeRawUnsafe(
            `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1`, stake, p.id,
          );
          const after = await prisma.user.findUniqueOrThrow({ where: { id: p.id }, select: { balance: true } });
          await prisma.$executeRawUnsafe(
            `INSERT INTO token_ledger_entries (id, user_id, delta, wallet, balance_after, source, created_at)
             VALUES ($1,$2,$3,'MAIN'::ledger_wallet,$4,'PREDICTION_DEBIT'::ledger_source,$5)`,
            randomUUID(), p.id, -stake, after.balance, new Date(opensAt.getTime() - 3_600_000),
          );
        }
      }
      // Real grading, real payouts, real settlements.
      const res = await call(pa, 'POST', CORE, `/games/${history.id}/result`, {
        date: d, openPana: pick(PANAS), closePana: pick(DOUBLES),
      });
      console.log(`  ${d}: ${res.settledCount} graded, ${res.wonCount} won, ${res.totalPaidOut} paid, ${res.agentsSettled} settlements`);
    }
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE predictions ENABLE TRIGGER predictions_enforce_cutoff');
  }

  // ------------------------------------------------------------- live betting
  console.log('→ placing live bets on the open game');
  const live = games.find((g) => g.live)!;
  // The scheduler generates today's round on a 20s tick; wait for it.
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    const av = await call(allPlayers[0].session, 'GET', PRED, '/games/active');
    ready = av.some((x: any) => x.gameId === live.id);
    if (!ready) await new Promise((r) => setTimeout(r, 2000));
  }
  let placed = 0;
  if (ready) {
    for (const p of allPlayers) {
      for (let n = 0; n < rnd(1, 3); n++) {
        try {
          await call(p.session, 'POST', PRED, '/predictions', {
            gameId: live.id, typeId: pick(['OPEN_SINGLE', 'JODI', 'OPEN_SINGLE_PANA']),
            pickedNumber: pick(['3', '7', '46', '81', '128', '236']),
            stake: rnd(1, 5) * 100,
          });
          placed++;
        } catch { /* a pick that fails format for the chosen type — skip */ }
      }
    }
  }
  console.log(`  ${placed} live bets on ${live.name}${ready ? '' : ' (round not ready)'}`);

  // ------------------------------------------------------------- open queue
  console.log('→ leaving token requests pending for the queue');
  const q1 = allPlayers[0], q2 = allPlayers[3] ?? allPlayers[1];
  await call(q1.session, 'POST', CORE, '/token-requests', { kind: 'TOP_UP', amount: 5000, note: 'Running low, please top up' });
  await call(q2.session, 'POST', CORE, '/token-requests', { kind: 'SURRENDER', amount: 1000, note: 'Giving these back' });

  console.log('\n=== demo ready ===');
  console.log(`Platform Admin  ${PA.identifier} / ${PA.password}   :5173`);
  for (const h of built) {
    console.log(`Admin           ${h.admin.email} / ${PW}   :5174`);
    for (const a of h.agents) console.log(`  Agent         ${a.rec.email} / ${PW}   :5175`);
  }
  console.log(`Player          ${allPlayers[0].email} / ${PW}   :5176`);
  console.log(`(every demo account uses ${PW})`);
}

main()
  .catch((e) => { console.error('demo seed failed:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
