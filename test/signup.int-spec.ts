import { Api, core, pred, uniq } from './support/api';
import { makeTeam } from './support/world';

describe('player self-signup (Go) under an agent\'s invite code', () => {
  it('creates the player under that agent, with the agent\'s rates, and logs it', async () => {
    const t = await makeTeam(0);
    const { inviteCode } = await t.agent.api.ok('GET', '/player-access/me');
    const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;

    const anon = new Api(pred());
    const res = await anon.ok('POST', '/auth/signup', { agentCode: inviteCode, name: 'Test Person', phone, pin: '2468' });
    expect(res.user.accountType).toBe('PLAYER');
    expect(res.user.agentId).toBe(t.agent.id);
    expect(res.user.username).toMatch(/^testperson_\d{4}/);
    expect(res.deviceKey).toMatch(/^[0-9a-f]{64}$/);

    // signed in: reads the agent's giving card
    const rates = await anon.ok('GET', '/rates/me');
    const giving = (await t.agent.api.ok('GET', '/rates/me')).giving;
    expect(rates.playing.map((r: any) => [r.betType, r.multiplier])).toEqual(giving.map((r: any) => [r.betType, r.multiplier]));

    // the agent sees the new player and an audit line naming the player as the actor
    const players = await t.agent.api.ok('GET', '/users');
    expect(players.some((p: any) => p.username === res.user.username)).toBe(true);
    const log = await t.agent.api.ok('GET', '/audit?action=player.signup');
    expect(log.some((e: any) => e.target?.username === res.user.username)).toBe(true);

    // the PIN login works from the enrolled phone
    const again = new Api(pred());
    await again.ok('POST', '/auth/pin-login', { deviceId: res.deviceId, deviceKey: res.deviceKey, pin: '2468' });
    expect((await again.raw('POST', '/auth/pin-login', { deviceId: res.deviceId, deviceKey: res.deviceKey, pin: '0000' })).status).toBe(401);
  });

  it('refuses a phone already registered under the same admin, bad input, and unknown agents', async () => {
    const t = await makeTeam(0);
    const { inviteCode } = await t.agent.api.ok('GET', '/player-access/me');
    const phone = `8${Math.floor(100000000 + Math.random() * 899999999)}`;
    const body = { agentCode: inviteCode, name: 'Dup Person', phone, pin: '1357' };

    await new Api(pred()).ok('POST', '/auth/signup', body);
    expect((await new Api(pred()).raw('POST', '/auth/signup', body)).data).toBe('phone_taken\n');
    expect((await new Api(pred()).raw('POST', '/auth/signup', { ...body, phone: '12' })).status).toBe(400);
    expect((await new Api(pred()).raw('POST', '/auth/signup', { ...body, pin: '12' })).status).toBe(400);
    expect((await new Api(pred()).raw('POST', '/auth/signup', { ...body, name: 'x' })).status).toBe(400);
    expect((await new Api(pred()).raw('POST', '/auth/signup', { ...body, agentCode: 'zzzzzzzz' })).status).toBe(404);
  });
});
void core; void uniq;
