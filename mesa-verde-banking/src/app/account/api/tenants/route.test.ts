import type { TenantRead, UserRead } from 'permitio';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/account/api/tenants/route';
import { upsertCustomer } from '@/lib/customers';
import { getDatabase } from '@/lib/db';
import { appRequest, prepareDatabase, signedIn } from '@/test/auth';
import { permitApiError } from '@/test/fake-permit';
import { fakePermit } from '@/test/permit-client';

vi.mock('permitio', async (original) => ({
  ...(await original<typeof import('permitio')>()),
  Permit: (await import('@/test/fake-permit')).FakePermit,
}));

const EMAIL = 'carol@mesaverde.example';
let cookie: string;

function user(associated: Array<{ tenant: string; roles: string[] }>): UserRead {
  return {
    key: EMAIL,
    email: EMAIL,
    associated_tenants: associated.map(({ tenant, roles }) => ({
      tenant,
      roles,
      status: 'active',
    })),
  } as unknown as UserRead;
}

/** One page of the user search, as the Permit API answers it. */
function found(...users: UserRead[]) {
  return { data: users, total_count: users.length, page_count: users.length === 0 ? 0 : 1 };
}

function tenant(key: string, name: string): TenantRead {
  return { key, name } as TenantRead;
}

beforeAll(async () => {
  await prepareDatabase();
  cookie = await signedIn(EMAIL);
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /account/api/tenants', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(appRequest('/account/api/tenants'));
    expect(response.status).toBe(401);
  });

  it('lists the accounts the user holds an account role in, owned first', async () => {
    const permit = fakePermit();
    permit.api.users.list.mockResolvedValue(
      found(
        user([
          { tenant: 'alice-mesaverde-example', roles: ['AccountMember'] },
          { tenant: 'carol-mesaverde-example', roles: ['AccountOwner'] },
          // A transaction's Receiver role, not an account role.
          { tenant: 'dave-mesaverde-example', roles: ['Receiver'] },
        ]),
      ),
    );
    permit.api.tenants.get.mockImplementation(async (key) =>
      tenant(key, key.replace('-mesaverde-example', '@mesaverde.example')),
    );

    const response = await GET(appRequest('/account/api/tenants', { cookie }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { key: 'carol-mesaverde-example', name: 'carol@mesaverde.example', role: 'AccountOwner' },
      { key: 'alice-mesaverde-example', name: 'alice@mesaverde.example', role: 'AccountMember' },
    ]);
    expect(permit.api.tenants.create).not.toHaveBeenCalled();
  });

  it("opens a new user's own account in Permit on their first visit", async () => {
    const permit = fakePermit();
    upsertCustomer(getDatabase(), { email: EMAIL, country: 'US', location: 'US' });
    permit.api.users.list
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce(
        found(user([{ tenant: 'carol-mesaverde-example', roles: ['AccountOwner'] }])),
      );
    permit.api.tenants.get.mockResolvedValue(tenant('carol-mesaverde-example', EMAIL));

    const response = await GET(appRequest('/account/api/tenants', { cookie }));

    expect(response.status).toBe(200);
    expect(permit.api.tenants.create).toHaveBeenCalledWith({
      key: 'carol-mesaverde-example',
      name: EMAIL,
    });
    expect(permit.api.users.sync).toHaveBeenCalledWith({
      key: EMAIL,
      email: EMAIL,
      attributes: { country: 'US' },
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      role: 'AccountOwner',
      tenant: 'carol-mesaverde-example',
      user: EMAIL,
    });
    expect(await response.json()).toEqual([
      { key: 'carol-mesaverde-example', name: EMAIL, role: 'AccountOwner' },
    ]);
  });

  it('refuses to take over an account another user already owns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const permit = fakePermit();
    permit.api.users.list.mockResolvedValue(found());
    permit.api.tenants.create.mockRejectedValue(permitApiError(409));
    permit.api.tenants.listTenantUsers.mockResolvedValue({
      data: [{ key: 'someone-else@example.com' } as UserRead],
      total_count: 1,
      page_count: 1,
    });

    const response = await GET(appRequest('/account/api/tenants', { cookie }));

    expect(response.status).toBe(502);
    expect(permit.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('answers 502 when Permit fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().api.users.list.mockRejectedValue(permitApiError(503));
    const response = await GET(appRequest('/account/api/tenants', { cookie }));
    expect(response.status).toBe(502);
  });
});
