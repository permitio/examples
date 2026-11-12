// findUser against the real permitio SDK and a stand-in Permit API on a local port. The SDK logs
// every API call that answers an error status as a level-50 error, so the expected "no such user"
// answer must come from a call that succeeds.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findUser } from '@/lib/permit';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  status: number;
}

const USERS_PATH = '/v2/facts/proj-1/env-1/users';
let server: Server;
let users: Array<{ key: string; email: string }>;
let usersStatus: number;
const seen: Seen[] = [];

function answer(path: string, query: URLSearchParams): { status: number; body: unknown } {
  if (path === '/v2/api-key/scope')
    return {
      status: 200,
      body: { organization_id: 'org-1', project_id: 'proj-1', environment_id: 'env-1' },
    };
  if (path !== USERS_PATH) return { status: 404, body: { message: `no route ${path}` } };
  if (usersStatus !== 200) return { status: usersStatus, body: { message: 'unavailable' } };
  // The real API's search: a case-insensitive substring of the key or the email.
  const search = (query.get('search') ?? '').toLowerCase();
  const matches = users.filter(
    (u) => u.key.toLowerCase().includes(search) || u.email.toLowerCase().includes(search),
  );
  const page = Number(query.get('page') ?? '1');
  const perPage = Number(query.get('per_page') ?? '100');
  return {
    status: 200,
    body: {
      data: matches.slice((page - 1) * perPage, page * perPage),
      total_count: matches.length,
      page_count: Math.ceil(matches.length / perPage),
    },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { status, body } = answer(url.pathname, url.searchParams);
    seen.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, status });
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
