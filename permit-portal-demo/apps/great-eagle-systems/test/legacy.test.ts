// S8's legacy billing app: its own rule, the mapping that turns its privileges into Permit grants,
// the comparison of the two sides, and the routes that enforce by mode. Permit is a double that
// decides view_billing from role assignments the way the real model does, so what is under test is
// what the legacy app asks and what it does with the answers.
import { Script } from 'node:vm';
import express from 'express';
import { type ICheckQuery, type IResource, type IUser, PermitConnectionError } from 'permitio';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '#src/app';
import { answerErrors } from '#src/http';
import { accessLog, compare } from '#src/legacy/compare';
import { grantsFor, loadMapping } from '#src/legacy/mapping';
import { type LegacyPermit, legacyPermit, type RoleWrite } from '#src/legacy/permit';
import { legacyAllows } from '#src/legacy/rule';
import type { PortalNotifier } from '#src/portal-notifier';
import { s8Router } from '#src/routes-s8';
import { type LegacyUser, loadSeed, type SeedAccount } from '#src/seed';
import { Store } from '#src/store';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');
const seed = loadSeed();
const USERS = seed.legacy.users;
const ACCOUNTS = seed.accounts;
const mapping = loadMapping();

const legacyUser = (key: string): LegacyUser => {
  const found = USERS.find((u) => u.key === key);
  if (!found) throw new Error(`no legacy user ${key}`);
  return found;
};
const account = (key: string): SeedAccount => {
  const found = ACCOUNTS.find((a) => a.key === key);
  if (!found) throw new Error(`no account ${key}`);
  return found;
};
/** The legacy rule as `compare` takes it: user and account by key. */
const legacyRule = (user: string, accountKey: string) =>
  legacyAllows(
    USERS.find((u) => u.key === user),
    account(accountKey),
  );

// --- Permit, as the legacy app meets it ---

interface Grant {
  user: string;
  role: string;
  resource?: string;
}
/** The users Permit knows. Fatty and Lobelia are not among them. */
const DIRECTORY = ['sam', 'frodo', 'pippin', 'merry'];

/**
 * Whether Permit lets `user` view billing on `target`: the org admin rule, an account manager, or
 * an EAN's account admin.
 */
function permitAllows(grants: readonly Grant[], user: string, target: SeedAccount): boolean {
  return grants.some(
    (g) =>
      g.user === user &&
      (g.role === 'org_admin' || // the "Verified org admin" rule: Sam's facts are in order
        (g.role === 'account_manager' && g.resource === `account:${target.key}`) ||
        (g.role === 'account_admin' && g.resource === `ean:${target.ean}`)),
  );
}

/** What Permit holds once mapping `version` is synced: the grants of the users it knows. */
const permitAfterSync = (version: 1 | 2): Grant[] =>
  grantsFor(version, USERS, ACCOUNTS, mapping).filter((g) => DIRECTORY.includes(g.user));

/** `compare`'s `permit` callback over a Permit that holds `grants`. */
const askingPermit =
  (grants: readonly Grant[]) => async (pairs: ReadonlyArray<{ user: string; account: string }>) =>
    pairs.map((p) => permitAllows(grants, p.user, account(p.account)));

/**
 * The Permit SDK as the legacy app uses it, over a directory of users and role assignments. It
 * starts as Permit does after the seed: Sam and Frodo hold what mapping v1 gives them. It records
 * every question and every write asked of it. Like staging, it answers a role the user holds
 * already with success, not 409, and holds it once.
 */
class FakePermit implements LegacyPermit {
  readonly directory = new Set(DIRECTORY);
  /**
   * The attributes of the users in the directory that carry any; a connector is marked
   * `principal_type: 'integration'`.
   */
  readonly attributes = new Map<string, Record<string, unknown>>();
  readonly grants: Grant[] = permitAfterSync(1);
  /** Set, Permit cannot be reached: every check and every read fails with it. */
  down: Error | undefined;
  /** Set, reading a user's role assignments fails with it, while the rest of Permit answers. */
  assignmentsDown: Error | undefined;
  /** Every user whose role assignments the legacy app read. */
  readonly assignmentsRead: string[] = [];
  /** Decides, per write, whether it fails (and how) instead of being applied. */
  failWrite: ((write: RoleWrite) => Error | undefined) | undefined;
  readonly asked: ICheckQuery[] = [];
  bulkCalls = 0;
  /** Every page of users the legacy app asked Permit for. */
  readonly listed: Array<{ search: string; page: number }> = [];
  /**
   * Set, Permit's list of users always answers its first page, whatever page and search it is asked
   * for.
   */
  ignoresPages = false;
  /** Every `waitForSync` the legacy app made, as [timeout, policy]. */
  readonly waits: Array<readonly [number, string]> = [];
  /** Every write attempted, applied or not. */
  readonly writes: RoleWrite[] = [];

  async check(user: IUser, action: string, resource: IResource): Promise<boolean> {
    this.reachable();
    this.asked.push({ user, action, resource });
    return this.decide({ user, action, resource });
  }

  async bulkCheck(checks: ICheckQuery[]): Promise<boolean[]> {
    this.reachable();
    this.bulkCalls += 1;
    this.asked.push(...checks);
    return checks.map((c) => this.decide(c));
  }

  readonly api: LegacyPermit['api'] = {
    users: {
      list: async ({ search, page, perPage }) => {
        this.reachable();
        this.listed.push({ search, page });
        const row = (key: string) => ({
          key,
          ...(this.attributes.has(key) ? { attributes: { ...this.attributes.get(key) } } : {}),
        });
        if (this.ignoresPages) return { data: [...this.directory].slice(0, perPage).map(row) };
        const matching = [...this.directory].filter((key) => key.includes(search));
        return { data: matching.slice((page - 1) * perPage, page * perPage).map(row) };
      },
      waitForSync: (timeout, policy) => {
        this.waits.push([timeout, policy]);
        return {
          assignRole: async (write: RoleWrite) => {
            this.writes.push(write);
            const fault = this.failWrite?.(write);
            if (fault) throw fault;
            const grant: Grant = {
              user: write.user,
              role: write.role,
              ...(write.resource_instance === undefined
                ? {}
                : { resource: write.resource_instance }),
            };
            // Staging answers a role held already with success, and holds it once.
            if (
              !this.grants.some(
                (g) =>
                  g.user === grant.user && g.role === grant.role && g.resource === grant.resource,
              )
            )
              this.grants.push(grant);
            return {};
          },
        };
      },
    },
    roleAssignments: {
      list: async ({ user, tenant, page, perPage }) => {
        this.reachable();
        if (this.assignmentsDown) throw this.assignmentsDown;
        this.assignmentsRead.push(user);
        // A role in the tenant comes with resource_instance null, as the wire may carry it.
        const rows =
          tenant === 'shire-freight'
            ? this.grants
                .filter((g) => g.user === user)
                .map((g) => ({ role: g.role, resource_instance: g.resource ?? null }))
            : [];
        return rows.slice((page - 1) * perPage, page * perPage);
      },
    },
  };

  /** Takes a role away, as Sam does in S2's Team access. */
  revoke(user: string, role: string, resource: string): void {
    const at = this.grants.findIndex(
      (g) => g.user === user && g.role === role && g.resource === resource,
    );
    if (at < 0) throw new Error(`${user} holds no ${role} on ${resource}`);
    this.grants.splice(at, 1);
  }

  private reachable(): void {
    if (this.down) throw this.down;
  }

  private decide(c: ICheckQuery): boolean {
    const user = typeof c.user === 'string' ? c.user : c.user.key;
    const resource = c.resource as IResource;
    const target = ACCOUNTS.find((a) => a.key === resource.key);
    return (
      c.action === 'view_billing' &&
      resource.type === 'account' &&
      resource.tenant === 'shire-freight' &&
      target !== undefined &&
      permitAllows(this.grants, user, target)
    );
  }
}

const unreachable = () => new PermitConnectionError('connect ECONNREFUSED 127.0.0.1:7000');

function setup() {
  const permit = new FakePermit();
  const store = new Store(loadSeed(), { at: NOW });
  const clock = { now: NOW };
  const app = express();
  app.use(express.json());
  app.use(s8Router({ store, seed: loadSeed(), env: {}, permit, now: () => clock.now }));
  // The router throws its refusals; app.ts answers them with this handler, last.
  app.use(answerErrors);
  return { app, permit, store, clock };
}

const ask = (app: express.Express, user: string, accountKey: string) =>
  request(app).post('/api/legacy/requests').send({ user, account: accountKey });
const setMode = (app: express.Express, mode: string) =>
  request(app).put('/api/legacy/mode').send({ mode });

// --- The legacy app's own logic ---

describe('the legacy rule', () => {
  it('allows admins, EAN codes and child-account codes', () => {
    const allowedOn = (user: LegacyUser | undefined) => ACCOUNTS.map((a) => legacyAllows(user, a));
    // ACCOUNTS: Hobbiton and Bywater under EAN-1001, Michel Delving under EAN-1002.

    // the admin flag
    expect(allowedOn(legacyUser('sam'))).toEqual([true, true, true]);
    // an admin flag left over from a helpdesk ticket
    expect(allowedOn(legacyUser('fatty'))).toEqual([true, true, true]);
    // EAN-1001: its two child accounts, not the other EAN's
    expect(allowedOn(legacyUser('frodo'))).toEqual([true, true, false]);
    // the child-account code CA-1001-A: that account only
    expect(allowedOn(legacyUser('pippin'))).toEqual([true, false, false]);
    // two EAN codes
    expect(allowedOn(legacyUser('lobelia'))).toEqual([true, true, true]);
    expect(
      allowedOn({ key: 'nobody', name: 'Nobody', is_admin: false, accounts: [], note: '' }),
    ).toEqual([false, false, false]);
  });

  it('denies a user the legacy table does not know', () => {
    expect(ACCOUNTS.map((a) => legacyAllows(undefined, a))).toEqual([false, false, false]);
  });
});

describe('the mapping', () => {
  it('v1 skips child-account codes, v2 maps them to account_manager', () => {
    const v1 = grantsFor(1, USERS, ACCOUNTS, mapping);
    const v2 = grantsFor(2, USERS, ACCOUNTS, mapping);
    expect(v1).toEqual([
      { user: 'sam', role: 'org_admin' },
      { user: 'frodo', role: 'account_admin', resource: 'ean:EAN-1001' },
      { user: 'lobelia', role: 'account_admin', resource: 'ean:EAN-1001' },
      { user: 'lobelia', role: 'account_admin', resource: 'ean:EAN-1002' },
    ]);
    // The one line v2 adds: Pippin's child-account code. Everything else stays, in the same order.
    expect(v2).toEqual([
      { user: 'sam', role: 'org_admin' },
      { user: 'frodo', role: 'account_admin', resource: 'ean:EAN-1001' },
      { user: 'pippin', role: 'account_manager', resource: 'account:CA-1001-A' },
      { user: 'lobelia', role: 'account_admin', resource: 'ean:EAN-1001' },
      { user: 'lobelia', role: 'account_admin', resource: 'ean:EAN-1002' },
    ]);
  });

  it('unconfirmed admins and unknown users are never mapped', async () => {
    // Fatty has the admin flag, but the owner confirmed only Sam as an organization admin.
    for (const version of [1, 2] as const) {
      expect(
        grantsFor(version, USERS, ACCOUNTS, mapping).filter((g) => g.user === 'fatty'),
      ).toEqual([]);
    }
    // Someone the owner confirmed who is not in the legacy table has nothing to translate.
    const withGhost = {
      ...mapping,
      versions: {
        ...mapping.versions,
        '2': { ...mapping.versions['2'], confirmed_admins: ['sam', 'ghost'] },
      },
    };
    expect(grantsFor(2, USERS, ACCOUNTS, withGhost).filter((g) => g.user === 'ghost')).toEqual([]);
    // A flag that was cleared translates to nothing, whoever confirmed it.
    const cleared = USERS.map((u) => (u.key === 'sam' ? { ...u, is_admin: false } : u));
    expect(grantsFor(2, cleared, ACCOUNTS, mapping).filter((g) => g.role === 'org_admin')).toEqual(
      [],
    );
    // A code that is neither an EAN nor a child account of the master is not translated.
    const codes = {
      key: 'stray',
      name: 'Stray',
      is_admin: false,
      accounts: ['EAN-9999', 'CA-9999-Z'],
      note: '',
    };
    expect(grantsFor(2, [codes], ACCOUNTS, mapping)).toEqual([]);

    // And a user Permit does not know is skipped when the mapping is written: Lobelia has two
    // grants and receives none.
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    const synced = await request(app).post('/api/legacy/sync').expect(200);
    expect(permit.writes.map((w) => w.user)).not.toContain('lobelia');
    expect(permit.writes.map((w) => w.user)).not.toContain('fatty');
    expect(synced.body.skipped).toBe(2);
    expect(
      synced.body.grants
        .filter((g: { status: string }) => g.status === 'skipped')
        .map((g: { user: string }) => g.user),
    ).toEqual(['lobelia', 'lobelia']);
  });
});

describe('the access log', () => {
  it('holds every user on every account, 13 times each, in a fixed order', () => {
    const log = accessLog(USERS, ACCOUNTS);
    expect(log).toHaveLength(USERS.length * ACCOUNTS.length * 13);
    // One round is the cross product in table order, and the log is 13 rounds of it.
    const round = USERS.flatMap((u) => ACCOUNTS.map((a) => ({ user: u.key, account: a.key })));
    expect(log.slice(0, round.length)).toEqual(round);
    expect(log.slice(round.length, 2 * round.length)).toEqual(round);
    for (const pair of round)
      expect(log.filter((e) => e.user === pair.user && e.account === pair.account)).toHaveLength(
        13,
      );
    expect(accessLog(USERS, ACCOUNTS)).toEqual(log);
  });
});

// --- The comparison ---

describe('the comparison', () => {
  const log = () => accessLog(USERS, ACCOUNTS);
  const compareWith = (grants: readonly Grant[]) =>
    compare(log(), legacyRule, askingPermit(grants), mapping.approved_tightenings);
  const FATTY = { reason: 'Admin flag not confirmed by the owner', approved_by: 'sam' };
  const LOBELIA = { reason: 'Left the company', approved_by: 'sam' };

  it('v1 produces the three mismatch groups, two of them expected', async () => {
    const { rows, summary } = await compareWith(permitAfterSync(1));
    expect(summary).toEqual({
      total: 195,
      matches: 104,
      mismatches: 91,
      unexpected: 13,
      could_not_check: 0,
      groups: [
        // Pippin's child-account code is not translated: nothing approved covers it.
        { user: 'pippin', count: 13 },
        { user: 'fatty', count: 39, expected: FATTY },
        { user: 'lobelia', count: 39, expected: LOBELIA },
      ],
    });
    expect(summary.groups.filter((g) => g.expected === undefined).map((g) => g.user)).toEqual([
      'pippin',
    ]);
    expect(rows).toHaveLength(195);
    const pippinOnHobbiton = rows.find((r) => r.user === 'pippin' && r.account === 'CA-1001-A');
    expect(pippinOnHobbiton).toEqual({
      user: 'pippin',
      account: 'CA-1001-A',
      legacy: true,
      permit: false,
      outcome: 'mismatch',
    });
    expect(pippinOnHobbiton).not.toHaveProperty('expected');
    expect(rows.find((r) => r.user === 'fatty' && r.account === 'CA-1002-A')).toEqual({
      user: 'fatty',
      account: 'CA-1002-A',
      legacy: true,
      permit: false,
      outcome: 'mismatch',
      expected: FATTY,
    });
    // A match carries no approval, and the users the mapping got right never appear in a group.
    expect(rows.find((r) => r.user === 'frodo' && r.account === 'CA-1001-A')).toEqual({
      user: 'frodo',
      account: 'CA-1001-A',
      legacy: true,
      permit: true,
      outcome: 'match',
    });
  });

  it('v2 leaves no unexpected group', async () => {
    const { summary } = await compareWith(permitAfterSync(2));
    expect(summary.groups).toEqual([
      { user: 'fatty', count: 39, expected: FATTY },
      { user: 'lobelia', count: 39, expected: LOBELIA },
    ]);
    expect(summary.groups.filter((g) => g.expected === undefined)).toEqual([]);
    expect(summary).toMatchObject({
      total: 195,
      matches: 117,
      mismatches: 78,
      unexpected: 0,
      could_not_check: 0,
    });
  });

  it('an unreachable PDP is reported, not counted', async () => {
    // Nothing checked is nothing unexpected either: the count is of mismatches, and an unanswered
    // question is none.
    const everyRowUnchecked = {
      total: 195,
      matches: 0,
      mismatches: 0,
      unexpected: 0,
      could_not_check: 195,
      groups: [],
    };
    const noAnswers = async (pairs: ReadonlyArray<unknown>) => pairs.map(() => null);
    const refused = async (): Promise<never> => {
      throw unreachable();
    };
    // An answer for the wrong number of questions cannot be lined up with them, so it answers none
    // of them.
    const misaligned = async () => [true];
    for (const permit of [noAnswers, refused, misaligned]) {
      const { rows, summary } = await compare(
        log(),
        legacyRule,
        permit,
        mapping.approved_tightenings,
      );
      expect(summary).toEqual(everyRowUnchecked);
      expect(rows.every((r) => r.permit === null && r.outcome === 'could_not_check')).toBe(true);
      expect(rows.some((r) => 'expected' in r)).toBe(false);
    }
  });

  it('counts only the questions Permit left unanswered as unchecked', async () => {
    const answers = askingPermit(permitAfterSync(2));
    // Permit answers everything except Lobelia's rows: those are neither denied nor matched.
    const partial = async (pairs: ReadonlyArray<{ user: string; account: string }>) => {
      const all = await answers(pairs);
      return all.map((answer, i) => (pairs[i]?.user === 'lobelia' ? null : answer));
    };
    const { summary } = await compare(log(), legacyRule, partial, mapping.approved_tightenings);
    expect(summary).toMatchObject({
      total: 195,
      matches: 117,
      mismatches: 39,
      could_not_check: 39,
    });
    expect(summary.groups).toEqual([{ user: 'fatty', count: 39, expected: FATTY }]);
  });

  it('excuses only tightenings: an approved user whom Permit now allows more than the legacy app is still unexpected', async () => {
    // Legacy denies everyone, Permit allows everyone: every mismatch loosens access, and Fatty's
    // approval is for a tightening.
    const { rows, summary } = await compare(
      log(),
      () => false,
      async (pairs) => pairs.map(() => true),
      mapping.approved_tightenings,
    );
    expect(summary.groups.every((g) => g.expected === undefined)).toBe(true);
    expect(rows.some((r) => 'expected' in r)).toBe(false);
  });

  it('marks a group expected only when every one of its mismatches is an approved tightening', async () => {
    // Fatty is denied on one account by Permit (a tightening) and allowed where the legacy app
    // denies (a loosening).
    const legacy = (user: string, target: string) =>
      user === 'fatty' ? target !== 'CA-1002-A' : legacyRule(user, target);
    const permit = async (pairs: ReadonlyArray<{ user: string; account: string }>) =>
      pairs.map((p) => (p.user === 'fatty' ? p.account === 'CA-1002-A' : false));
    const { summary } = await compare(log(), legacy, permit, mapping.approved_tightenings);
    const fatty = summary.groups.find((g) => g.user === 'fatty');
    expect(fatty).toBeDefined();
    expect(fatty).not.toHaveProperty('expected');
  });
});

// --- The routes ---

describe('the legacy app state', () => {
  it('starts in shadow mode with the first mapping, the users table and the child accounts', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/legacy/state').expect(200);
    expect(res.body).toMatchObject({
      mode: 'shadow',
      mappingVersion: 1,
      validations: 0,
      recent: [],
    });
    expect(res.body.users).toEqual(USERS);
    expect(res.body.accounts).toEqual(ACCOUNTS);
    expect(res.body.mapping).toEqual(mapping.versions['1']);
  });

  it('records each decision, newest first, and keeps the last 20', async () => {
    const { app, clock } = setup();
    const at = (n: number) => new Date(NOW + n * 1000).toISOString();
    // Twenty-five requests a second apart, then Frodo's on Michel Delving: 26 decisions, each a
    // second after the last.
    for (let n = 1; n <= 25; n += 1) {
      clock.now = NOW + n * 1000;
      await ask(
        app,
        n % 2 === 0 ? 'sam' : 'pippin',
        n % 3 === 0 ? 'CA-1001-A' : 'CA-1001-B',
      ).expect(200);
    }
    clock.now = NOW + 26 * 1000;
    await ask(app, 'frodo', 'CA-1002-A').expect(200);
    const { recent } = (await request(app).get('/api/legacy/state')).body;
    // The 26th is first and the 7th last: the first six have dropped off the end.
    expect(recent.map((d: { at: string }) => d.at)).toEqual(
      Array.from({ length: 20 }, (_, k) => at(26 - k)),
    );
    expect(recent[0]).toEqual({
      at: at(26),
      user: 'frodo',
      account: 'CA-1002-A',
      legacy: false,
      permit: false,
      enforced: false,
      mode: 'shadow',
    });
    expect(recent[1]).toMatchObject({ at: at(25), user: 'pippin', account: 'CA-1001-B' });
  });

  it('puts the legacy app back in shadow mode with the first mapping, and forgets its decisions, when the systems are reset', async () => {
    const store = new Store(loadSeed(), { at: NOW });
    const notifier: PortalNotifier = {
      factsChanged: async () => ({ ok: true }),
      runCleanup: async () => ({ removed: 0 }),
    };
    const app = createApp({ store, notifier, now: () => NOW, seed: loadSeed(), env: {} });
    await request(app).put('/api/legacy/mode').send({ mode: 'both' }).expect(200);
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    await request(app)
      .post('/api/legacy/requests')
      .send({ user: 'sam', account: 'CA-1001-A' })
      .expect(200);
    expect((await request(app).get('/api/legacy/state')).body).toMatchObject({
      mode: 'both',
      mappingVersion: 2,
    });
    expect((await request(app).get('/api/legacy/state')).body.recent).toHaveLength(1);

    await request(app).post('/api/admin/reset').expect(200);
    const after = (await request(app).get('/api/legacy/state')).body;
    expect(after).toMatchObject({ mode: 'shadow', mappingVersion: 1, validations: 0, recent: [] });
    // Decisions made after the reset are listed again.
    await request(app)
      .post('/api/legacy/requests')
      .send({ user: 'sam', account: 'CA-1001-A' })
      .expect(200);
    expect((await request(app).get('/api/legacy/state')).body.recent).toHaveLength(1);
  });
});

describe('a request to the legacy app', () => {
  it('asks Permit view_billing on the child account in shire-freight, shaped like every check', async () => {
    const { app, permit } = setup();
    await ask(app, 'frodo', 'CA-1001-A').expect(200);
    expect(permit.asked).toEqual([
      {
        user: { key: 'frodo', attributes: { current_time: NOW } },
        action: 'view_billing',
        resource: {
          type: 'account',
          key: 'CA-1001-A',
          tenant: 'shire-freight',
          attributes: { id: 'CA-1001-A' },
        },
      },
    ]);
  });

  it('shadow mode lets the legacy rule decide and records what Permit said', async () => {
    const { app } = setup();
    // Fatty's old admin flag: the legacy app allows, Permit would not, and the legacy answer is
    // what is enforced.
    expect((await ask(app, 'fatty', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: false,
      enforced: true,
      mode: 'shadow',
    });
    // Pippin has no role in Permit yet on the account the legacy table names: the two sides
    // disagree, the legacy rule wins.
    expect((await ask(app, 'pippin', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: false,
      enforced: true,
      mode: 'shadow',
    });
    expect((await ask(app, 'frodo', 'CA-1002-A')).body).toEqual({
      legacy: false,
      permit: false,
      enforced: false,
      mode: 'shadow',
    });
  });

  it('shadow mode keeps the legacy answer when Permit cannot answer, and says so', async () => {
    const { app, permit } = setup();
    permit.down = unreachable();
    const res = await ask(app, 'sam', 'CA-1001-A').expect(200);
    expect(res.body).toMatchObject({ legacy: true, permit: null, enforced: true, mode: 'shadow' });
    expect(res.body.error).toContain('ECONNREFUSED');
    expect((await ask(app, 'frodo', 'CA-1002-A')).body).toMatchObject({
      legacy: false,
      permit: null,
      enforced: false,
    });
  });

  it('both mode allows only what the legacy rule and Permit both allow', async () => {
    const { app, permit } = setup();
    await setMode(app, 'both').expect(200);
    expect((await ask(app, 'sam', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: true,
      enforced: true,
      mode: 'both',
    });
    expect((await ask(app, 'fatty', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: false,
      enforced: false,
      mode: 'both',
    });
    // Permit allows Merry, but the legacy table does not know Merry: each side must allow.
    permit.grants.push({ user: 'merry', role: 'account_manager', resource: 'account:CA-1001-B' });
    expect((await ask(app, 'merry', 'CA-1001-B')).body).toEqual({
      legacy: false,
      permit: true,
      enforced: false,
      mode: 'both',
    });
  });

  it('both mode fails closed when Permit cannot answer', async () => {
    const { app, permit } = setup();
    await setMode(app, 'both').expect(200);
    permit.down = unreachable();
    // The legacy rule allows Sam, and a legacy answer alone must never be enough.
    const res = await ask(app, 'sam', 'CA-1001-A').expect(200);
    expect(res.body).toMatchObject({ legacy: true, permit: null, enforced: false, mode: 'both' });
    expect(res.body.error).toEqual(expect.any(String));
    // Once Permit answers again, the same request is allowed.
    permit.down = undefined;
    expect((await ask(app, 'sam', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: true,
      enforced: true,
      mode: 'both',
    });
  });

  it('permit mode ignores the legacy answer', async () => {
    const { app, permit } = setup();
    await setMode(app, 'permit').expect(200);
    // The legacy rule allows Fatty, Permit does not know Fatty: denied.
    expect((await ask(app, 'fatty', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: false,
      enforced: false,
      mode: 'permit',
    });
    // The legacy table does not know Merry, Permit allows Merry as an account manager: allowed.
    permit.grants.push({ user: 'merry', role: 'account_manager', resource: 'account:CA-1001-B' });
    expect((await ask(app, 'merry', 'CA-1001-B')).body).toEqual({
      legacy: false,
      permit: true,
      enforced: true,
      mode: 'permit',
    });
  });

  it('permit mode denies when Permit cannot answer, whatever the legacy rule says', async () => {
    const { app, permit } = setup();
    await setMode(app, 'permit').expect(200);
    permit.down = unreachable();
    expect((await ask(app, 'sam', 'CA-1001-A')).body).toMatchObject({
      legacy: true,
      permit: null,
      enforced: false,
      mode: 'permit',
    });
  });

  it("denies Frodo on the next request once Permit no longer holds Frodo's account admin role, without touching the legacy table", async () => {
    const { app, permit } = setup();
    await setMode(app, 'both').expect(200);
    expect((await ask(app, 'frodo', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: true,
      enforced: true,
      mode: 'both',
    });
    permit.revoke('frodo', 'account_admin', 'ean:EAN-1001');
    expect((await ask(app, 'frodo', 'CA-1001-A')).body).toEqual({
      legacy: true,
      permit: false,
      enforced: false,
      mode: 'both',
    });
    const frodo = (await request(app).get('/api/legacy/state')).body.users.find(
      (u: LegacyUser) => u.key === 'frodo',
    );
    expect(frodo).toEqual(legacyUser('frodo'));
  });

  it('cuts over and rolls back one mode at a time', async () => {
    const { app } = setup();
    for (const mode of ['both', 'permit', 'both', 'shadow']) {
      expect((await setMode(app, mode).expect(200)).body).toMatchObject({ mode });
      expect((await request(app).get('/api/legacy/state')).body.mode).toBe(mode);
    }
  });

  it("reads the user and the account as S5's routes do, trimmed, so 'frodo ' asks about Frodo", async () => {
    const { app, permit } = setup();
    expect((await ask(app, ' frodo ', 'CA-1001-A ')).body).toEqual({
      legacy: true,
      permit: true,
      enforced: true,
      mode: 'shadow',
    });
    expect(permit.asked.map((c) => (typeof c.user === 'string' ? c.user : c.user.key))).toEqual([
      'frodo',
    ]);
  });

  it('rejects a body it cannot use, with 400 and no decision recorded', async () => {
    const { app } = setup();
    const bad: unknown[] = [
      undefined,
      {},
      { user: 'sam' },
      { account: 'CA-1001-A' },
      { user: '', account: 'CA-1001-A' },
      { user: 'sam', account: 7 },
      { user: 'sam', account: 'CA-1001-A', mode: 'permit' },
    ];
    for (const body of bad) {
      const res = await request(app)
        .post('/api/legacy/requests')
        .send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
    }
    expect((await request(app).get('/api/legacy/state')).body.recent).toEqual([]);
  });

  it('answers 404 for an account the master does not have, and asks Permit nothing', async () => {
    const { app, permit } = setup();
    const res = await ask(app, 'sam', 'CA-9999-Z');
    expect(res.status).toBe(404);
    expect(permit.asked).toEqual([]);
  });
});

describe('the mode and the mapping version', () => {
  it('accepts shadow, both and permit, and refuses anything else without changing the mode', async () => {
    const { app } = setup();
    for (const body of [{}, { mode: 'off' }, { mode: 2 }, { mode: 'both', extra: true }]) {
      const res = await request(app).put('/api/legacy/mode').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).get('/api/legacy/state')).body.mode).toBe('shadow');
  });

  it('accepts version 1 and 2, and refuses anything else without changing the version', async () => {
    const { app } = setup();
    expect(
      (await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200)).body,
    ).toMatchObject({ mappingVersion: 2 });
    for (const body of [
      {},
      { version: 3 },
      { version: '1' },
      { version: 1.5 },
      { version: 2, extra: true },
    ]) {
      const res = await request(app).put('/api/legacy/mapping').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).get('/api/legacy/state')).body.mappingVersion).toBe(2);
    expect(
      (await request(app).put('/api/legacy/mapping').send({ version: 1 }).expect(200)).body,
    ).toMatchObject({ mappingVersion: 1 });
  });
});

describe('validating the mapping', () => {
  it('replays the access log through one bulk check and counts the run', async () => {
    const { app, permit } = setup();
    const res = await request(app).post('/api/legacy/validate').expect(200);
    expect(permit.bulkCalls).toBe(1);
    expect(permit.asked).toHaveLength(195);
    expect(res.body.rows).toHaveLength(195);
    expect(res.body.summary).toMatchObject({
      total: 195,
      matches: 104,
      mismatches: 91,
      could_not_check: 0,
    });
    expect(res.body.error).toBeUndefined();
    expect((await request(app).get('/api/legacy/state')).body.validations).toBe(1);
  });

  it('shows three groups with mapping v1, then none unexpected after v2 is synced', async () => {
    const { app } = setup();
    const before = (await request(app).post('/api/legacy/validate').expect(200)).body.summary;
    expect(before.groups.map((g: { user: string }) => g.user)).toEqual([
      'pippin',
      'fatty',
      'lobelia',
    ]);
    expect(
      before.groups.filter((g: { expected?: unknown }) => g.expected === undefined),
    ).toHaveLength(1);
    // The count the console shows: Pippin's 13 requests on Hobbiton are the only unexpected ones.
    expect(before.unexpected).toBe(13);

    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    await request(app).post('/api/legacy/sync').expect(200);
    const after = (await request(app).post('/api/legacy/validate').expect(200)).body.summary;
    expect(after.unexpected).toBe(0);
    expect(after.mismatches).toBe(78);
    expect(after.groups.map((g: { user: string }) => g.user)).toEqual(['fatty', 'lobelia']);
    expect(
      after.groups.every(
        (g: { expected?: { approved_by: string } }) => g.expected?.approved_by === 'sam',
      ),
    ).toBe(true);
    expect((await request(app).get('/api/legacy/state')).body.validations).toBe(2);
  });

  it('reports a Permit that cannot answer, counts nothing as a match or a mismatch, and does not count the run', async () => {
    const { app, permit } = setup();
    permit.down = unreachable();
    const res = await request(app).post('/api/legacy/validate').expect(200);
    expect(res.body.summary).toEqual({
      total: 195,
      matches: 0,
      mismatches: 0,
      unexpected: 0,
      could_not_check: 195,
      groups: [],
    });
    expect(
      res.body.rows.every(
        (r: { permit: unknown; outcome: string }) =>
          r.permit === null && r.outcome === 'could_not_check',
      ),
    ).toBe(true);
    expect(res.body.error).toContain('ECONNREFUSED');
    expect((await request(app).get('/api/legacy/state')).body.validations).toBe(0);
  });
});

describe('syncing the mapping to Permit', () => {
  // Staging answers a role held already with success, so a sync that only wrote would count Sam's
  // org_admin and Frodo's account_admin as written (it reported written 3 after a reset). It reads
  // what each user holds first.
  it('writes the current version with waited writes, and reports what it wrote, what was there and what it skipped', async () => {
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    const res = await request(app).post('/api/legacy/sync').expect(200);
    expect(res.body).toMatchObject({ version: 2, written: 1, unchanged: 2, skipped: 2 });
    expect(res.body.grants).toEqual([
      { user: 'sam', role: 'org_admin', status: 'unchanged' },
      { user: 'frodo', role: 'account_admin', resource: 'ean:EAN-1001', status: 'unchanged' },
      { user: 'pippin', role: 'account_manager', resource: 'account:CA-1001-A', status: 'written' },
      {
        user: 'lobelia',
        role: 'account_admin',
        resource: 'ean:EAN-1001',
        status: 'skipped',
        reason: 'not in Permit',
      },
      {
        user: 'lobelia',
        role: 'account_admin',
        resource: 'ean:EAN-1002',
        status: 'skipped',
        reason: 'not in Permit',
      },
    ]);
    // Only Pippin's grant was written, and it waited for the PDP: the legacy app's next question
    // sees it.
    expect(permit.writes).toEqual([
      {
        user: 'pippin',
        role: 'account_manager',
        tenant: 'shire-freight',
        resource_instance: 'account:CA-1001-A',
      },
    ]);
    expect(permit.waits).toEqual([[5, 'fail']]);
    expect(permit.grants).toContainEqual({
      user: 'pippin',
      role: 'account_manager',
      resource: 'account:CA-1001-A',
    });
    // What a mapped user holds was read before anything was written, and only for users Permit has.
    expect(permit.assignmentsRead).toEqual(['sam', 'frodo', 'pippin']);
  });

  it('adds nothing with mapping v1 to a Permit that holds it already, writes nothing, and a second sync is a no-op', async () => {
    const { app, permit } = setup();
    const first = (await request(app).post('/api/legacy/sync').expect(200)).body;
    expect(first).toMatchObject({ version: 1, written: 0, unchanged: 2, skipped: 2 });
    expect(permit.writes).toEqual([]);
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    await request(app).post('/api/legacy/sync').expect(200);
    const again = (await request(app).post('/api/legacy/sync').expect(200)).body;
    expect(again).toMatchObject({ written: 0, unchanged: 3, skipped: 2 });
    expect(permit.writes).toHaveLength(1);
    expect(permit.grants.filter((g) => g.user === 'pippin')).toHaveLength(1);
  });

  it('still counts a 409, should Permit answer one for a role it holds, as unchanged', async () => {
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    permit.failWrite = (w) =>
      w.user === 'pippin'
        ? Object.assign(new Error('Request failed with status code 409'), { status: 409 })
        : undefined;
    const res = await request(app).post('/api/legacy/sync').expect(200);
    expect(res.body).toMatchObject({ written: 0, unchanged: 3, skipped: 2 });
  });

  it('answers 502 before writing anything when it cannot read what a mapped user holds', async () => {
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    permit.assignmentsDown = Object.assign(new Error('Request failed with status code 503'), {
      status: 503,
    });
    const res = await request(app).post('/api/legacy/sync');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(
      'Permit could not say which roles its users hold: Request failed with status code 503',
    );
    expect(res.body).toMatchObject({ written: 0, unchanged: 0, skipped: 0, grants: [] });
    expect(permit.writes).toEqual([]);
  });

  // A connector registered under a legacy user's key (S5 lets Pippin pick the key) is a Permit user
  // the mapping would otherwise find, and give that user's roles: account_admin on both EANs for
  // "lobelia". The mapping maps people.
  it('skips a Permit user marked as an integration, and writes it nothing', async () => {
    const { app, permit } = setup();
    permit.directory.add('lobelia');
    permit.attributes.set('lobelia', {
      principal_type: 'integration',
      owner: 'pippin',
      customer: 'shire-freight',
    });
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    const res = await request(app).post('/api/legacy/sync').expect(200);
    expect(res.body).toMatchObject({ written: 1, unchanged: 2, skipped: 2 });
    expect(res.body.grants.filter((g: { user: string }) => g.user === 'lobelia')).toEqual([
      {
        user: 'lobelia',
        role: 'account_admin',
        resource: 'ean:EAN-1001',
        status: 'skipped',
        reason: 'an integration in Permit, not a person',
      },
      {
        user: 'lobelia',
        role: 'account_admin',
        resource: 'ean:EAN-1002',
        status: 'skipped',
        reason: 'an integration in Permit, not a person',
      },
    ]);
    expect(permit.writes.filter((w) => w.user === 'lobelia')).toEqual([]);
    expect(permit.grants.filter((g) => g.user === 'lobelia')).toEqual([]);
    expect(permit.assignmentsRead).not.toContain('lobelia');
  });

  it('never removes a role: syncing mapping v1 after v2 leaves Pippin as an account manager', async () => {
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    await request(app).post('/api/legacy/sync').expect(200);
    await request(app).put('/api/legacy/mapping').send({ version: 1 }).expect(200);
    await request(app).post('/api/legacy/sync').expect(200);
    expect(permit.grants).toContainEqual({
      user: 'pippin',
      role: 'account_manager',
      resource: 'account:CA-1001-A',
    });
  });

  it("finds a user on a later page of Permit's list, and matches the key exactly", async () => {
    const { app, permit } = setup();
    // 150 users whose keys contain "frodo" come before Frodo: Frodo is on the second page of that
    // search, and the only exact match. Sam is on the first page of Sam's.
    permit.directory.clear();
    for (let i = 0; i < 150; i += 1) permit.directory.add(`frodo-${String(i).padStart(3, '0')}`);
    for (const key of ['frodo', 'sam']) permit.directory.add(key);
    const res = await request(app).post('/api/legacy/sync').expect(200);
    expect(
      res.body.grants.map((g: { user: string; status: string }) => `${g.user}:${g.status}`),
    ).toEqual(['sam:unchanged', 'frodo:unchanged', 'lobelia:skipped', 'lobelia:skipped']);
    expect(permit.listed).toContainEqual({ search: 'frodo', page: 2 });
    // A user whose key only contains the one asked for is not that user.
    permit.directory.clear();
    permit.directory.add('frodo-001');
    const none = await request(app).post('/api/legacy/sync').expect(200);
    expect(
      none.body.grants
        .filter((g: { user: string; status: string }) => g.user === 'frodo')
        .map((g: { status: string }) => g.status),
    ).toEqual(['skipped']);
  });

  it('gives up, with 502 and no write, on a Permit whose list of users never ends', async () => {
    const { app, permit } = setup();
    permit.ignoresPages = true;
    permit.directory.clear();
    for (let i = 0; i < 100; i += 1) permit.directory.add(`someone-${i}`);
    const res = await request(app).post('/api/legacy/sync');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/more than \d+ users/);
    expect(permit.writes).toEqual([]);
    expect(permit.listed.length).toBeLessThanOrEqual(10);
  });

  it('answers 502 before writing anything when it cannot tell who Permit knows', async () => {
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    permit.down = unreachable();
    const res = await request(app).post('/api/legacy/sync');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('ECONNREFUSED');
    expect(permit.writes).toEqual([]);
  });

  it('stops at a write that fails, answers 502 with the progress so far, and a retry finishes the job', async () => {
    const { app, permit } = setup();
    await request(app).put('/api/legacy/mapping').send({ version: 2 }).expect(200);
    permit.failWrite = (w) =>
      w.user === 'pippin'
        ? Object.assign(new Error('Request failed with status code 424'), { status: 424 })
        : undefined;
    const res = await request(app).post('/api/legacy/sync');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The PDP did not confirm this change within 5 seconds.');
    expect(res.body).toMatchObject({ written: 0, unchanged: 2 });
    expect(
      res.body.grants.map((g: { user: string; status: string }) => `${g.user}:${g.status}`),
    ).toEqual(['sam:unchanged', 'frodo:unchanged', 'pippin:failed']);
    expect(permit.grants.some((g) => g.user === 'pippin')).toBe(false);

    permit.failWrite = undefined;
    const retry = await request(app).post('/api/legacy/sync').expect(200);
    expect(retry.body).toMatchObject({ written: 1, unchanged: 2, skipped: 2 });
    // Sam's and Frodo's roles were never written: on each run they were read as held.
    expect(permit.writes.map((w) => w.user)).toEqual(['pippin', 'pippin']);
  });
});

describe('without Permit settings', () => {
  const notifier: PortalNotifier = {
    factsChanged: async () => ({ ok: true }),
    runCleanup: async () => ({ removed: 0 }),
  };
  const bare = () =>
    createApp({
      store: new Store(loadSeed(), { at: NOW }),
      notifier,
      now: () => NOW,
      seed: loadSeed(),
      env: {},
    });

  it("dates each decision by the app's clock, not the wall clock", async () => {
    const app = bare();
    await request(app)
      .post('/api/legacy/requests')
      .send({ user: 'sam', account: 'CA-1001-A' })
      .expect(200);
    expect((await request(app).get('/api/legacy/state')).body.recent).toEqual([
      expect.objectContaining({ at: new Date(NOW).toISOString(), user: 'sam' }),
    ]);
  });

  it('cannot check anything and says which settings are missing, never a value', async () => {
    const app = bare();
    const res = await request(app)
      .post('/api/legacy/requests')
      .send({ user: 'sam', account: 'CA-1001-A' })
      .expect(200);
    expect(res.body).toMatchObject({ legacy: true, permit: null, enforced: true, mode: 'shadow' });
    expect(res.body.error).toContain('PERMIT_API_URL');
    expect(res.body.error).toContain('PERMIT_API_KEY');
    expect(res.body.error).toContain('PERMIT_PDP_URL');
    await request(app).put('/api/legacy/mode').send({ mode: 'both' }).expect(200);
    expect(
      (await request(app).post('/api/legacy/requests').send({ user: 'sam', account: 'CA-1001-A' }))
        .body,
    ).toMatchObject({ permit: null, enforced: false });
    const validated = await request(app).post('/api/legacy/validate').expect(200);
    expect(validated.body.summary).toMatchObject({
      total: 195,
      could_not_check: 195,
      matches: 0,
      mismatches: 0,
    });
    expect((await request(app).post('/api/legacy/sync')).status).toBe(502);
  });
});

describe("the legacy app's Permit client", () => {
  const settings = {
    PERMIT_API_URL: 'https://permit.invalid',
    PERMIT_API_KEY: 'test-api-key',
    PERMIT_PDP_URL: 'http://pdp.invalid:7000',
  };

  it('is built from the environment, asks the local PDP, throws when it cannot, and writes through the PDP', () => {
    const { config } = legacyPermit(settings);
    expect(config.pdp).toBe('http://pdp.invalid:7000');
    expect(config.apiUrl).toBe('https://permit.invalid');
    // A PDP that cannot be reached must throw, so it is never mistaken for a deny.
    expect(config.throwOnError).toBe(true);
    // waitForSync only waits on a client whose writes go through the PDP.
    expect(config.proxyFactsViaPdp).toBe(true);
    expect(config.timeout).toBeGreaterThan(0);
  });

  it('is not built without its settings, and the error names them and never a value', () => {
    for (const missing of ['PERMIT_API_URL', 'PERMIT_API_KEY', 'PERMIT_PDP_URL']) {
      const { [missing]: _left, ...rest } = settings as Record<string, string>;
      let thrown: unknown;
      try {
        legacyPermit(rest);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(missing);
      expect(message).not.toContain('test-api-key');
    }
    expect(() => legacyPermit({})).toThrow(/PERMIT_API_URL.*PERMIT_API_KEY.*PERMIT_PDP_URL/);
  });
});

// --- The console page ---

describe('the S8 console page', () => {
  const notifier: PortalNotifier = {
    factsChanged: async () => ({ ok: true }),
    runCleanup: async () => ({ removed: 0 }),
  };
  const page = async () =>
    (
      await request(
        createApp({
          store: new Store(loadSeed(), { at: NOW }),
          notifier,
          now: () => NOW,
          seed: loadSeed(),
        }),
      )
        .get('/s8')
        .expect(200)
    ).text;

  it('offers the users table, the mode switch, the validation, the sync, a request to try and the recent decisions', async () => {
    const html = await page();
    for (const id of [
      'users',
      'mode',
      'validate',
      'use-v2',
      'try-user',
      'try-account',
      'try-send',
      'recent',
    ])
      expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain('Validate mapping');
    expect(html).toContain('Use mapping v2 and sync');
    expect(html).toContain('Try a request');
  });

  it('shows how many mismatches are unexpected beside the totals, and why a grant was skipped', async () => {
    const html = await page();
    // The comparison's facts read the summary's own count: 13 with mapping v1, 0 once v2 is synced.
    expect(html).toContain("['Unexpected', String(s.unexpected)]");
    // A skipped grant says why: not in Permit, or a connector rather than a person.
    expect(html).toContain("'skipped: ' + grant.reason");
  });

  it('has an inline script that compiles, and that only calls routes the legacy app serves', async () => {
    const html = await page();
    const script = /<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];
    expect(script).toBeDefined();
    // The script lives in a template literal: a backtick, "${" or backslash would have been changed
    // on the way here.
    expect(script).not.toMatch(/[`\\]|\$\{/);
    expect(() => new Script(script ?? '')).not.toThrow();
    const called = new Set((script ?? '').match(/\/api\/legacy\/[a-z]+/g));
    expect([...called].sort()).toEqual([
      '/api/legacy/mapping',
      '/api/legacy/mode',
      '/api/legacy/requests',
      '/api/legacy/state',
      '/api/legacy/sync',
      '/api/legacy/validate',
    ]);
  });

  it("keeps to the console's wording: personas by name, never a pronoun", async () => {
    const html = await page();
    expect(html).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });
});
