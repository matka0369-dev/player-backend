/**
 * Seeds a small world through the real API into whatever stack TEST_CORE_URL /
 * TEST_PRED_URL point at, for clicking through the UI by hand:
 *   an Admin, one funded Agent with a Finance / Player-Manager / Analyst
 *   employee, two players, a live game with bets, and a pending token request.
 * Prints the logins. Run with:  npx ts-node test/support/dev-world.ts
 */
import { Api, core, pred, PASSWORD } from './api';
import { istClock } from './games';
import { makeAdmin, makeAgent, makePlayer, makeStaff, platformAdmin, roleId } from './world';

async function main() {
  process.env.TEST_CORE_URL ??= 'http://localhost:3000';
  process.env.TEST_PRED_URL ??= 'http://localhost:8080';
  process.env.TEST_PA_EMAIL ??= 'pa@test.local';
  process.env.TEST_PA_PASSWORD ??= 'Test-pa-1234!';

  const pa = await platformAdmin();
  const admin = await makeAdmin(pa);
  const agent = await makeAgent(admin.api, 50_000);
  const pm = await makeStaff(agent.api, [await roleId(pa, 'Player Manager')]);
  const fin = await makeStaff(agent.api, [await roleId(pa, 'Finance')]);
  const ana = await makeStaff(agent.api, [await roleId(pa, 'Analyst')]);
  const p1 = await makePlayer(pm.api);
  const p2 = await makePlayer(pm.api);
  for (const p of [p1, p2]) await fin.api.ok('POST', `/ledger/transfer/${p.id}`, { amount: 5000 });

  const g = await pa.ok('POST', '/games', {
    name: 'Demo Day', description: 'demo', openTime: istClock(15), closeTime: istClock(45),
    minStake: 10, maxStake: 50_000, timezone: 'Asia/Kolkata',
  });
  await pa.ok('PATCH', `/games/${g.id}`, { status: 'ACTIVE' });
  await admin.api.ok('PATCH', `/games/${g.id}/enablement`, { enabled: true });
  for (let i = 0; i < 40; i++) {
    const a = await p1.api.at(pred()).ok('GET', '/games/active');
    if (a.some((x: any) => x.gameId === g.id)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const bet = (p: typeof p1, typeId: string, n: string, stake: number) =>
    p.api.at(pred()).ok('POST', '/predictions', { gameId: g.id, typeId, pickedNumber: n, stake });
  await bet(p1, 'OPEN_SINGLE', '5', 100);
  await bet(p1, 'OPEN_SINGLE', '3', 250);
  await bet(p2, 'OPEN_SINGLE', '5', 400);
  await bet(p2, 'JODI', '47', 50);
  const r = await p1.api.ok('POST', '/token-requests', { kind: 'TOP_UP', amount: 800, note: 'for tonight' });
  await agent.api.ok('PUT', '/player-access/me/contacts', { support: '919000000001', tokens: '919000000002' });

  console.log(JSON.stringify({
    password: PASSWORD, admin: admin.username, agent: agent.username, playerManager: pm.username,
    finance: fin.username, analyst: ana.username, player1: p1.username, player2: p2.username,
    requestCode: r.shortCode, requestMessage: `PREDICTSIM-REQ v1\nid: ${r.shortCode}\nplayer: ${p1.username}\nkind: TOPUP\namount: 800\nnote: for tonight`,
  }, null, 2));
  void core; void Api;
}
main().catch((e) => { console.error(e); process.exit(1); });
