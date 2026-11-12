import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/account/api/frontend-permissions/[tenant]/route';
import { appRequest, prepareDatabase, signedIn } from '@/test/auth';
import { permitApiError } from '@/test/fake-permit';
import { fakePermit } from '@/test/permit-client';

vi.mock('permitio', async (original) => ({
  ...(await original<typeof import('permitio')>()),
  Permit: (await import('@/test/fake-permit')).FakePermit,
}));

const TENANT = 'alice-mesaverde-example';
let cookie: string;

beforeAll(async () => {
  await prepareDatabase();
  cookie = await signedIn('bob@mesaverde.example');
});

beforeEach(() => {
  vi.resetAllMocks();
});

function bulkCheck(body: unknown, tenant = TENANT, withSession = true) {
  return POST(
    appRequest(`/account/api/frontend-permissions/${tenant}?user=someone-else`, {
      method: 'POST',
      body,
      ...(withSession ? { cookie } : {}),
    }),
    { params: Promise.resolve({ tenant }) },
  );
}

describe('POST /account/api/frontend-permissions/[tenant]', () => {
  it('answers 401 without a session', async () => {
    const response = await bulkCheck({ resourcesAndActions: [] }, TENANT, false);
    expect(response.status).toBe(401);
  });

  it('answers 400 for a bad account key or body', async () => {
    const statement = { action: 'read', resource: 'Account' };
    const bad = [
      bulkCheck({ resourcesAndActions: [statement] }, 'bad key'),
      bulkCheck({}),
      bulkCheck({ resourcesAndActions: [] }),
      bulkCheck({ resourcesAndActions: Array.from({ length: 21 }, () => statement) }),
      bulkCheck({ resourcesAndActions: [{ action: 'read' }] }),
    ];
    for (const response of bad) {
      expect((await response).status).toBe(400);
    }
  });

  it('checks the signed-in user, ignoring the user and attributes the browser sends', async () => {
    fakePermit().bulkCheck.mockResolvedValue([true, false, true]);
    const response = await bulkCheck({
      resourcesAndActions: [
        { action: 'read', resource: 'Account', userAttributes: { strongAuth: true } },
        { action: 'create', resource: 'Wire_Transfer', resourceAttributes: { amount: 100 } },
        { action: 'list', resource: 'Transaction:t-1' },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ permittedList: [true, false, true] });
    expect(fakePermit().bulkCheck).toHaveBeenCalledWith([
      {
        user: 'bob@mesaverde.example',
        action: 'read',
        resource: { type: 'Account', tenant: TENANT, attributes: {} },
      },
      {
        user: 'bob@mesaverde.example',
        action: 'create',
        resource: { type: 'Wire_Transfer', tenant: TENANT, attributes: { amount: 100 } },
      },
      {
        user: 'bob@mesaverde.example',
        action: 'list',
        resource: { type: 'Transaction', key: 't-1', tenant: TENANT, attributes: {} },
      },
    ]);
  });

  it('answers 502 when the PDP fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().bulkCheck.mockRejectedValue(permitApiError(500));
    const response = await bulkCheck({ resourcesAndActions: [{ action: 'read', resource: 'A' }] });
    expect(response.status).toBe(502);
  });
});
