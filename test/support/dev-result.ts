import { istClock, istDate, makeGame, seedBets } from './games';
import { makePlayer, makeTeam } from './world';
(async () => {
  process.env.TEST_CORE_URL ??= 'http://localhost:3000';
  process.env.TEST_PRED_URL ??= 'http://localhost:8080';
  process.env.TEST_PA_EMAIL ??= 'pa@test.local';
  process.env.TEST_PA_PASSWORD ??= 'Test-pa-1234!';
  process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
  const t = await makeTeam(20000);
  const p = await makePlayer(t.playerMgr.api);
  await t.finance.api.ok('POST', `/ledger/transfer/${p.id}`, { amount: 5000 });
  const game = await makeGame(t.pa, t.admin.api, istClock(-240), istClock(-120));
  const bets = [['JODI','05',50],['JODI','12',40],['JODI','13',30],['JODI','19',20],['JODI','47',60],['JODI','63',80],['OPEN_SINGLE','1',100],['OPEN_SINGLE','5',50],['OPEN_SINGLE_PANA','128',30]] as const;
  await seedBets(game, bets.map(([typeId, picked, stake]) => ({ userId: p.id, typeId, picked, stake, odds: 9 })));
  await t.pa.ok('POST', `/games/${game.id}/result`, { date: istDate(0), openPana: '128' });
  console.log(JSON.stringify({ admin: t.admin.username, game: game.id }));
})();
