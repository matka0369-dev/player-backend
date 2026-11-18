import { makeTeam, type Account } from './support/world';

describe('agent contact numbers: a field left out is left alone', () => {
  let agent: Account;

  beforeAll(async () => {
    agent = (await makeTeam(0)).agent;
  });

  const contacts = async () => (await agent.api.ok('GET', '/player-access/me')).contacts;

  it('sets both numbers', async () => {
    await agent.api.ok('PUT', '/player-access/me/contacts', { support: '919876543210', tokens: '919876543211' });
    expect(await contacts()).toEqual({ support: '919876543210', tokens: '919876543211' });
  });

  it('changing only tokens keeps support (regression: it used to clear it)', async () => {
    await agent.api.ok('PUT', '/player-access/me/contacts', { tokens: '918008937297' });
    expect(await contacts()).toEqual({ support: '919876543210', tokens: '918008937297' });
  });

  it('null clears just that one', async () => {
    await agent.api.ok('PUT', '/player-access/me/contacts', { support: null });
    expect(await contacts()).toEqual({ support: null, tokens: '918008937297' });
  });
});
