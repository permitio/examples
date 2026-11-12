import type { Permit, UserRead } from 'permitio';
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { GET, POST } from '@/app/account/api/transactions/route';
import { upsertCustomer } from '@/lib/customers';
import { getDatabase } from '@/lib/db';
import { appRequest, prepareDatabase, signedIn } from '@/test/auth';
import { permitApiError } from '@/test/fake-permit';
import { fakePermit } from '@/test/permit-client';

vi.mock('permitio', async (original) => ({
  ...(await original<typeof import('permitio')>()),
  Permit: (await import('@/test/fake-permit')).FakePermit,
}));

const DAVE = 'dave@mesaverde.example';
const FROM = 'dave-mesaverde-example';
const TO = 'alice-mesaverde-example';
let cookie: string;

beforeAll(async () => {
  await prepareDatabase();
  cookie = await signedIn(DAVE);
  upsertCustomer(getDatabase(), { email: DAVE, country: 'US', location: 'FR' });
});

beforeEach(() => {
  vi.resetAllMocks();
});

/** Account owners: each tenant's owner is the user its key was made from. */
function ownersByTenant() {
  fakePermit().api.tenants.listTenantUsers.mockImplementation(async ({ tenantKey }) => ({
    data: [{ key: tenantKey.replace('-mesaverde-example', '@mesaverde.example') } as UserRead],
    total_count: 1,
    page_count: 1,
  }));
}

function transfer(body: Record<string, unknown>, tenant = FROM): Request {
  return appRequest(`/account/api/transactions?tenant=${tenant}`, {
    method: 'POST',
    cookie,
    body,
  });
}

/** Answers checks by resource type: `read` on Account, `create` on Wire_Transfer, Transaction. */
function decide(answers: {
  account?: boolean;
  wire?: boolean;
  transaction?: (strong: boolean) => boolean;
}) {
  fakePermit().check.mockImplementation(async (user, _action, resource) => {
    const type = typeof resource === 'string' ? resource : resource.type;
    if (type === 'Account') return answers.account ?? true;
    if (type === 'Wire_Transfer') return answers.wire ?? true;
    const strong = typeof user !== 'string' && user.attributes?.['strongAuth'] === true;
    return answers.transaction?.(strong) ?? true;
  });
}

const SMALL = { to: TO, amount: 250, description: 'Groceries' };
const LARGE = { to: TO, amount: 5000, description: 'Car' };

describe('GET /account/api/transactions', () => {
  it('answers 401 without a session and 400 without an account', async () => {
    expect((await GET(appRequest(`/account/api/transactions?tenant=${FROM}`))).status).toBe(401);
    expect((await GET(appRequest('/account/api/transactions', { cookie }))).status).toBe(400);
  });

  it('answers 403 when Permit denies listing the transactions', async () => {
    fakePermit().check.mockResolvedValue(false);
    const response = await GET(appRequest(`/account/api/transactions?tenant=${TO}`, { cookie }));
    expect(response.status).toBe(403);
    expect(fakePermit().check).toHaveBeenCalledWith(DAVE, 'list', {
      type: 'Transaction',
      tenant: TO,
    });
  });

  it("lists the owner's Transaction instances in the account, newest first", async () => {
    const permit = fakePermit();
    permit.check.mockResolvedValue(true);
    ownersByTenant();
    const attributes = (id: string, date: string) => ({
      id,
      date,
      description: `Transfer ${id}`,
      amount: 10,
      currency: '£',
    });
    permit.getUserPermissions.mockResolvedValue({
      '__tenant:dave-mesaverde-example': { permissions: ['Account:read'], roles: ['AccountOwner'] },
      'Transaction:old': {
        permissions: ['Transaction:list'],
        roles: ['Sender'],
        resource: { type: 'Transaction', key: 'old', attributes: attributes('old', '2026-01-01') },
      },
      'Transaction:new': {
        permissions: ['Transaction:list'],
        roles: ['Receiver'],
        resource: { type: 'Transaction', key: 'new', attributes: attributes('new', '2026-02-01') },
      },
      'Transaction:broken': {
        permissions: ['Transaction:list'],
        roles: ['Sender'],
        resource: { type: 'Transaction', key: 'broken', attributes: { id: 'broken' } },
      },
    } satisfies Awaited<ReturnType<Permit['getUserPermissions']>>);

    const response = await GET(appRequest(`/account/api/transactions?tenant=${FROM}`, { cookie }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { ...attributes('new', '2026-02-01'), direction: 'in' },
      { ...attributes('old', '2026-01-01'), direction: 'out' },
    ]);
    expect(permit.getUserPermissions).toHaveBeenCalledWith(DAVE, [FROM], [], ['Transaction']);
  });

  it('answers an empty list for an account without an owner', async () => {
    fakePermit().check.mockResolvedValue(true);
    fakePermit().api.tenants.listTenantUsers.mockResolvedValue({
      data: [],
      total_count: 0,
      page_count: 0,
    });
    const response = await GET(appRequest(`/account/api/transactions?tenant=${FROM}`, { cookie }));
    expect(await response.json()).toEqual([]);
  });

  it('answers 502 when the PDP fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().check.mockRejectedValue(permitApiError(500));
    const response = await GET(appRequest(`/account/api/transactions?tenant=${FROM}`, { cookie }));
    expect(response.status).toBe(502);
  });
});

describe('POST /account/api/transactions', () => {
  let codes: MockInstance<typeof console.info>;

  beforeEach(() => {
    codes = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    ownersByTenant();
    fakePermit().api.resourceInstances.create.mockResolvedValue(
      {} as Awaited<ReturnType<Permit['api']['resourceInstances']['create']>>,
    );
  });

  /** The code the email-OTP plugin wrote to the log last. */
  function lastCode(): string {
    const line = String(codes.mock.calls.at(-1)?.[0] ?? '');
    const code = /One-time code for \S+: (\d{6})/.exec(line)?.[1];
    if (code === undefined) throw new Error(`No one-time code in the log line: ${line}`);
    return code;
  }

  it('answers 401 without a session', async () => {
    const response = await POST(
      appRequest(`/account/api/transactions?tenant=${FROM}`, { method: 'POST', body: SMALL }),
    );
    expect(response.status).toBe(401);
  });

  it('answers 400 for a bad account, body, amount or code, or a transfer to itself', async () => {
    const bad = [
      transfer(SMALL, 'not a key'),
      appRequest(`/account/api/transactions?tenant=${FROM}`, {
        method: 'POST',
        cookie,
        body: 'not json',
      }),
      transfer({ ...SMALL, amount: -5 }),
      transfer({ ...SMALL, amount: '5' }),
      transfer({ ...SMALL, description: '  ' }),
      transfer({ ...SMALL, otp: '12ab56' }),
      transfer({ ...SMALL, to: FROM }),
    ];
    for (const request of bad) {
      expect((await POST(request)).status).toBe(400);
    }
    expect(fakePermit().check).not.toHaveBeenCalled();
  });

  it('records an allowed transfer as a Transaction with its Sender and Receiver', async () => {
    const permit = fakePermit();
    decide({});

    const response = await POST(transfer(SMALL));

    expect(response.status).toBe(200);
    const { status, transaction } = (await response.json()) as {
      status: string;
      transaction: Record<string, unknown>;
    };
    expect(status).toBe('sent');
    expect(transaction).toMatchObject({ ...SMALL, currency: '£' });
    const id = String(transaction['id']);
    expect(permit.check).toHaveBeenNthCalledWith(1, DAVE, 'read', {
      type: 'Account',
      tenant: FROM,
    });
    expect(permit.check).toHaveBeenNthCalledWith(2, DAVE, 'create', {
      type: 'Wire_Transfer',
      tenant: FROM,
      attributes: transaction,
    });
    expect(permit.check).toHaveBeenNthCalledWith(
      3,
      { key: DAVE, attributes: { strongAuth: false, location: 'FR' } },
      'create',
      { type: 'Transaction', tenant: FROM, attributes: transaction },
    );
    expect(permit.api.resourceInstances.create).toHaveBeenCalledWith({
      resource: 'Transaction',
      key: id,
      tenant: FROM,
      attributes: transaction,
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      role: 'Sender',
      tenant: FROM,
      resource_instance: `Transaction:${id}`,
      user: DAVE,
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      role: 'Receiver',
      tenant: FROM,
      resource_instance: `Transaction:${id}`,
      user: 'alice@mesaverde.example',
    });
  });

  it('refuses a user outside the account without starting an approval', async () => {
    const permit = fakePermit();
    decide({ account: false, wire: false });

    const response = await POST(transfer({ ...LARGE, to: 'bob-mesaverde-example' }, TO));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'denied' });
    expect(permit.api.resourceInstances.create).not.toHaveBeenCalled();
    expect(permit.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('starts an operation approval when the wire transfer is denied', async () => {
    const permit = fakePermit();
    decide({ wire: false });

    const response = await POST(transfer({ ...LARGE, to: 'bob-mesaverde-example' }, TO));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; transfer: string };
    expect(body.status).toBe('approval_required');
    expect(permit.check).toHaveBeenCalledTimes(2);
    expect(permit.api.resourceInstances.create).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'Wire_Transfer', key: body.transfer, tenant: TO }),
    );
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      role: '_Reviewer_',
      tenant: TO,
      resource_instance: `Wire_Transfer:${body.transfer}`,
      user: 'alice@mesaverde.example',
    });
  });

  it('asks for a one-time code, then accepts the transfer with it, once', async () => {
    const permit = fakePermit();
    // Wire transfer allowed; the Transaction only with strong authentication.
    decide({ transaction: (strong) => strong });

    const first = await POST(transfer(LARGE));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'strong_auth_required' });
    expect(permit.api.resourceInstances.create).not.toHaveBeenCalled();
    const code = lastCode();

    const second = await POST(transfer({ ...LARGE, otp: code }));
    expect(second.status).toBe(200);
    expect(permit.check).toHaveBeenLastCalledWith(
      { key: DAVE, attributes: { strongAuth: true, location: 'FR' } },
      'create',
      expect.objectContaining({ type: 'Transaction' }),
    );

    const replay = await POST(transfer({ ...LARGE, otp: code }));
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'invalid_code' });
  });

  it('refuses a wrong code without asking Permit', async () => {
    const permit = fakePermit();
    decide({ transaction: () => false });
    await POST(transfer(LARGE));
    const wrong = lastCode() === '000000' ? '111111' : '000000';

    const response = await POST(transfer({ ...LARGE, otp: wrong }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'invalid_code' });
    expect(permit.check).toHaveBeenCalledTimes(3);
  });

  it('answers denied when the transfer is refused even with a valid code', async () => {
    decide({ transaction: () => false });
    await POST(transfer(LARGE));

    const response = await POST(transfer({ ...LARGE, otp: lastCode() }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'denied' });
  });

  it('answers 404 for an account without an owner', async () => {
    fakePermit().check.mockResolvedValue(true);
    fakePermit().api.tenants.listTenantUsers.mockResolvedValue({
      data: [],
      total_count: 0,
      page_count: 0,
    });
    expect((await POST(transfer(SMALL))).status).toBe(404);
  });

  it('answers 502 when recording the transaction fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().check.mockResolvedValue(true);
    fakePermit().api.resourceInstances.create.mockRejectedValue(permitApiError(500));
    expect((await POST(transfer(SMALL))).status).toBe(502);
  });
});
