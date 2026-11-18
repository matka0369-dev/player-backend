import { pred } from './support/api';
import { makePlayer, makeTeam, type Account, type Team } from './support/world';

type World = Team & { pa: any };

describe('token requests: top-up and return, found by their WhatsApp code', () => {
  let t: World;
  let player: Account;

  beforeAll(async () => {
    t = await makeTeam(20_000);
    player = await makePlayer(t.playerMgr.api);
    await t.finance.api.ok('POST', `/ledger/transfer/${player.id}`, { amount: 1000 });
  });

  const balance = async (id: string) => (await t.agent.api.ok('GET', `/users/${id}`)).balance;

  it('every request carries an 8-character short code, whichever service created it', async () => {
    const viaCore = await player.api.ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 50 });
    expect(viaCore.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    await player.api.ok('POST', `/token-requests/${viaCore.id}/cancel`);

    const viaGo = await player.api.at(pred()).ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 60 });
    expect(viaGo.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    await player.api.at(pred()).ok('POST', `/token-requests/${viaGo.id}/cancel`);
  });

  it('a pasted code finds the request (any case), only inside the agent\'s own queue', async () => {
    const r = await player.api.ok('POST', '/token-requests', { kind: 'RETURN', amount: 300, note: 'giving back' });

    const found = await t.finance.api.ok('GET', `/token-requests/lookup?code=${r.shortCode.toLowerCase()}`);
    expect(found.id).toBe(r.id);
    expect(found.amount).toBe(300);

    const stranger = await makeTeam(10);
    expect((await stranger.finance.api.raw('GET', `/token-requests/lookup?code=${r.shortCode}`)).status).toBe(404);
    expect((await t.finance.api.raw('GET', '/token-requests/lookup?code=ZZZZZZZZ')).status).toBe(404);
    expect((await t.bare.api.raw('GET', `/token-requests/lookup?code=${r.shortCode}`)).status).toBe(403);
    expect((await player.api.raw('GET', `/token-requests/lookup?code=${r.shortCode}`)).status).toBe(403);
  });

  it('a return moves tokens from the player to the agent when Finance approves it', async () => {
    const pending = (await t.finance.api.ok('GET', '/token-requests?status=PENDING')).find((x: any) => x.kind === 'RETURN');
    const [playerBefore, agentBefore] = [await balance(player.id), await balance(t.agent.id)];

    // the owner and an employee without request:approve cannot
    expect((await t.agent.api.raw('POST', `/token-requests/${pending.id}/approve`, {})).status).toBe(403);
    expect((await t.playerMgr.api.raw('POST', `/token-requests/${pending.id}/approve`, {})).status).toBe(403);

    await t.finance.api.ok('POST', `/token-requests/${pending.id}/approve`, { resolutionNote: 'received' });
    expect(await balance(player.id)).toBe(playerBefore - 300);
    expect(await balance(t.agent.id)).toBe(agentBefore + 300);

    const entry = (await t.agent.api.ok('GET', '/ledger?limit=20')).find((e: any) => e.delta === 300 && e.source === 'AGENT_TRANSFER');
    expect(JSON.stringify(entry)).toContain(t.finance.username);
  });

  it('refuses a return larger than the player holds, at creation', async () => {
    const r = await player.api.raw('POST', '/token-requests', { kind: 'RETURN', amount: 5000 });
    expect(r.status).toBe(400);
    const g = await player.api.at(pred()).raw('POST', '/token-requests', { kind: 'RETURN', amount: 5000 });
    expect(g.status).toBe(400);
  });

  it('a rejected request moves nothing and is logged against the employee', async () => {
    const r = await player.api.ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 400 });
    const before = [await balance(player.id), await balance(t.agent.id)];
    await t.finance.api.ok('POST', `/token-requests/${r.id}/reject`, { resolutionNote: 'not now' });
    expect([await balance(player.id), await balance(t.agent.id)]).toEqual(before);

    const log = await t.agent.api.ok('GET', '/audit?action=request.');
    expect(log.some((e: any) => e.action === 'request.reject' && e.actor.username === t.finance.username)).toBe(true);
  });
});
