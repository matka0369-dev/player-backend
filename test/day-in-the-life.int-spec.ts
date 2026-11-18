/**
 * One agent business day, end to end, through the real services:
 * Admin budgets an Agent -> the Agent's employees (by role) set up and fund
 * players -> players sign up / ask for tokens / bet -> the result is entered ->
 * the Agent's wallet pays the winners -> the Agent reads its consolidated
 * totals and P&L -> everything is attributed in the activity log.
 *
 * Timing note: the game window is set ~10-40 minutes ahead on the IST clock.
 * Bets are placed while it is still before the open cutoff, then the round is
 * shifted into the past so the result can be filed. Between 23:20 and 00:00 IST
 * the window would wrap past midnight and this test is not meaningful.
 */
import { Api, pred } from './support/api';
import { testPrisma } from './support/db';
import { istClock, istDate, makeGame } from './support/games';
import { makePlayer, makeTeam, type Account } from './support/world';

describe('a day in the life of an agent', () => {
  it('runs from budget to settled bets, with every action attributed', async () => {
    // ---- the cast: Admin -> Agent (50 000) with one employee per role -------
    const t = await makeTeam(50_000);
    const agentBalance = async () => (await t.agent.api.ok('GET', `/users/${t.agent.id}`)).balance;
    expect(await agentBalance()).toBe(50_000);

    // ---- player A signs themselves up in the app; player B is created by staff
    const { inviteCode } = await t.agent.api.ok('GET', '/player-access/me');
    const phone = `7${Math.floor(100000000 + Math.random() * 899999999)}`;
    const aSession = new Api(pred());
    const signup = await aSession.ok('POST', '/auth/signup', { agentCode: inviteCode, name: 'Asha Rao', phone, pin: '1234' });
    const A = { id: signup.user.id, username: signup.user.username, api: aSession } as Account;
    const B = await makePlayer(t.playerMgr.api);

    // ---- both ask for tokens; the agent's Finance employee finds each request
    //      from the code in its WhatsApp message, and approves ------------------
    const reqA = await A.api.ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 1000, note: 'for the evening game' });
    const reqB = await B.api.at(pred()).ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 1000 });
    for (const r of [reqA, reqB]) {
      const found = await t.finance.api.ok('GET', `/token-requests/lookup?code=${r.shortCode}`);
      expect(found.id).toBe(r.id);
      await t.finance.api.ok('POST', `/token-requests/${r.id}/approve`, {});
    }
    expect(await agentBalance()).toBe(48_000);

    // ---- a live game; both players bet through the Go service ----------------
    const game = await makeGame(t.pa, t.admin.api, istClock(10), istClock(40));
    const date = istDate(0);
    const bet = (who: Account, typeId: string, pickedNumber: string, stake: number) =>
      who.api.at(pred()).raw('POST', '/predictions', { gameId: game.id, typeId, pickedNumber, stake });

    // the scheduler generates today's round within a second or two
    for (let i = 0; i < 40; i++) {
      const active = await A.api.at(pred()).ok('GET', '/games/active');
      if (active.some((g: any) => g.gameId === game.id)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const placed = [
      await bet(A, 'OPEN_SINGLE', '1', 100),
      await bet(A, 'OPEN_SINGLE', '5', 200),
      await bet(B, 'OPEN_SINGLE', '1', 300),
    ];
    expect(placed.map((r) => r.status)).toEqual([201, 201, 201]);

    // every player of the agent plays at the same rate
    const odds = (await t.agent.api.ok('GET', '/predictions')).map((p: any) => p.oddsMultiplier);
    expect(new Set(odds).size).toBe(1);

    // stakes left the players' wallets and went nowhere
    const bal = async (u: Account) => (await t.agent.api.ok('GET', `/users/${u.id}`)).balance;
    expect(await bal(A)).toBe(1000 - 300);
    expect(await bal(B)).toBe(1000 - 300);
    expect(await agentBalance()).toBe(48_000);

    // ---- the agent's consolidated view (analyst): totals per number ----------
    const book = await t.analyst.api.ok('GET', `/predictions/aggregate?gameId=${game.id}&date=${date}`);
    const row = (n: string) => book.rows.find((r: any) => r.typeId === 'OPEN_SINGLE' && r.pickedNumber === n);
    expect(row('1')).toMatchObject({ betCount: 2, totalStake: 400 });
    expect(row('5')).toMatchObject({ betCount: 1, totalStake: 200 });
    // ... and a date range returns the same book
    const ranged = await t.analyst.api.ok('GET', `/predictions/aggregate?gameId=${game.id}&from=${date}&to=${date}`);
    expect(ranged.rows).toHaveLength(book.rows.length);

    // ---- the platform admin files the result --------------------------------
    // (shift the round into the past so its windows have closed)
    const prisma = testPrisma();
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE rounds SET opens_at = opens_at - interval '2 hours', closes_at = closes_at - interval '4 hours' WHERE game_id = $1`,
        game.id,
      );
    } finally {
      await prisma.$disconnect();
    }
    const res = await t.pa.ok('POST', `/games/${game.id}/result`, { date, openPana: '128' }); // open single = 1
    expect(res).toMatchObject({ wonCount: 2, lostCount: 1, totalPaidOut: 100 * 9 + 300 * 9 });

    // the winners are paid; the agent's wallet pays for it
    const win = async (u: Account) => (await t.agent.api.ok('GET', `/users/${u.id}`)).winningsBalance;
    expect(await win(A)).toBe(900);
    expect(await win(B)).toBe(2700);
    expect(await agentBalance()).toBe(48_000 - 3600);

    // ---- the agent's profit and loss for the day ----------------------------
    const pnl = await t.analyst.api.ok('GET', `/predictions/agent-pnl?from=${date}&to=${date}`);
    expect(pnl.totals).toMatchObject({ betCount: 3, wonCount: 2, totalStake: 600, totalPayout: 3600, net: -3000 });
    expect(pnl.rows).toHaveLength(1);
    // staff without prediction:view cannot read it
    expect((await t.finance.api.raw('GET', '/predictions/agent-pnl')).status).toBe(403);

    // ---- player A gives some tokens back (spent from main first) -------------
    const ret = await A.api.ok('POST', '/token-requests', { kind: 'RETURN', amount: 500 });
    await t.finance.api.ok('POST', `/token-requests/${ret.id}/approve`, {});
    expect(await bal(A)).toBe(700 - 500);
    expect(await agentBalance()).toBe(48_000 - 3600 + 500);

    // ---- who did what -------------------------------------------------------
    const log = await t.agent.api.ok('GET', '/audit?limit=500');
    const actors = (action: string) => new Set(log.filter((e: any) => e.action === action).map((e: any) => e.actor?.username));
    expect(actors('player.signup')).toEqual(new Set([A.username]));
    expect(actors('user.create')).toContain(t.playerMgr.username);
    expect(actors('request.approve')).toEqual(new Set([t.finance.username]));
    // the owner agent itself approved nothing and moved no money
    expect(log.some((e: any) => e.actor?.username === t.agent.username && /^(request|tokens)\./.test(e.action))).toBe(false);
  });
});
