import { istClock, istDate, makeGame, seedBets } from './support/games';
import { makePlayer, makeTeam } from './support/world';

describe('settlement: the agent\'s wallet pays the winners', () => {
  it('debits the agent for each winning bet, and refunds it when the result is corrected', async () => {
    const t = await makeTeam(10_000);
    const player = await makePlayer(t.playerMgr.api);
    await t.finance.api.ok('POST', `/ledger/transfer/${player.id}`, { amount: 1000 });

    const game = await makeGame(t.pa, t.admin.api, istClock(-240), istClock(-120));
    await seedBets(game, [
      { userId: player.id, typeId: 'OPEN_SINGLE', picked: '1', stake: 100, odds: 9 }, // wins on 128
      { userId: player.id, typeId: 'OPEN_SINGLE', picked: '5', stake: 200, odds: 9 }, // loses
    ]);
    const balance = async (id: string, api = t.agent.api) => (await api.ok('GET', `/users/${id}`));
    const agentBefore = (await balance(t.agent.id)).balance;
    expect(agentBefore).toBe(9000); // 10 000 float - 1 000 sent to the player

    const date = istDate(0);
    const res = await t.pa.ok('POST', `/games/${game.id}/result`, { date, openPana: '128' });
    expect(res.wonCount).toBe(1);
    expect(res.totalPaidOut).toBe(900);

    // the winner is credited in WINNINGS, the agent pays the same amount
    const p = await balance(player.id);
    expect(p.winningsBalance).toBe(900);
    expect((await balance(t.agent.id)).balance).toBe(agentBefore - 900);

    const ledger = await t.agent.api.ok('GET', '/ledger?limit=50');
    const paid = ledger.filter((e: any) => e.source === 'AGENT_PAYOUT');
    expect(paid).toHaveLength(1);
    expect(paid[0].delta).toBe(-900);

    // a wrong result gets corrected: nobody wins on the new pana, so the player
    // loses the payout and the agent gets its tokens back
    await t.pa.ok('POST', `/games/${game.id}/result/correct`, {
      date, openPana: '129', reason: 'typo in the first entry',
    });
    expect((await balance(player.id)).winningsBalance).toBe(0);
    expect((await balance(t.agent.id)).balance).toBe(agentBefore);
  });

  it('never fails when the agent cannot cover the payout: the balance goes negative', async () => {
    const t = await makeTeam(100); // float far below the 9 000 payout
    const player = await makePlayer(t.playerMgr.api);
    const game = await makeGame(t.pa, t.admin.api, istClock(-240), istClock(-120));
    await seedBets(game, [{ userId: player.id, typeId: 'OPEN_SINGLE', picked: '1', stake: 1000, odds: 9 }]);

    const res = await t.pa.ok('POST', `/games/${game.id}/result`, { date: istDate(0), openPana: '128' });
    expect(res.totalPaidOut).toBe(9000);
    expect((await t.agent.api.ok('GET', `/users/${player.id}`)).winningsBalance).toBe(9000);
    expect((await t.agent.api.ok('GET', `/users/${t.agent.id}`)).balance).toBe(100 - 9000);
  });
});
