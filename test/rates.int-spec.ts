import { pred } from './support/api';
import { testPrisma } from './support/db';
import { makePlayer, makeTeam, type Account } from './support/world';

describe('uniform rates: every player of an agent plays at the agent\'s card', () => {
  let agent: Account;
  let playerMgr: Account;
  let p1: Account;
  let p2: Account;

  beforeAll(async () => {
    const team = await makeTeam(1000);
    agent = team.agent;
    playerMgr = team.playerMgr;
    p1 = await makePlayer(team.playerMgr.api);
    p2 = await makePlayer(team.playerMgr.api);
  });

  it('rejects a per-player rate card at creation', async () => {
    const r = await playerMgr.api.raw('POST', '/users', {
      email: 'x@t.local', username: 'xrate', password: 'Test-1234!', accountType: 'PLAYER',
      rates: [{ betType: 'SINGLE', multiplier: 12 }],
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).toMatch(/agent's rate card/);
  });

  it('shows every player the agent\'s giving card, live', async () => {
    const card = (a: Account) => a.api.at(pred()).ok('GET', '/rates/me');
    const single = (c: any) => c.playing.find((r: any) => r.betType === 'SINGLE').multiplier;

    const before = await Promise.all([card(p1), card(p2)]);
    expect(single(before[0])).toBe(single(before[1]));

    await agent.api.ok('PATCH', '/rates/me/giving', { entries: [{ betType: 'SINGLE', multiplier: 11 }] });

    const after = await Promise.all([card(p1), card(p2)]);
    expect(single(after[0])).toBe(11);
    expect(single(after[1])).toBe(11);
    // core-service agrees with the Go service
    expect((await p1.api.ok('GET', '/rates/me')).playing.find((r: any) => r.betType === 'SINGLE').multiplier).toBe(11);
  });

  it('no PLAYING rows exist for anyone', async () => {
    const prisma = testPrisma();
    try {
      expect(await prisma.rate.count({ where: { kind: 'PLAYING' } })).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
