import { istClock, istDate, makeGame, seedBets } from './support/games';
import { testPrisma } from './support/db';
import { makePlayer, makeTeam } from './support/world';

describe('settlement: profit and loss are shared between Admin and Agent', () => {
  it('splits a win as a loss for both, freezes the share, and leaves old rows as they were', async () => {
    const t = await makeTeam(10_000);
    const player = await makePlayer(t.playerMgr.api);
    await t.finance.api.ok('POST', `/ledger/transfer/${player.id}`, { amount: 1000 });

    const game = await makeGame(t.pa, t.admin.api, istClock(-240), istClock(-120));
    // 100 wins (1 comes in on 128) and is paid 8x by the Admin; 200 loses
    await seedBets(game, [
      { userId: player.id, typeId: 'OPEN_SINGLE', picked: '1', stake: 100, odds: 9, agentOdds: 8 },
      { userId: player.id, typeId: 'OPEN_SINGLE', picked: '5', stake: 200, odds: 9, agentOdds: 8 },
    ]);
    const date = istDate(0);
    await t.pa.ok('POST', `/games/${game.id}/result`, { date, openPana: '128' });

    const pick = (res: { rows: any[] }) => res.rows.find((r) => r.gameId === game.id);

    // the Agent is on the default 9:1 split (1 tenth), so a win is a loss for both
    const admin = pick(await t.admin.api.ok('GET', `/predictions/settlements?date=${date}`));
    expect(admin).toMatchObject({ totalStaked: 300, totalPayout: 800, net: -500, agentShare: 1 });
    expect(admin.transfer).toBe(-450); // the Admin reimburses its 9/10
    expect(admin.yourResult).toBe(-450);

    const agent = pick(await t.agent.api.ok('GET', `/predictions/settlements?date=${date}`));
    expect(agent).toMatchObject({ net: 500, agentShare: 1 }); // the mirror of the whole position
    expect(agent.transfer).toBe(450); // received from the Admin
    expect(agent.yourResult).toBe(-50); // and still a loss of its own: 1/10

    // the two results add up to the whole position
    expect(admin.yourResult + agent.yourResult).toBe(admin.net);

    // a later change to the Agent's share does not re-price a day already settled,
    // not even when the game's second pass (close) rewrites the row
    const prisma = testPrisma();
    try {
      await prisma.$executeRawUnsafe('UPDATE users SET agent_share = 5 WHERE id = $1', t.agent.id);
      await t.pa.ok('POST', `/games/${game.id}/result`, { date, closePana: '678' });
      const again = pick(await t.admin.api.ok('GET', `/predictions/settlements?date=${date}`));
      expect(again.agentShare).toBe(1);
      expect(again.transfer).toBe(-450);

      // a row from before shares were applied (share 0) keeps its old meaning:
      // the Admin carries all of it
      await prisma.$executeRawUnsafe('UPDATE settlements SET agent_share = 0 WHERE game_id = $1', game.id);
    } finally {
      await prisma.$disconnect();
    }
    const legacy = pick(await t.admin.api.ok('GET', `/predictions/settlements?date=${date}`));
    expect(legacy).toMatchObject({ agentShare: 0, transfer: -500, yourResult: -500 });
    const legacyAgent = pick(await t.agent.api.ok('GET', `/predictions/settlements?date=${date}`));
    expect(legacyAgent).toMatchObject({ transfer: 500, yourResult: 0 });
  });
});
