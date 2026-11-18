/** Builders for the account hierarchy, going through the real API each time. */
import { Api, core, PASSWORD, uniq } from './api';

export interface Account {
  api: Api;
  id: string;
  username: string;
  email: string;
}

export async function platformAdmin(): Promise<Api> {
  return new Api(core()).login(process.env.TEST_PA_EMAIL!, process.env.TEST_PA_PASSWORD!);
}

async function create(creator: Api, accountType: string, prefix: string, extra: Record<string, unknown> = {}): Promise<Account> {
  const username = uniq(prefix);
  const email = `${username}@t.local`;
  const rec = await creator.ok('POST', '/users', { email, username, password: PASSWORD, accountType, ...extra });
  const api = await new Api(core()).login(email, PASSWORD);
  return { api, id: rec.id, username, email };
}

export const makeAdmin = (pa: Api) => create(pa, 'ADMIN', 'adm');

export async function makeAgent(admin: Api, float = 0): Promise<Account> {
  const agent = await create(admin, 'AGENT', 'agt');
  if (float > 0) await admin.ok('POST', `/ledger/grant/${agent.id}`, { amount: float, note: 'float' });
  return agent;
}

export async function roleId(pa: Api, name: string): Promise<string> {
  const roles = await pa.ok('GET', '/roles');
  const r = roles.find((x: any) => x.name === name);
  if (!r) throw new Error(`role not found: ${name}`);
  return r.id;
}

export const makeStaff = (agent: Api, roleIds: string[] = []) =>
  create(agent, 'AGENT_STAFF', 'stf', { roleIds });

/** `creator` must be an Agent employee holding player:create. */
export const makePlayer = (creator: Api) => create(creator, 'PLAYER', 'ply');

export interface Team {
  admin: Account;
  agent: Account;
  /** Holds the "Player Manager" role: creates players. */
  playerMgr: Account;
  /** Holds the "Finance" role: moves tokens, approves requests. */
  finance: Account;
  /** Holds the "Analyst" role: reads predictions and totals. */
  analyst: Account;
  /** Has no role at all. */
  bare: Account;
}

/** An Admin, one funded Agent, and one employee per role — the usual cast. */
export async function makeTeam(float = 100_000): Promise<Team & { pa: Api }> {
  const pa = await platformAdmin();
  const admin = await makeAdmin(pa);
  const agent = await makeAgent(admin.api, float);
  const [pm, fin, ana] = await Promise.all([
    roleId(pa, 'Player Manager'), roleId(pa, 'Finance'), roleId(pa, 'Analyst'),
  ]);
  return {
    pa,
    admin,
    agent,
    playerMgr: await makeStaff(agent.api, [pm]),
    finance: await makeStaff(agent.api, [fin]),
    analyst: await makeStaff(agent.api, [ana]),
    bare: await makeStaff(agent.api, []),
  };
}
