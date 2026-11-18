import { Api, core, pred, PASSWORD, uniq } from './support/api';

describe('harness smoke', () => {
  it('boots both servers on the throwaway database and runs Admin -> Agent -> grant', async () => {
    expect((await fetch(`${pred()}/healthz`)).ok).toBe(true);

    const pa = await new Api(core()).login(process.env.TEST_PA_EMAIL!, process.env.TEST_PA_PASSWORD!);
    const adminName = uniq('adm');
    await pa.ok('POST', '/users', {
      email: `${adminName}@t.local`, username: adminName, password: PASSWORD, accountType: 'ADMIN',
    });
    const admin = await new Api(core()).login(`${adminName}@t.local`, PASSWORD);

    const agentName = uniq('agt');
    const agentRec = await admin.ok('POST', '/users', {
      email: `${agentName}@t.local`, username: agentName, password: PASSWORD, accountType: 'AGENT',
    });
    await admin.ok('POST', `/ledger/grant/${agentRec.id}`, { amount: 1000, note: 'float' });

    const agent = await new Api(core()).login(`${agentName}@t.local`, PASSWORD);
    const me = await agent.ok('GET', `/users/${agent.id}`);
    expect(me.balance).toBe(1000);
  });
});
