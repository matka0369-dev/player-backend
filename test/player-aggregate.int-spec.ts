import { istClock, istDate, makeGame, seedBets } from './support/games';
import { makePlayer, makeTeam } from './support/world';

describe('aggregate for one player', () => {
  it('limits the totals to that player, over a date range, and never leaks another Agent\'s player', async () => {
    const t = await makeTeam(0);
    const other = await makeTeam(0); // a different Agent with its own player
    const p1 = await makePlayer(t.playerMgr.api);
    const p2 = await makePlayer(t.playerMgr.api);
    const stranger = await makePlayer(other.playerMgr.api);

    const game = await makeGame(t.pa, t.admin.api, istClock(-240), istClock(-120));
    const today = istDate(0);
    const yesterday = istDate(-1);
    await seedBets(game, [
      { userId: p1.id, typeId: 'OPEN_SINGLE', picked: '5', stake: 100, odds: 9 },
      { userId: p1.id, typeId: 'OPEN_SINGLE', picked: '5', stake: 50, odds: 9 },
      { userId: p2.id, typeId: 'OPEN_SINGLE', picked: '5', stake: 200, odds: 9 },
    ], today);
    await seedBets(game, [{ userId: p1.id, typeId: 'OPEN_SINGLE', picked: '7', stake: 30, odds: 9 }], yesterday);

    const stake = (r: { rows: any[] }, n: string) => r.rows.find((x) => x.pickedNumber === n)?.totalStake;

    // everyone: today's 5 is 100 + 50 + 200
    const all = await t.agent.api.ok('GET', `/predictions/aggregate?date=${today}`);
    expect(stake(all, '5')).toBe(350);

    // one player, one day
    const mine = await t.agent.api.ok('GET', `/predictions/aggregate?date=${today}&playerId=${p1.id}`);
    expect(stake(mine, '5')).toBe(150);

    // one player over a range picks up the earlier day as well
    const range = await t.agent.api.ok('GET', `/predictions/aggregate?from=${yesterday}&to=${today}&playerId=${p1.id}`);
    expect(stake(range, '5')).toBe(150);
    expect(stake(range, '7')).toBe(30);

    // another Agent's player: the scope still applies, so nothing comes back
    const leak = await t.agent.api.ok('GET', `/predictions/aggregate?date=${today}&playerId=${stranger.id}`);
    expect(leak.rows).toEqual([]);
  });
});
