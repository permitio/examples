import type { TenantRead } from 'permitio';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/account/api/tenants/all/route';
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
  cookie = await signedIn('bob@mesaverde.example');
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /account/api/tenants/all', () => {
  it('answers 401 without a session', async () => {
    expect((await GET(appRequest('/account/api/tenants/all'))).status).toBe(401);
  });

  it("lists every account's key and name, without Permit's default tenant", async () => {
    fakePermit().api.tenants.list.mockResolvedValue([
      { key: 'default', name: 'Default Tenant', id: 'x' } as TenantRead,
      { key: 'alice-mesaverde-example', name: 'alice@mesaverde.example', id: 'y' } as TenantRead,
    ]);
    const response = await GET(appRequest('/account/api/tenants/all', { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { key: 'alice-mesaverde-example', name: 'alice@mesaverde.example' },
    ]);
  });

  it('answers 502 when Permit fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().api.tenants.list.mockRejectedValue(permitApiError(500));
    expect((await GET(appRequest('/account/api/tenants/all', { cookie }))).status).toBe(502);
  });
});
