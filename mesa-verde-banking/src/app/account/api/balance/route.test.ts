import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/account/api/balance/route';
import { demoBalance } from '@/lib/accounts';
import { appRequest, prepareDatabase, signedIn } from '@/test/auth';
import { permitApiError } from '@/test/fake-permit';
import { fakePermit } from '@/test/permit-client';

vi.mock('permitio', async (original) => ({
  ...(await original<typeof import('permitio')>()),
  Permit: (await import('@/test/fake-permit')).FakePermit,
}));

let cookie: string;

beforeAll(async () => {
  await prepareDatabase();
  cookie = await signedIn('alice@mesaverde.example');
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /account/api/balance', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(appRequest('/account/api/balance?tenant=alice'));
    expect(response.status).toBe(401);
    expect(fakePermit().check).not.toHaveBeenCalled();
  });

  it('answers 400 for a missing or malformed account', async () => {
    for (const query of ['', '?tenant=', '?tenant=a%20b', '?tenant=../x']) {
      const response = await GET(appRequest(`/account/api/balance${query}`, { cookie }));
      expect(response.status).toBe(400);
    }
    expect(fakePermit().check).not.toHaveBeenCalled();
  });

  it('asks Permit whether the user may read the account and answers the balance', async () => {
    fakePermit().check.mockResolvedValue(true);
    const response = await GET(appRequest('/account/api/balance?tenant=alice', { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ balance: demoBalance('alice'), currency: '£' });
    expect(fakePermit().check).toHaveBeenCalledWith('alice@mesaverde.example', 'read', {
      type: 'Account',
      tenant: 'alice',
    });
  });

  it('answers 403 when Permit denies', async () => {
    fakePermit().check.mockResolvedValue(false);
    const response = await GET(appRequest('/account/api/balance?tenant=bob', { cookie }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  it('answers 502 when the PDP cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().check.mockRejectedValue(permitApiError(500));
    const response = await GET(appRequest('/account/api/balance?tenant=alice', { cookie }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Permit request failed' });
  });
});
