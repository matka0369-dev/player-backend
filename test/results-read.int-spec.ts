import { istClock, istDate, makeGame, seedBets } from './support/games';
import { makeTeam } from './support/world';

describe('declared results are readable for a day', () => {
  it('returns the panas and their singles to Admin and Agent once declared', async () => {
    const t = await makeTeam(0);
    const game = await makeGame(t.pa, t.admin.api, istClock(-240), istClock(-120));
    const date = istDate(0);
    await seedBets(game, []); // creates today's round, as the round generator does
    const find = (rows: any[]) => rows.find((r) => r.gameId === game.id);

    // no result yet: either the round isn't there or its panas are null
    let rows = await t.admin.api.ok('GET', `/games/results?date=${date}`);
    const before = find(rows);
    expect(before === undefined || before.openPana === null).toBe(true);

    await t.pa.ok('POST', `/games/${game.id}/result`, { date, openPana: '128' });
    rows = await t.admin.api.ok('GET', `/games/results?date=${date}&gameId=${game.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openPana: '128', openSingle: 1, closePana: null, closeSingle: null });

    // an Agent can read it too (the same declared, public result)
    const asAgent = await t.agent.api.ok('GET', `/games/results?date=${date}&gameId=${game.id}`);
    expect(asAgent[0].openPana).toBe('128');
  });

  it('rejects a malformed date', async () => {
    const t = await makeTeam(0);
    const r = await t.admin.api.raw('GET', '/games/results?date=yesterday');
    expect(r.status).toBe(400);
  });
});
