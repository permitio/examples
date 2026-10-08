// Stand-ins for the portal and Great Eagle's systems that the S2, S5 and S8 runner tests run against. Each is a
// small world that answers the way the real services answered on staging, route by route, with its state in memory:
// `s2World()` for Team access and Merry's grid, `s5World()` for the connector, `s8World()` for the legacy billing app.
// A `bugs` option breaks one behaviour, so a test can show that the runner stops at the step that watches for it. They are
// written independently of the runners: the expected lists below are spelt out again, not imported.

export interface Seen { method: string; path: string; persona?: string; authorization?: string; body: unknown }
export type Reply = [status: number, body: unknown];

type Doc = Record<string, unknown>;
interface FeedEvent extends Doc { id: number }

/** The portal's decision-panel feed (GET /api/events): events in order, each with the next id. */
class Feed {
  readonly events: FeedEvent[] = [];

  push(event: Doc): void {
    this.events.push({ ...event, id: this.events.length + 1 });
  }

  answer(path: string): Reply {
    const since = Number(new URL(path, 'http://fake').searchParams.get('since') ?? '0');
    return [200, { events: this.events.filter((e) => e.id > since), lastId: this.events.length }];
  }
}

const sorted = (values: Iterable<string>) => [...values].sort();

// --- S2 -----------------------------------------------------------------------------------------------------------

/** What Sam may grant (every pair in Shire Freight, the sandbox excluded) and what Frodo, admin of EAN-1001, may. */
const SAMS_PAIRS = [
  'shipper ean:EAN-1001', 'shipper ean:EAN-1002', 'account_admin ean:EAN-1001', 'account_admin ean:EAN-1002',
  'account_manager account:CA-1001-A', 'account_manager account:CA-1001-B', 'account_manager account:CA-1002-A',
  'location_operator location:LOC-BAGEND', 'location_operator location:LOC-BYWATER', 'location_operator location:LOC-FROGMORTON', 'location_operator location:LOC-MICHEL',
];
const FRODOS_PAIRS = [
  'shipper ean:EAN-1001', 'account_manager account:CA-1001-A', 'account_manager account:CA-1001-B',
  'location_operator location:LOC-BAGEND', 'location_operator location:LOC-BYWATER', 'location_operator location:LOC-FROGMORTON',
];
const PLACE_NAMES: Record<string, string> = {
  'account:CA-1001-A': 'Hobbiton', 'account:CA-1001-B': 'Bywater', 'account:CA-1002-A': 'Michel Delving',
  'location:LOC-BAGEND': 'Bag End depot', 'location:LOC-BYWATER': 'Bywater depot', 'location:LOC-FROGMORTON': 'Frogmorton depot', 'location:LOC-MICHEL': 'Michel Delving depot',
};
const PLACE_PARENTS: Record<string, string> = {
  'account:CA-1001-A': 'ean:EAN-1001', 'account:CA-1001-B': 'ean:EAN-1001', 'account:CA-1002-A': 'ean:EAN-1002',
  'location:LOC-BAGEND': 'account:CA-1001-A', 'location:LOC-BYWATER': 'account:CA-1001-B', 'location:LOC-FROGMORTON': 'account:CA-1001-B', 'location:LOC-MICHEL': 'account:CA-1002-A',
};
const ACCOUNTS_UNDER: Record<string, string[]> = { 'ean:EAN-1001': ['account:CA-1001-A', 'account:CA-1001-B'], 'ean:EAN-1002': ['account:CA-1002-A'] };
const FORGED = 'shipper ean:EAN-1002';

export interface S2Bugs {
  /** Sam's team also offers a grant on the integration sandbox. */
  sandboxOffered?: boolean;
  /** Frodo's team also offers account admin on EAN-1001. */
  frodoMayMakeAdmins?: boolean;
  /** The portal accepts a grant Permit denies, and writes it. */
  forgedAccepted?: boolean;
  /** The portal refuses the forged grant with 403, but writes it all the same. */
  forgedStillWrites?: boolean;
  /** Merry's grid also lists Bag End. */
  bagEndShown?: boolean;
  /** Hobbiton's row also lists view_billing. */
  hobbitonBilling?: boolean;
  /** A repeated grant adds a second assignment. */
  repeatDuplicates?: boolean;
  /** The refused forged grant still changes Merry's roles, without a write the decision panel would show. */
  forgedWritesSilently?: boolean;
  /** A grant's write reaches the decision panel before the check that should guard it. */
  writeBeforeCheck?: boolean;
  /** A removed role stays in Merry's grid. */
  roleSurvivesRemoval?: boolean;
}

/** Team access and Merry's grid, as the portal answers them, with the console's forged-grant tester on the same server. */
export function s2World(bugs: S2Bugs = {}) {
  const held: string[] = [];
  const feed = new Feed();
  const pairsOf = (persona: string): string[] => {
    if (persona === 'sam') return bugs.sandboxOffered ? [...SAMS_PAIRS, 'shipper ean:EAN-SANDBOX'] : SAMS_PAIRS;
    if (persona === 'frodo') return bugs.frodoMayMakeAdmins ? [...FRODOS_PAIRS, 'account_admin ean:EAN-1001'] : FRODOS_PAIRS;
    return [];
  };
  const placeOf = (pair: string) => pair.split(' ')[1] ?? '';

  /** Merry's grid: what the PDP lists for the roles Merry holds, derived ones included. */
  const grid = () => {
    const rows = new Map<string, { roles: Set<string>; actions: Set<string> }>();
    const give = (resource: string, role: string, actions: string[]) => {
      const row = rows.get(resource) ?? { roles: new Set<string>(), actions: new Set<string>() };
      row.roles.add(role);
      for (const action of actions) row.actions.add(action);
      rows.set(resource, row);
    };
    for (const entry of held) {
      const [role = '', resource = ''] = entry.split(' ');
      if (role === 'shipper') {
        give(resource, role, ['view', 'ship']);
        for (const account of ACCOUNTS_UNDER[resource] ?? []) give(account, role, ['view', 'ship']);
      }
      if (role === 'account_manager') give(resource, role, ['view', 'ship', 'view_billing']);
      if (role === 'location_operator') give(resource, role, ['view', 'operate']);
    }
    if (bugs.bagEndShown) give('location:LOC-BAGEND', 'location_operator', ['view', 'operate']);
    if (bugs.hobbitonBilling) give('account:CA-1001-A', 'shipper', ['view_billing']);
    const rank = (resource: string) => ['ean', 'account', 'location'].indexOf(resource.split(':')[0] ?? '');
    return [...rows].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  };
  const gridRows = () => grid().map(([resource, row]) => ({
    resource, name: PLACE_NAMES[resource] ?? resource.split(':')[1], roles: sorted(row.roles), actions: sorted(row.actions),
  }));

  const checkOf = (persona: string, pair: string) => {
    const [role = '', resource = ''] = pair.split(' ');
    const allow = pairsOf(persona).includes(pair);
    // With writeBeforeCheck the grant's own write is recorded first (see give()), so the panel shows the write ahead of its check.
    if (allow && bugs.writeBeforeCheck) feed.push({ kind: 'write', what: `assign ${role} on ${resource} to merry`, ms: 812, ok: true });
    feed.push({ kind: 'check', user: persona, action: `grant_${role}`, resource, allow });
    return allow;
  };
  const write = (what: string, ms: number) => feed.push({ kind: 'write', what, ms, ok: true });

  /** Gives Merry the role. Permit holds a repeated assignment once and answers success, never 409. */
  const give = (pair: string): number => {
    const [role = '', resource = ''] = pair.split(' ');
    const repeat = held.includes(pair);
    if (!repeat || bugs.repeatDuplicates) held.push(pair);
    if (!bugs.writeBeforeCheck) write(`assign ${role} on ${resource} to merry`, repeat ? 683 : 812);
    return repeat ? 683 : 812;
  };
  const take = (pair: string): number => {
    const [role = '', resource = ''] = pair.split(' ');
    const at = held.indexOf(pair);
    if (at < 0) {
      write(`unassign ${role} on ${resource} from merry (already done)`, 711);
      return 0;
    }
    if (!bugs.roleSurvivesRemoval) held.splice(at, 1);
    write(`unassign ${role} on ${resource} from merry`, 900);
    return 900;
  };

  const reply = (req: Seen): Reply => {
    const persona = req.persona ?? '';
    const path = req.path.split('?')[0];
    if (req.method === 'GET' && path === '/api/events') return feed.answer(req.path);
    if (req.method === 'GET' && path === '/api/s2/team') {
      return [200, {
        members: ['sam', 'frodo', 'merry', 'pippin'].map((key) => ({ key, name: key })),
        grantable: pairsOf(persona).map((pair) => {
          const [role = '', resource = ''] = pair.split(' ');
          return { role, resource, name: PLACE_NAMES[resource] ?? resource.split(':')[1], parent: PLACE_PARENTS[resource] ?? null };
        }),
      }];
    }
    if (req.method === 'GET' && path === '/api/s2/members/merry/assignments') {
      const mine = held.filter((pair) => pairsOf(persona).includes(pair));
      return [200, { assignments: mine.map((pair) => ({ role: pair.split(' ')[0], resource: placeOf(pair) })) }];
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && path === '/api/s2/grants') {
      const { role, resource } = req.body as { role: string; resource: string };
      const pair = `${role} ${resource}`;
      if (!checkOf(persona, pair)) return [403, { error: `Permit denied grant_${role} on ${resource}.`, decision: 'deny' }];
      return req.method === 'POST' ? [201, { ms: give(pair) }] : [200, { ms: take(pair) }];
    }
    if (req.method === 'GET' && path === '/api/s2/permissions/merry') {
      return persona === 'merry' ? [200, { rows: gridRows() }] : [403, { error: 'You can only see your own permissions.' }];
    }
    if (req.method === 'POST' && path === '/api/checks/bulk') {
      const checks = (req.body as { checks: Array<{ action: string; resource: { type: string; key: string } }> }).checks;
      const rows = new Map(grid());
      const allow = (check: (typeof checks)[number]) => {
        if (check.action.startsWith('grant_')) return pairsOf(persona).includes(`${check.action.slice('grant_'.length)} ${check.resource.type}:${check.resource.key}`);
        return persona === 'merry' && (rows.get(`${check.resource.type}:${check.resource.key}`)?.actions.has(check.action) ?? false);
      };
      return [200, { results: checks.map((check) => ({ allow: allow(check) })), ms: 1 }];
    }
    // The console's tester (Great Eagle's systems): Frodo gives Merry shipper on EAN-1002, outside Frodo's scope.
    if (req.method === 'POST' && path === '/api/s2/forged-grant') {
      const allowed = checkOf('frodo', FORGED) || bugs.forgedAccepted === true;
      if (!allowed) {
        if (bugs.forgedStillWrites) give(FORGED);
        if (bugs.forgedWritesSilently) held.push('account_admin ean:EAN-1002');
        return [200, { status: 403, body: { error: 'Permit denied grant_shipper on ean:EAN-1002.', decision: 'deny' } }];
      }
      return [200, { status: 201, body: { ms: give(FORGED) } }];
    }
    return [500, { error: `unexpected ${req.method} ${req.path}` }];
  };
  return { reply, held, feed };
}

// --- S5 -----------------------------------------------------------------------------------------------------------

/** The connector's client secret, as the portal's registration answer carries it: 64 hex characters, shown once. */
export const S5_SECRET = 'c0ffee'.repeat(10) + 'beef';
const SELF_APPROVAL = 'A request cannot be approved by the person who made it or the person it is for.';

export interface S5Bugs {
  /** The integrations list carries the client secret. */
  leaksSecret?: boolean;
  /** The integration API answers a credential it never issued. */
  acceptsAnyCredential?: boolean;
  /** The connector may create on EAN-1001 as soon as it is registered. */
  productionBeforeApproval?: boolean;
  /** Pippin's own request is approved when Pippin approves it. */
  pippinMayApprove?: boolean;
  /** Frodo, who may not approve integrations, can. */
  frodoMayApprove?: boolean;
  /** The connector may also create on EAN-1002, which nobody approved. */
  ean1002Open?: boolean;
  /** "Make view-only" leaves the create role in place. */
  viewOnlyKeepsCreate?: boolean;
  /** Revoking leaves the sandbox role. */
  revokeKeepsSandbox?: boolean;
  /** The connector's checks reach the decision panel without its name. */
  noConnectorLabel?: boolean;
  /** The connector's calls are not listed on Sam's card. */
  noRecentCalls?: boolean;
}

/** The connector, its production request and its scope, with Great Eagle's systems' run call and shipment store on the same server. */
export function s5World(bugs: S5Bugs = {}) {
  let registered = false;
  const scope: string[] = [];
  const request: { current?: Doc } = {};
  const shipments: Array<{ key: string; ean: string; title: string; created_by: string; created_at: string }> = [];
  const feed = new Feed();
  const holds = (role: string, ean: string) => scope.includes(`${role} ean:${ean}`);

  /** One call of the connector: the status the portal's integration API gave it, and its body. */
  const call = (op: 'create' | 'list', ean: string): { status: number; body: unknown } => {
    const action = op === 'create' ? 'create_shipment' : 'view';
    let allow = op === 'create' ? holds('integration_client', ean) : holds('integration_client', ean) || holds('integration_reader', ean);
    if (bugs.ean1002Open && op === 'create' && ean === 'EAN-1002') allow = true;
    if (bugs.productionBeforeApproval && ean === 'EAN-1001') allow = true;
    feed.push({ kind: 'check', user: 'shire-erp', action, resource: `ean:${ean}`, allow, ...(bugs.noConnectorLabel ? {} : { label: 'Shire ERP connector' }) });
    if (!allow) return { status: 403, body: { error: `Permit denied ${action} on ean:${ean}.`, decision: 'deny' } };
    if (op === 'list') {
      const own = ean === 'EAN-1001' ? [{ key: 'SHP-77001', ean, title: 'International shipment' }, { key: 'SHP-77002', ean, title: 'Domestic shipment' }] : [];
      return { status: 200, body: { shipments: [...own, ...shipments.filter((s) => s.ean === ean)] } };
    }
    const shipment = { key: `SHP-${80001 + shipments.length}`, ean, title: 'Created by Shire ERP connector', created_by: 'shire-erp', created_at: '2026-10-07T15:54:30.334Z' };
    shipments.push(shipment);
    return { status: 201, body: shipment };
  };

  const recent = () => bugs.noRecentCalls ? [] : feed.events
    .filter((e) => e.kind === 'check' && e.user === 'shire-erp').reverse().slice(0, 10)
    .map((e) => ({ action: e.action, resource: e.resource, allow: e.allow, at: e.id }));
  const view = () => ({
    key: 'shire-erp', name: 'Shire ERP connector', owner: 'pippin', customer: 'shire-freight', customer_name: 'Shire Freight',
    scope: scope.map((entry) => ({ role: entry.split(' ')[0], resource: entry.split(' ')[1] })),
    requests: request.current ? [request.current] : [], recent: recent(),
    ...(bugs.leaksSecret ? { client_secret: S5_SECRET } : {}),
  });
  const approve = (persona: string): Reply => {
    const pending = request.current;
    if (!pending) return [404, { error: 'Request not found' }];
    if (persona === 'pippin' && !bugs.pippinMayApprove) return [409, { error: SELF_APPROVAL }];
    if (persona === 'frodo' && !bugs.frodoMayApprove) return [403, { error: 'Permit denied approve_integration on ean:EAN-1001.', decision: 'deny' }];
    request.current = { ...pending, status: 'approved', reviewer: persona };
    scope.push(`integration_client ${String(pending.target)}`);
    return [200, { request: request.current, ms: 801 }];
  };
  const change = (ean: string, level: string): Reply => {
    const drop = (role: string) => {
      const at = scope.indexOf(`${role} ean:${ean}`);
      if (at >= 0) scope.splice(at, 1);
    };
    if (level === 'read') {
      scope.push(`integration_reader ean:${ean}`);
      if (!bugs.viewOnlyKeepsCreate) drop('integration_client');
      return [200, { ms: 1587 }];
    }
    if (bugs.revokeKeepsSandbox && ean === 'EAN-SANDBOX') return [200, { ms: 0 }];
    drop('integration_client');
    drop('integration_reader');
    if (request.current?.target === `ean:${ean}`) request.current = { ...request.current, status: 'revoked' };
    return [200, { ms: 777 }];
  };

  const reply = (req: Seen): Reply => {
    const persona = req.persona ?? '';
    const url = new URL(req.path, 'http://fake');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/events') return feed.answer(req.path);
    if (req.method === 'POST' && path === '/api/s5/integrations') {
      if (registered) return [409, { error: 'shire-erp is already taken.' }];
      registered = true;
      scope.push('integration_client ean:EAN-SANDBOX');
      return [201, { integration: view(), client_secret: S5_SECRET }];
    }
    if (req.method === 'GET' && path === '/api/s5/integrations') return [200, { integrations: registered ? [view()] : [] }];
    if (req.method === 'POST' && path === '/api/s5/integrations/shire-erp/production-requests') {
      const { ean, reason } = req.body as { ean: string; reason: string };
      request.current = {
        id: 'req-test-5', type: 'integration_access', tenant: 'shire-freight', target: `ean:${ean}`, role: 'integration_client',
        requested_for: 'shire-erp', initiated_by: persona, reason, status: 'pending',
      };
      return [201, request.current];
    }
    if (req.method === 'GET' && path === '/api/approvals') {
      return [200, { requests: persona === 'sam' && request.current?.status === 'pending' ? [request.current] : [] }];
    }
    if (req.method === 'POST' && path === '/api/requests/req-test-5/approve') return approve(persona);
    if (req.method === 'POST' && path === '/api/s5/integrations/shire-erp/scope') {
      const { ean, level } = req.body as { ean: string; level: string };
      return change(ean, level);
    }
    if (req.method === 'POST' && path === '/api/checks/bulk') {
      const checks = (req.body as { checks: unknown[] }).checks;
      return [200, { results: checks.map(() => ({ allow: persona === 'sam' })), ms: 1 }];
    }
    // The integration API the connector calls with its own credential.
    if (req.method === 'POST' && path === '/api/integration/shipments') {
      const known = req.authorization === `Bearer ${S5_SECRET}` || (bugs.acceptsAnyCredential === true && req.authorization !== undefined);
      if (!known) return [401, { error: 'Unknown client credential' }];
      const { status, body } = call('create', 'EAN-SANDBOX');
      return [status, body];
    }
    // Great Eagle's systems: the console's run call, the registry and the shipment store.
    if (req.method === 'POST' && path === '/api/integrations/shire-erp/run') {
      const { op, ean } = req.body as { op: 'create' | 'list'; ean: string };
      return [200, call(op, ean)];
    }
    if (req.method === 'GET' && path === '/api/shipments') return [200, shipments.filter((s) => s.ean === url.searchParams.get('ean'))];
    if (req.method === 'GET' && path === '/api/integrations') {
      return [200, registered ? [{ key: 'shire-erp', name: 'Shire ERP connector', owner: 'pippin', customer: 'shire-freight', created_at: '2026-10-07T15:54:30.279Z' }] : []];
    }
    return [500, { error: `unexpected ${req.method} ${req.path}` }];
  };
  return { reply, scope, feed, shipments };
}

// --- S8 -----------------------------------------------------------------------------------------------------------

const LEGACY_USERS = [
  { key: 'sam', name: 'Samwise Gamgee', is_admin: true, accounts: [] as string[], note: 'Organization admin' },
  { key: 'frodo', name: 'Frodo Baggins', is_admin: false, accounts: ['EAN-1001'], note: 'Account admin' },
  { key: 'pippin', name: 'Peregrin Took', is_admin: false, accounts: ['CA-1001-A'], note: 'Uses a child-account code' },
  { key: 'fatty', name: 'Fredegar Bolger', is_admin: true, accounts: [], note: 'Depot clerk with an admin flag' },
  { key: 'lobelia', name: 'Lobelia Sackville-Baggins', is_admin: false, accounts: ['EAN-1001', 'EAN-1002'], note: 'Left the company' },
];
const LEGACY_ACCOUNTS = [
  { key: 'CA-1001-A', ean: 'EAN-1001' }, { key: 'CA-1001-B', ean: 'EAN-1001' }, { key: 'CA-1002-A', ean: 'EAN-1002' },
];
const APPROVED = { fatty: 'Admin flag not confirmed by the owner', lobelia: 'Left the company' } as const;

export interface S8Bugs {
  /** The sync answers 502, as when the PDP does not confirm a write. */
  syncFails?: boolean;
  /** The sync writes nothing, so Pippin never gets the child-account role. */
  syncWritesNothing?: boolean;
  /** The sync says it wrote Pippin's role, but the PDP never holds it. */
  syncNeverReachesPdp?: boolean;
  /** Frodo's revocation answers 200 but never reaches Permit. */
  revocationNeverArrives?: boolean;
  /** "Both" lets the legacy answer through when Permit says no. */
  bothFailsOpen?: boolean;
  /** Shadow mode enforces Permit's answer instead of the legacy app's. */
  shadowEnforcesPermit?: boolean;
  /** The comparison cannot ask Permit, and says so. */
  validationCannotAsk?: boolean;
}

/** The legacy billing app of Great Eagle's systems, and the pieces of the portal it depends on, over the people the seed has. */
export function s8World(bugs: S8Bugs = {}) {
  const state = { mode: 'shadow', mappingVersion: 1, validations: 0 };
  const permit = { frodo: true, pippin: false };
  const recent: Doc[] = [];

  const legacyAllows = (user: string, account: string): boolean => {
    const u = LEGACY_USERS.find((candidate) => candidate.key === user);
    const a = LEGACY_ACCOUNTS.find((candidate) => candidate.key === account);
    return u !== undefined && a !== undefined && (u.is_admin || u.accounts.includes(a.key) || u.accounts.includes(a.ean));
  };
  const permitAllows = (user: string, account: string): boolean => {
    if (user === 'sam') return true;
    if (user === 'frodo') return permit.frodo && account.startsWith('CA-1001');
    if (user === 'pippin') return permit.pippin && account === 'CA-1001-A';
    return false;
  };
  const enforced = (legacy: boolean, allowed: boolean | null) => {
    if (state.mode === 'shadow') return bugs.shadowEnforcesPermit ? allowed === true : legacy;
    if (state.mode === 'both') return legacy && (allowed === true || bugs.bothFailsOpen === true);
    return allowed === true;
  };
  const validation = () => {
    if (bugs.validationCannotAsk) {
      return { rows: [], summary: { total: 195, matches: 0, mismatches: 0, unexpected: 0, could_not_check: 195, groups: [] }, error: 'The PDP did not answer' };
    }
    const accounts = LEGACY_ACCOUNTS.map((a) => a.key);
    const groups = LEGACY_USERS.flatMap((u) => {
      const count = 13 * accounts.filter((a) => legacyAllows(u.key, a) !== permitAllows(u.key, a)).length;
      const reason = APPROVED[u.key as keyof typeof APPROVED];
      return count === 0 ? [] : [{ user: u.key, count, ...(reason === undefined ? {} : { expected: { reason, approved_by: 'sam' } }) }];
    });
    const mismatches = groups.reduce((sum, g) => sum + g.count, 0);
    const unexpected = groups.reduce((sum, g) => sum + ('expected' in g ? 0 : g.count), 0);
    state.validations += 1;
    return { rows: [], summary: { total: 195, matches: 195 - mismatches, mismatches, unexpected, could_not_check: 0, groups } };
  };
  const sync = (): Reply => {
    if (bugs.syncFails) return [502, { error: 'The PDP did not confirm this change within 5 seconds.', version: state.mappingVersion, written: 0, unchanged: 0, skipped: 0, grants: [] }];
    if (!bugs.syncWritesNothing && !bugs.syncNeverReachesPdp) permit.pippin = true;
    // The sync reads what each user holds before it writes, so the roles Sam and Frodo hold already count as unchanged, and
    // only Pippin's is written (staging said written 3 before it did: Permit answers a role held already with success).
    const pippinWritten = !bugs.syncWritesNothing;
    return [200, {
      version: state.mappingVersion, written: pippinWritten ? 1 : 0, unchanged: pippinWritten ? 2 : 3, skipped: 2,
      grants: [
        { user: 'sam', role: 'org_admin', status: 'unchanged' },
        { user: 'frodo', role: 'account_admin', resource: 'ean:EAN-1001', status: 'unchanged' },
        { user: 'pippin', role: 'account_manager', resource: 'account:CA-1001-A', status: pippinWritten ? 'written' : 'unchanged' },
        { user: 'lobelia', role: 'account_admin', resource: 'ean:EAN-1001', status: 'skipped', reason: 'not in Permit' },
        { user: 'lobelia', role: 'account_admin', resource: 'ean:EAN-1002', status: 'skipped', reason: 'not in Permit' },
      ],
    }];
  };

  const reply = (req: Seen): Reply => {
    const persona = req.persona ?? '';
    const { path } = req;
    if (req.method === 'GET' && path === '/api/legacy/state') {
      return [200, { ...state, recent: recent.slice(0, 20), users: LEGACY_USERS, accounts: LEGACY_ACCOUNTS }];
    }
    if (req.method === 'POST' && path === '/api/legacy/requests') {
      const { user, account } = req.body as { user: string; account: string };
      const legacy = legacyAllows(user, account);
      const answer = permitAllows(user, account);
      const result = { legacy, permit: answer, enforced: enforced(legacy, answer), mode: state.mode };
      recent.unshift({ at: '2026-10-07T16:00:00.000Z', user, account, ...result });
      return [200, result];
    }
    if (req.method === 'POST' && path === '/api/legacy/validate') return [200, validation()];
    if (req.method === 'PUT' && path === '/api/legacy/mapping') {
      state.mappingVersion = (req.body as { version: number }).version;
      return [200, { ...state }];
    }
    if (req.method === 'POST' && path === '/api/legacy/sync') return sync();
    if (req.method === 'PUT' && path === '/api/legacy/mode') {
      state.mode = (req.body as { mode: string }).mode;
      return [200, { ...state }];
    }
    // The portal: the start check's decisions, and S2's revocation.
    if (req.method === 'POST' && path === '/api/checks/bulk') {
      const checks = (req.body as { checks: Array<{ resource: { key: string } }> }).checks;
      return [200, { results: checks.map((check) => ({ allow: permitAllows(persona, check.resource.key) })), ms: 1 }];
    }
    if (req.method === 'DELETE' && path === '/api/s2/grants') {
      if (!bugs.revocationNeverArrives) permit.frodo = false;
      return [200, { ms: 1113 }];
    }
    return [500, { error: `unexpected ${req.method} ${req.path}` }];
  };
  return { reply, state, permit };
}
