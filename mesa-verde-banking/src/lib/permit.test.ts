// findUser and openAccount against the real permitio SDK and a stand-in Permit API on a local
// port. The SDK logs every API call that answers an error status as a level-50 error, so the
// expected "no such user" and "already there" answers must come from calls that succeed.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findUser, openAccount } from '@/lib/permit';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  status: number;
}
interface Reply {
  status: number;
  body: unknown;
}

const FACTS = '/v2/facts/proj-1/env-1';
const USERS_PATH = `${FACTS}/users`;
let server: Server;
let users: Array<{ key: string; email: string }>;
let usersStatus: number;
let tenants: Array<{ key: string; name: string }>;
let assignments: Array<{ user: string; role: string; tenant: string }>;
const seen: Seen[] = [];

/** One page of `rows` that contain `search` in one of `fields`, as the real API searches. */
function searched<T>(rows: T[], query: URLSearchParams, fields: (row: T) => string[]) {
  const search = (query.get('search') ?? '').toLowerCase();
  const matches = rows.filter((row) => fields(row).some((f) => f.toLowerCase().includes(search)));
  const page = Number(query.get('page') ?? '1');
  const perPage = Number(query.get('per_page') ?? '100');
  return {
    data: matches.slice((page - 1) * perPage, page * perPage),
    total_count: matches.length,
    page_count: Math.ceil(matches.length / perPage),
  };
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const conflict = (what: string): Reply => ({ status: 409, body: { message: `${what} exists` } });

function answer(method: string, path: string, query: URLSearchParams, body: unknown): Reply {
  const sent = (body ?? {}) as Record<string, string>;
  const route = `${method} ${path.startsWith(FACTS) ? path.slice(FACTS.length) : path}`;
  const tenantUsers = /^GET \/tenants\/([^/]+)\/users$/.exec(route);
  if (route === 'GET /v2/api-key/scope')
    return ok({ organization_id: 'org-1', project_id: 'proj-1', environment_id: 'env-1' });
  if (route === 'GET /users') {
    if (usersStatus !== 200) return { status: usersStatus, body: { message: 'unavailable' } };
    return ok(searched(users, query, (u) => [u.key, u.email]));
  }
  if (route.startsWith('PUT /users/')) {
    const key = decodeURIComponent(route.slice('PUT /users/'.length));
    if (!users.some((u) => u.key === key)) users.push({ key, email: sent['email'] ?? key });
    return ok({ key });
  }
  // Without include_total_count the tenant list is a bare array.
  if (route === 'GET /tenants') return ok(searched(tenants, query, (t) => [t.key, t.name]).data);
  if (route === 'POST /tenants') {
    if (tenants.some((t) => t.key === sent['key'])) return conflict(`tenant ${sent['key']}`);
    tenants.push({ key: sent['key'] ?? '', name: sent['name'] ?? '' });
    return ok(sent);
  }
  if (tenantUsers) {
    const holders = assignments.filter(
      (a) => a.tenant === tenantUsers[1] && a.role === query.get('role'),
    );
    return ok({ data: holders.map((a) => ({ key: a.user })), total_count: holders.length });
  }
  if (route === 'POST /role_assignments') {
    const assignment = {
      user: sent['user'] ?? '',
      role: sent['role'] ?? '',
      tenant: sent['tenant'] ?? '',
    };
    if (assignments.some((a) => JSON.stringify(a) === JSON.stringify(assignment)))
      return conflict('role assignment');
    assignments.push(assignment);
    return ok(assignment);
  }
  return { status: 404, body: { message: `no route ${route}` } };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let text = '';
    for await (const chunk of req) text += String(chunk);
    const method = req.method ?? '';
    const { status, body } = answer(
      method,
      url.pathname,
      url.searchParams,
      text === '' ? undefined : JSON.parse(text),
    );
    seen.push({ method, path: url.pathname, query: url.searchParams, status });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // getPermit() reads the settings on its first call, which comes after this.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['PERMIT_API_URL'] = url;
  process.env['PERMIT_PDP_URL'] = url;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  users = [];
  usersStatus = 200;
  tenants = [];
  assignments = [];
  seen.length = 0;
});

const userCalls = () => seen.filter((s) => s.path === USERS_PATH);

describe('findUser', () => {
  it('answers undefined for a user Permit does not have, with no API call failing', async () => {
    users = [{ key: 'alice@mesaverde.example', email: 'alice@mesaverde.example' }];

    expect(await findUser('carol@mesaverde.example')).toBeUndefined();

    expect(seen.filter((s) => s.status >= 400)).toEqual([]);
    expect(userCalls().map((s) => [s.method, s.query.get('search')])).toEqual([
      ['GET', 'carol@mesaverde.example'],
    ]);
  });

  it('finds the user whose key is the one asked for, not one whose key only contains it', async () => {
    users = [
      { key: 'xcarol@mesaverde.example', email: 'xcarol@mesaverde.example' },
      { key: 'carol@mesaverde.example', email: 'carol@mesaverde.example' },
    ];

    expect(await findUser('carol@mesaverde.example')).toMatchObject({
      key: 'carol@mesaverde.example',
    });
    expect(await findUser('arol@mesaverde.example')).toBeUndefined();
  });

  it('reads the next page when the user is not on the first one', async () => {
    users = Array.from({ length: 150 }, (_, i) => ({
      key: `${i}carol@mesaverde.example`,
      email: `${i}carol@mesaverde.example`,
    }));
    users.push({ key: 'carol@mesaverde.example', email: 'carol@mesaverde.example' });

    expect(await findUser('carol@mesaverde.example')).toMatchObject({
      key: 'carol@mesaverde.example',
    });
    expect(userCalls().map((s) => s.query.get('page'))).toEqual(['1', '2']);
  });

  it('still fails when the Permit API fails', async () => {
    usersStatus = 503;

    await expect(findUser('carol@mesaverde.example')).rejects.toMatchObject({
      response: { status: 503 },
    });
  });
});

describe('openAccount', () => {
  const CAROL = 'carol@mesaverde.example';
  const ACCOUNT = 'carol-mesaverde-example';
  const failed = () => seen.filter((s) => s.status >= 400).map((s) => `${s.method} ${s.path}`);
  const owner = { user: CAROL, role: 'AccountOwner', tenant: ACCOUNT };

  it('opens a new account with no API call failing', async () => {
    await openAccount(CAROL, 'US');

    expect(tenants.map((t) => t.key)).toEqual([ACCOUNT]);
    expect(users.map((u) => u.key)).toEqual([CAROL]);
    expect(assignments).toEqual([owner]);
    expect(failed()).toEqual([]);
  });

  it('finishes an account a failed visit left with only its tenant, with no API call failing', async () => {
    tenants = [
      { key: `x${ACCOUNT}`, name: `x${CAROL}` },
      { key: ACCOUNT, name: CAROL },
    ];

    await openAccount(CAROL, undefined);

    expect(tenants).toHaveLength(2);
    expect(assignments).toEqual([owner]);
    expect(failed()).toEqual([]);
  });

  it('runs again on a finished account with no API call failing and nothing written twice', async () => {
    await openAccount(CAROL, 'US');
    seen.length = 0;

    await openAccount(CAROL, 'US');

    expect(assignments).toEqual([owner]);
    expect(failed()).toEqual([]);
  });

  it('refuses an account another user owns, without writing', async () => {
    tenants = [{ key: ACCOUNT, name: CAROL }];
    assignments = [{ user: 'mallory@example.com', role: 'AccountOwner', tenant: ACCOUNT }];

    await expect(openAccount(CAROL, undefined)).rejects.toThrow(
      `The account ${ACCOUNT} already belongs to another user`,
    );
    expect(users).toEqual([]);
    expect(failed()).toEqual([]);
  });
});
