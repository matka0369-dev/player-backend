import { makePlayer, makeTeam, type Account, type Team } from './support/world';
import { core, Api, PASSWORD } from './support/api';

type World = Team & { pa: Api };

describe('agent employees: who may do what', () => {
  let t: World;
  let player: Account;

  beforeAll(async () => {
    t = await makeTeam(50_000);
    player = await makePlayer(t.playerMgr.api);
  });

  describe('creating players', () => {
    it('the owner agent cannot create a player, but can hire staff', async () => {
      const r = await t.agent.api.raw('POST', '/users', {
        email: 'o@t.local', username: 'ownerply', password: PASSWORD, accountType: 'PLAYER',
      });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.data)).toMatch(/player:create/);
    });

    it('staff without the role are refused; with it, the player lands under the owner agent', async () => {
      const denied = await t.bare.api.raw('POST', '/users', {
        email: 'b@t.local', username: 'bareply', password: PASSWORD, accountType: 'PLAYER',
      });
      expect(denied.status).toBe(403);

      const rec = await t.agent.api.ok('GET', `/users/${player.id}`);
      expect(rec.agentId ?? rec.agent?.id).toBe(t.agent.id);
    });

    it('a player-manager cannot create staff or admins', async () => {
      const r = await t.playerMgr.api.raw('POST', '/users', {
        email: 's@t.local', username: 'sneaky', password: PASSWORD, accountType: 'AGENT_STAFF',
      });
      expect(r.status).toBe(403);
    });
  });

  describe('moving tokens', () => {
    it('refuses the owner agent and a role-less employee', async () => {
      expect((await t.agent.api.raw('POST', `/ledger/transfer/${player.id}`, { amount: 100 })).status).toBe(403);
      expect((await t.bare.api.raw('POST', `/ledger/transfer/${player.id}`, { amount: 100 })).status).toBe(403);
      expect((await t.playerMgr.api.raw('POST', `/ledger/transfer/${player.id}`, { amount: 100 })).status).toBe(403);
    });

    it('lets Finance move the agent\'s tokens and records who did it', async () => {
      await t.finance.api.ok('POST', `/ledger/transfer/${player.id}`, { amount: 1500, note: 'opening' });

      expect((await t.agent.api.ok('GET', `/users/${t.agent.id}`)).balance).toBe(50_000 - 1500);
      expect((await t.agent.api.ok('GET', `/users/${player.id}`)).balance).toBe(1500);

      const ledger = await t.agent.api.ok('GET', '/ledger?limit=20');
      const row = ledger.find((e: any) => e.delta === 1500 && e.source === 'AGENT_TRANSFER');
      expect(JSON.stringify(row)).toContain(t.finance.username);
    });

    it('cannot overdraw the agent, or touch another agent\'s player', async () => {
      expect((await t.finance.api.raw('POST', `/ledger/transfer/${player.id}`, { amount: 9_000_000 })).status).toBe(400);
      const other = await makeTeam(10);
      const foreign = await makePlayer(other.playerMgr.api);
      expect((await t.finance.api.raw('POST', `/ledger/transfer/${foreign.id}`, { amount: 5 })).status).toBe(404);
    });

    it('reclaims tokens with a negative amount', async () => {
      await t.finance.api.ok('POST', `/ledger/transfer/${player.id}`, { amount: -500 });
      expect((await t.agent.api.ok('GET', `/users/${player.id}`)).balance).toBe(1000);
    });
  });

  describe('token requests', () => {
    let requestId: string;

    it('the player asks for a top-up', async () => {
      const r = await player.api.ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 700, note: 'need more' });
      requestId = r.id;
    });

    it('the owner, a role-less employee and a player-manager cannot approve it', async () => {
      for (const who of [t.agent, t.bare, t.playerMgr]) {
        expect((await who.api.raw('POST', `/token-requests/${requestId}/approve`, {})).status).toBe(403);
      }
    });

    it('Finance approves: the agent\'s wallet pays, the player receives', async () => {
      const agentBefore = (await t.agent.api.ok('GET', `/users/${t.agent.id}`)).balance;
      await t.finance.api.ok('POST', `/token-requests/${requestId}/approve`, { resolutionNote: 'ok' });
      expect((await t.agent.api.ok('GET', `/users/${t.agent.id}`)).balance).toBe(agentBefore - 700);
      expect((await t.agent.api.ok('GET', `/users/${player.id}`)).balance).toBe(1700);
      // and it cannot be approved twice
      expect((await t.finance.api.raw('POST', `/token-requests/${requestId}/approve`, {})).status).toBe(409);
    });
  });

  describe('prediction data needs prediction:view', () => {
    it('hides it from employees without the permission', async () => {
      for (const path of ['/predictions', '/predictions/aggregate', '/predictions/settlements', '/ledger']) {
        expect((await t.bare.api.raw('GET', path)).status).toBe(403);
        expect((await t.finance.api.raw('GET', path)).status).toBe(403);
      }
    });
    it('shows it to the Analyst and to the owner agent', async () => {
      for (const path of ['/predictions', '/predictions/aggregate', '/predictions/settlements', '/ledger']) {
        expect((await t.analyst.api.raw('GET', path)).status).toBe(200);
        expect((await t.agent.api.raw('GET', path)).status).toBe(200);
      }
    });
  });

  describe('activity log', () => {
    it('attributes every action to the employee who did it', async () => {
      const log = await t.agent.api.ok('GET', '/audit?limit=200');
      const by = (action: string) => log.filter((r: any) => r.action === action).map((r: any) => r.actor?.username);

      expect(by('user.create')).toEqual(expect.arrayContaining([t.playerMgr.username]));
      expect(by('tokens.transfer')).toEqual(expect.arrayContaining([t.finance.username]));
      expect(by('request.approve')).toEqual([t.finance.username]);
      // hiring the staff was the owner's own doing
      expect(by('user.create')).toEqual(expect.arrayContaining([t.agent.username]));
    });

    it('filters by employee and is invisible to employees and to other agents', async () => {
      const mine = await t.agent.api.ok('GET', `/audit?actorId=${t.finance.id}`);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((r: any) => r.actor.id === t.finance.id)).toBe(true);

      expect((await t.finance.api.raw('GET', '/audit')).status).toBe(403);

      const other = await makeTeam(10);
      const theirs = await other.agent.api.ok('GET', '/audit');
      expect(theirs.some((r: any) => r.actor?.id === t.finance.id)).toBe(false);
    });
  });

  describe('what the team can see', () => {
    it('a Finance employee can read the agent\'s wallet, others get none', async () => {
      const own = await t.agent.api.ok('GET', `/users/${t.agent.id}`);
      const wallet = await t.finance.api.ok('GET', '/ledger/wallet');
      expect(wallet.balance).toBe(own.balance);
      expect((await player.api.raw('GET', '/ledger/wallet')).status).toBe(403);
    });

    it('the roster shows each employee\'s roles', async () => {
      const roster = await t.agent.api.ok('GET', '/users');
      const fin = roster.find((u: any) => u.id === t.finance.id);
      expect(fin.roles.map((r: any) => r.role.name)).toEqual(['Finance']);
      expect(roster.find((u: any) => u.id === t.bare.id).roles).toEqual([]);
    });
  });

  describe('roles after creation', () => {
    it('the agent can assign and remove a role, and the change is logged', async () => {
      const analystRole = (await t.agent.api.ok('GET', '/roles')).find((r: any) => r.name === 'Analyst').id;
      await t.agent.api.ok('POST', `/users/${t.bare.id}/roles`, { roleId: analystRole });
      expect((await t.bare.api.raw('GET', '/predictions')).status).toBe(200);

      await t.agent.api.ok('DELETE', `/users/${t.bare.id}/roles/${analystRole}`);
      expect((await t.bare.api.raw('GET', '/predictions')).status).toBe(403);

      const log = await t.agent.api.ok('GET', '/audit?action=role.');
      expect(log.map((r: any) => r.action)).toEqual(expect.arrayContaining(['role.assign', 'role.unassign']));
    });
  });
});
void core;
