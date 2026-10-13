import { PermitConnectionError, PermitPDPStatusError } from 'permitio';
import { describe, expect, it, vi } from 'vitest';
import { couldNotRun, describeError, HttpError, syncUser, upsert } from '#scripts/lib/admin';
import { MissingEnvError } from '#scripts/lib/env';

const networkError = (code: string) =>
  Object.assign(new Error(`connect ${code} 127.0.0.1:7766`), { code });

describe('upsert', () => {
  it('returns created when create resolves, without calling update', async () => {
    const update = vi.fn(async () => undefined);
    await expect(
      upsert('role org_admin', async () => ({ key: 'org_admin' }), update),
    ).resolves.toBe('created');
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back to update on 409 and returns updated', async () => {
    const update = vi.fn(async () => undefined);
    await expect(
      upsert('role org_admin', () => Promise.reject({ status: 409 }), update),
    ).resolves.toBe('updated');
    expect(update).toHaveBeenCalledOnce();
  });

  it('rethrows any other create error with the label prefixed, without calling update', async () => {
    const update = vi.fn(async () => undefined);
    await expect(
      upsert('role org_admin', () => Promise.reject(new HttpError('boom', 422)), update),
    ).rejects.toThrow('role org_admin: boom');
    expect(update).not.toHaveBeenCalled();
  });

  it('labels a failed fallback update too', async () => {
    await expect(
      upsert(
        'tenant preflight',
        () => Promise.reject({ status: 409 }),
        () => Promise.reject(new Error('update refused')),
      ),
    ).rejects.toThrow('tenant preflight: update refused');
  });

  it('keeps the original error as the cause, so a network failure still reads as could-not-run', async () => {
    const failure = await upsert(
      'tenant preflight',
      () => Promise.reject(networkError('ECONNREFUSED')),
      async () => undefined,
    ).catch((e: unknown) => e);
    expect(couldNotRun(failure)).toBe(true);
  });
});

describe('couldNotRun (exit 2) versus a failure (exit 1)', () => {
  it.each([
    ['a missing profile variable', new MissingEnvError(['PERMIT_API_KEY'])],
    ['an unreachable PDP', new PermitConnectionError('cannot connect to the PDP')],
    ['a PDP that answers 503', new PermitPDPStatusError('unexpected status code: 503', 503)],
    ['a PDP that rejects the key', new PermitPDPStatusError('unexpected status code: 401', 401)],
    ['an API that rejects the key', new HttpError('unauthorized', 401)],
    ['an API answering 502', new HttpError('bad gateway', 502)],
    ['a refused connection', networkError('ECONNREFUSED')],
    ['an unknown host', networkError('ENOTFOUND')],
    ['a failed fetch', new TypeError('fetch failed', { cause: networkError('ECONNREFUSED') })],
  ])('could not run: %s', (_name, err) => {
    expect(couldNotRun(err)).toBe(true);
  });

  it.each([
    ['a payload the API rejects', new HttpError('unprocessable', 422)],
    ['a missing object', new HttpError('not found', 404)],
    ['a check input the PDP rejects', new PermitPDPStatusError('unexpected status code: 400', 400)],
    ['a plain bug', new Error('cannot read properties of undefined')],
  ])('fails: %s', (_name, err) => {
    expect(couldNotRun(err)).toBe(false);
  });
});

describe('describeError', () => {
  it("keeps the API's own explanation from the response body", () => {
    const err = Object.assign(new Error('Request failed with status code 422'), {
      status: 422,
      response: { data: { message: 'attribute type mismatch' } },
    });
    const text = describeError(err);
    expect(text).toContain('Request failed with status code 422');
    expect(text).toContain('attribute type mismatch');
  });

  it('names the cause of a failed fetch', () => {
    expect(
      describeError(new TypeError('fetch failed', { cause: networkError('ECONNREFUSED') })),
    ).toContain('ECONNREFUSED');
  });
});

describe('syncUser for a user who belongs to a tenant without a role', () => {
  const aragorn = {
    key: 'aragorn',
    first_name: 'Aragorn',
    last_name: '',
    attributes: { time_based_grants: [] },
    tenant: 'shire-freight',
  };
  function fakePermit(existing: unknown) {
    const calls: string[] = [];
    const users = {
      get: vi.fn(async () => {
        if (existing === undefined) throw Object.assign(new Error('not found'), { status: 404 });
        return existing;
      }),
      update: vi.fn(async () => {
        calls.push('update');
      }),
      delete: vi.fn(async () => {
        calls.push('delete');
      }),
      sync: vi.fn(async () => {
        calls.push('sync');
        return { created: false };
      }),
    };
    const tenants = {
      addUser: vi.fn(async (tenant: string, user: { key: string }) => {
        calls.push(`addUser ${tenant} ${user.key}`);
      }),
    };
    return { permit: { api: { users, tenants } } as never, calls, tenants };
  }

  it('creates the user inside the tenant when Permit does not have them', async () => {
    const f = fakePermit(undefined);
    await expect(syncUser(f.permit, aragorn)).resolves.toBe('created');
    expect(f.calls).toEqual(['addUser shire-freight aragorn']);
    // The tenant is the path, not a field of the user Permit stores.
    expect(f.tenants.addUser).toHaveBeenCalledWith('shire-freight', {
      key: 'aragorn',
      first_name: 'Aragorn',
      last_name: '',
      attributes: { time_based_grants: [] },
    });
  });

  it('deletes and re-creates a user found outside the tenant, since Permit cannot move one in', async () => {
    const f = fakePermit({ key: 'aragorn', associated_tenants: [] });
    await expect(syncUser(f.permit, aragorn)).resolves.toBe('created');
    expect(f.calls).toEqual(['delete', 'addUser shire-freight aragorn']);
  });

  it('patches a user already in the tenant, so the membership stays', async () => {
    const f = fakePermit({
      key: 'aragorn',
      associated_tenants: [{ tenant: 'shire-freight', roles: [], status: 'active' }],
    });
    await expect(syncUser(f.permit, aragorn)).resolves.toBe('updated');
    expect(f.calls).toEqual(['update']);
  });

  it('rethrows a lookup failure other than 404 without writing anything', async () => {
    const f = fakePermit(undefined);
    (f.permit as unknown as { api: { users: { get: () => Promise<never> } } }).api.users.get =
      async () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      };
    await expect(syncUser(f.permit, aragorn)).rejects.toThrow('boom');
    expect(f.calls).toEqual([]);
  });
});
