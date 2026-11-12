import type { Permit, UserRead } from 'permitio';

type ResourceInstanceRead = Awaited<ReturnType<Permit['api']['resourceInstances']['getById']>>;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/account/webhook/route';
import { appRequest } from '@/test/auth';
import { permitApiError } from '@/test/fake-permit';
import { fakePermit } from '@/test/permit-client';

vi.mock('permitio', async (original) => ({
  ...(await original<typeof import('permitio')>()),
  Permit: (await import('@/test/fake-permit')).FakePermit,
}));

const SECRET = 'test-only-webhook-secret-5f2b';
const TENANT = 'alice-mesaverde-example';

const event = (status: string) => ({
  status,
  reviewer_user_id: 'reviewer-id',
  requesting_user_id: 'requester-id',
  operation_approval_details: { tenant: TENANT, resource_instance: 'instance-id' },
});

/** Sends an event; `authorization: null` sends none. */
function webhook(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  return POST(
    appRequest('/account/webhook', {
      method: 'POST',
      body,
      ...(authorization === null ? {} : { headers: { authorization } }),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env['WEBHOOK_SECRET'] = SECRET;
});

afterEach(() => {
  delete process.env['WEBHOOK_SECRET'];
});

describe('POST /account/webhook', () => {
  it('answers 404 when the webhook is not set up', async () => {
    delete process.env['WEBHOOK_SECRET'];
    expect((await webhook(event('approved'))).status).toBe(404);
  });

  it('answers 401 without the bearer token, or with another one', async () => {
    for (const authorization of [null, '', SECRET, 'Bearer nope', `Basic ${SECRET}`]) {
      expect((await webhook(event('approved'), authorization)).status).toBe(401);
    }
    expect(fakePermit().api.resourceInstances.getById).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not an approval event', async () => {
    expect((await webhook({ status: 'approved' })).status).toBe(400);
  });

  it('deletes the pending wire transfer when the owner denies it', async () => {
    const response = await webhook(event('denied'));
    expect(response.status).toBe(200);
    expect(fakePermit().api.resourceInstances.delete).toHaveBeenCalledWith('instance-id');
    expect(fakePermit().api.resourceInstances.create).not.toHaveBeenCalled();
  });

  it('records an approved transfer, sent by the approver, with who made and approved it', async () => {
    const permit = fakePermit();
    const transfer = {
      id: 'w-1',
      date: '2026-11-01T10:00:00.000Z',
      description: 'Tuition',
      amount: 4000,
      currency: '£',
      to: 'dave-mesaverde-example',
    };
    permit.api.resourceInstances.getById.mockResolvedValue({
      attributes: transfer,
    } as unknown as ResourceInstanceRead);
    permit.api.users.getById.mockImplementation(async (id) =>
      id === 'reviewer-id'
        ? ({ key: 'alice@mesaverde.example', email: 'alice@mesaverde.example' } as UserRead)
        : ({ key: 'bob@mesaverde.example', email: 'bob@mesaverde.example' } as UserRead),
    );
    permit.api.tenants.listTenantUsers.mockResolvedValue({
      data: [{ key: 'dave@mesaverde.example' } as UserRead],
      total_count: 1,
      page_count: 1,
    });
    const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'error')];

    const response = await webhook(event('approved'));

    expect(response.status).toBe(200);
    const attributes = {
      ...transfer,
      description:
        'Tuition | Made by: bob@mesaverde.example | Approved by: alice@mesaverde.example',
    };
    expect(permit.api.resourceInstances.create).toHaveBeenCalledWith({
      resource: 'Transaction',
      key: 'w-1',
      tenant: TENANT,
      attributes,
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      role: 'Sender',
      tenant: TENANT,
      resource_instance: 'Transaction:w-1',
      user: 'alice@mesaverde.example',
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      role: 'Receiver',
      tenant: TENANT,
      resource_instance: 'Transaction:w-1',
      user: 'dave@mesaverde.example',
    });
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    }
  });

  it('answers 400 when the wire transfer has no transfer attributes', async () => {
    const permit = fakePermit();
    permit.api.resourceInstances.getById.mockResolvedValue({
      attributes: { id: 'w-2' },
    } as unknown as ResourceInstanceRead);
    permit.api.users.getById.mockResolvedValue({ key: 'k' } as UserRead);
    expect((await webhook(event('approved'))).status).toBe(400);
    expect(permit.api.resourceInstances.create).not.toHaveBeenCalled();
  });

  it('answers 502 without logging the secret when Permit fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().api.resourceInstances.delete.mockRejectedValue(permitApiError(500));
    expect((await webhook(event('denied'))).status).toBe(502);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
  });
});
