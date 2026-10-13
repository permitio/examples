import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { transition, type DemoRequest, type RequestStatus, type RequestType } from '#src/requests';
import type { SeedData, TrustFacts } from '#src/seed';

export interface TrustUser { key: string; name: string; facts: TrustFacts }
export interface Org { key: string; name: string; ownership_verified: boolean }
export interface Doc { name: string; by: string; at: string }
export interface Note { user: string; text: string; at: string }
export type NewRequest = Omit<DemoRequest, 'id' | 'status' | 'created_at' | 'updated_at' | 'history'>;
/** Each list matches any of its values; an empty or missing list matches everything. */
export interface RequestFilter { status?: RequestStatus[]; type?: RequestType[]; tenant?: string[]; requested_for?: string[]; initiated_by?: string[] }
export interface Association { valid: boolean; reason: string; request: DemoRequest }
/**
 * A connector registered in S5, with its client credential (Great Eagle's systems keep it, standing in for
 * the company's OAuth server). Only the registration answer and the systems' own calls to the portal carry `secret`.
 */
export interface Integration { key: string; name: string; owner: string; customer: string; secret: string; created_at: string }
export type NewIntegration = Omit<Integration, 'created_at'>;
/** A shipment a connector created through the portal: Great Eagle's systems are its system of record, Permit stores none. */
export interface CreatedShipment { key: string; ean: string; title: string; created_by: string; created_at: string }
export type NewShipment = Omit<CreatedShipment, 'key' | 'created_at'>;
/** Who decides S8's protected action: the legacy rule (shadow), both of them (each must allow), or Permit. */
export type LegacyMode = 'shadow' | 'both' | 'permit';
/** S8's legacy billing app: its mode, the mapping version in use and how many validations ran. */
export interface LegacyState { mode: LegacyMode; mappingVersion: 1 | 2; validations: number }

/** The account master signs off EAN associations itself: no person reviews them. */
export const ACCOUNT_MASTER = 'great-eagle-account-master';

interface Ean { key: string; org: string; proof?: string | undefined }
interface State {
  users: TrustUser[];
  orgs: Org[];
  eans: Ean[];
  requests: DemoRequest[];
  documents: Array<Doc & { shipment: string }>;
  notifications: Note[];
  integrations: Integration[];
  shipments: CreatedShipment[];
  legacy: LegacyState;
}
const COLLECTIONS = ['users', 'orgs', 'eans', 'requests', 'documents', 'notifications', 'integrations', 'shipments'] as const satisfies ReadonlyArray<keyof State>;
const LEGACY_MODES: readonly LegacyMode[] = ['shadow', 'both', 'permit'];
/** The legacy app at the start of S8: shadow mode, the first mapping, nothing validated yet. */
const LEGACY_START: Readonly<LegacyState> = { mode: 'shadow', mappingVersion: 1, validations: 0 };
/** The key number of the first shipment a connector creates; the seeded shipments are SHP-77xxx. */
const FIRST_CREATED_SHIPMENT = 80_001;

const iso = (ms: number) => new Date(ms).toISOString();

function isLegacyState(value: unknown): value is LegacyState {
  if (typeof value !== 'object' || value === null) return false;
  const { mode, mappingVersion, validations } = value as Record<string, unknown>;
  return LEGACY_MODES.some((m) => m === mode) && (mappingVersion === 1 || mappingVersion === 2)
    && typeof validations === 'number' && Number.isSafeInteger(validations) && validations >= 0;
}

function fromSeed(seed: SeedData, at: number): State {
  // A deep copy: later changes must never reach the seed, which every reset starts from.
  return structuredClone({
    users: seed.personas.flatMap((p) => (p.facts ? [{ key: p.key, name: p.name, facts: p.facts }] : [])),
    orgs: seed.organizations.map(({ key, name, ownership_verified }) => ({ key, name, ownership_verified })),
    eans: seed.eans.map((e) => ({ key: e.key, org: e.org, proof: e.association_proof })),
    requests: seed.requests.map(({ created_offset_ms, ...r }) => {
      const created = iso(at + created_offset_ms);
      return { ...r, created_at: created, updated_at: created, history: [{ at: created, status: r.status, by: r.initiated_by }] };
    }),
    documents: [],
    notifications: [],
    integrations: [],
    shipments: [],
    legacy: { ...LEGACY_START },
  });
}

/** Why the account master rejects the claim, or undefined when it holds. Ownership is checked before the proof. */
function associationProblem(record: Ean | undefined, ean: string, claim: { org: string; proof: string }): string | undefined {
  if (!record) return `${ean} is not in the account master`;
  if (record.org !== claim.org) return `${ean} does not belong to ${claim.org}`;
  // An EAN with no proof on file can never be associated.
  if (record.proof === undefined || record.proof !== claim.proof) return `The proof does not match the account master's record for ${ean}`;
  return undefined;
}

/** The saved state, or undefined when there is no file yet. Any other failure throws: an unreadable store never becomes an empty one. */
function readState(path: string): State | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read the store at ${path}: ${(error as Error).message}`);
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the file around the error, and the file holds the connectors' secrets.
    throw new Error(`The store at ${path} is not valid JSON. Delete it to start again from the seed.`);
  }
  const record = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  // A store saved before S5 and S8 has none of their state: it opens with no connectors and no created shipments, and
  // the legacy app in shadow mode. A store that has their state must hold it whole.
  const upgraded: Record<string, unknown> = { integrations: [], shipments: [], legacy: { ...LEGACY_START }, ...record };
  if (!COLLECTIONS.every((name) => Array.isArray(upgraded[name])) || !isLegacyState(upgraded['legacy'])) {
    throw new Error(`The store at ${path} does not hold the expected collections. Delete it to start again from the seed.`);
  }
  return upgraded as unknown as State;
}

/**
 * Great Eagle's systems of record, in memory. With a `path` (STORE_PATH) it loads the state saved there, or starts from the seed
 * when there is no file yet, and saves every change with an atomic write (temp file, then rename). Without one it lives in
 * memory only. Updates are copy-on-write: a change is saved first and only then becomes the current state, so a failed save
 * changes nothing. Timestamps are taken in ms and stored as ISO strings.
 */
export class Store {
  private state: State;
  private readonly path: string | undefined;

  constructor(private readonly seed: SeedData, options: { path?: string | undefined; at?: number } = {}) {
    this.path = options.path;
    if (this.path !== undefined) mkdirSync(dirname(this.path), { recursive: true });
    const saved = this.path === undefined ? undefined : readState(this.path);
    this.state = saved ?? fromSeed(seed, options.at ?? Date.now());
    if (saved === undefined) this.commit(this.state);
  }

  users(): TrustUser[] {
    return this.state.users;
  }

  userFacts(key: string): TrustFacts | undefined {
    return this.state.users.find((u) => u.key === key)?.facts;
  }

  /** Undefined when `key` has no trust facts. */
  updateUserFacts(key: string, patch: Partial<TrustFacts>): TrustFacts | undefined {
    const user = this.state.users.find((u) => u.key === key);
    if (!user) return undefined;
    const facts = { ...user.facts, ...patch };
    this.commit({ ...this.state, users: this.state.users.map((u) => (u.key === key ? { ...u, facts } : u)) });
    return facts;
  }

  orgs(): Org[] {
    return this.state.orgs;
  }

  org(key: string): Org | undefined {
    return this.state.orgs.find((o) => o.key === key);
  }

  /** Creates the org unverified; an existing org is returned unchanged. */
  createOrg(key: string, name: string): { org: Org; created: boolean } {
    const existing = this.org(key);
    if (existing) return { org: existing, created: false };
    const org = { key, name, ownership_verified: false };
    this.commit({ ...this.state, orgs: [...this.state.orgs, org] });
    return { org, created: true };
  }

  /** Undefined when there is no such org. */
  updateOrg(key: string, ownership_verified: boolean): Org | undefined {
    const existing = this.org(key);
    if (!existing) return undefined;
    const org = { ...existing, ownership_verified };
    this.commit({ ...this.state, orgs: this.state.orgs.map((o) => (o.key === key ? org : o)) });
    return org;
  }

  /** The EANs of any of `orgs` (all EANs when it is empty). Never includes the association proof. */
  eans(orgs: readonly string[] = []): Array<{ key: string; org: string }> {
    return this.state.eans.filter((e) => orgs.length === 0 || orgs.includes(e.org)).map((e) => ({ key: e.key, org: e.org }));
  }

  /** Checks an association claim against the account master and records the outcome as a decided ean_association request. */
  associateEan(ean: string, claim: { org: string; proof: string; by: string }, at: number): Association {
    const problem = associationProblem(this.state.eans.find((e) => e.key === ean), ean, claim);
    const reason = problem ?? `${ean} belongs to ${claim.org} and the proof matches`;
    const pending = this.newRequest({ type: 'ean_association', tenant: claim.org, target: `ean:${ean}`, requested_for: claim.by, initiated_by: claim.by }, at);
    const request = transition(pending, problem ? 'denied' : 'approved', ACCOUNT_MASTER, iso(at), reason);
    this.commit({ ...this.state, requests: [...this.state.requests, request] });
    return { valid: problem === undefined, reason, request };
  }

  /** Newest first. Requests created in the same millisecond keep the order they were added in, newest first. */
  requests(filter: RequestFilter = {}): DemoRequest[] {
    const matches = <T>(allowed: readonly T[] | undefined, value: T) => !allowed?.length || allowed.includes(value);
    return this.state.requests
      .map((request, added) => ({ request, added }))
      .filter(({ request: r }) =>
        matches(filter.status, r.status) && matches(filter.type, r.type) && matches(filter.tenant, r.tenant)
        && matches(filter.requested_for, r.requested_for) && matches(filter.initiated_by, r.initiated_by))
      .sort((a, b) => Date.parse(b.request.created_at) - Date.parse(a.request.created_at) || b.added - a.added)
      .map(({ request }) => request);
  }

  request(id: string): DemoRequest | undefined {
    return this.state.requests.find((r) => r.id === id);
  }

  createRequest(input: NewRequest, at: number): DemoRequest {
    const request = this.newRequest(input, at);
    this.commit({ ...this.state, requests: [...this.state.requests, request] });
    return request;
  }

  /** Undefined for an unknown request; throws TransitionError when the state machine does not allow the move. */
  transitionRequest(id: string, move: { to: RequestStatus; by: string; comment?: string | undefined; duration_ms?: number | undefined }, at: number): DemoRequest | undefined {
    const current = this.request(id);
    if (!current) return undefined;
    const next = transition(current, move.to, move.by, iso(at), move.comment, move.duration_ms);
    this.commit({ ...this.state, requests: this.state.requests.map((r) => (r.id === id ? next : r)) });
    return next;
  }

  documents(shipment: string): Doc[] {
    return this.state.documents.filter((d) => d.shipment === shipment).map(({ name, by, at }) => ({ name, by, at }));
  }

  addDocument(shipment: string, doc: { name: string; by: string }, at: number): Doc {
    const added = { name: doc.name, by: doc.by, at: iso(at) };
    this.commit({ ...this.state, documents: [...this.state.documents, { shipment, ...added }] });
    return added;
  }

  notifications(user: string): Note[] {
    return this.state.notifications.filter((n) => n.user === user);
  }

  addNotification(note: { user: string; text: string }, at: number): Note {
    const added = { user: note.user, text: note.text, at: iso(at) };
    this.commit({ ...this.state, notifications: [...this.state.notifications, added] });
    return added;
  }

  /** Registers a connector (S5), dated `at`. Undefined when its key is taken: a registration never answers another connector's secret. */
  addIntegration(i: NewIntegration, at: number): Integration | undefined {
    if (this.state.integrations.some((existing) => existing.key === i.key)) return undefined;
    const integration: Integration = { key: i.key, name: i.name, owner: i.owner, customer: i.customer, secret: i.secret, created_at: iso(at) };
    this.commit({ ...this.state, integrations: [...this.state.integrations, integration] });
    return integration;
  }

  /** The connector a client secret belongs to; undefined for an empty or unknown one. Compared in constant time, like any credential. */
  findIntegrationBySecret(secret: string): Integration | undefined {
    if (secret === '') return undefined;
    const given = Buffer.from(secret);
    return this.state.integrations.find((i) => {
      const held = Buffer.from(i.secret);
      return held.length === given.length && timingSafeEqual(held, given);
    });
  }

  /** Every connector, oldest first, each with its secret: leave `secret` out of anything sent on. */
  listIntegrations(): Integration[] {
    return this.state.integrations;
  }

  /** Records a shipment a connector created (S5), keyed in sequence from SHP-80001 and dated `at`. */
  addShipment(s: NewShipment, at: number): CreatedShipment {
    const shipment: CreatedShipment = {
      key: `SHP-${FIRST_CREATED_SHIPMENT + this.state.shipments.length}`, ean: s.ean, title: s.title, created_by: s.created_by, created_at: iso(at),
    };
    this.commit({ ...this.state, shipments: [...this.state.shipments, shipment] });
    return shipment;
  }

  /** The shipments connectors created on `ean`, oldest first. The seeded shipments are not among them. */
  listShipments(ean: string): CreatedShipment[] {
    return this.state.shipments.filter((s) => s.ean === ean);
  }

  /** S8's legacy billing app: mode, mapping version and validation count. */
  getLegacy(): LegacyState {
    return this.state.legacy;
  }

  /** Changes the legacy app's state; a field `partial` leaves out keeps its value. */
  setLegacy(partial: Partial<LegacyState>): LegacyState {
    const current = this.state.legacy;
    const legacy: LegacyState = {
      mode: partial.mode ?? current.mode, mappingVersion: partial.mappingVersion ?? current.mappingVersion, validations: partial.validations ?? current.validations,
    };
    this.commit({ ...this.state, legacy });
    return legacy;
  }

  /**
   * Back to the seed: facts, orgs, EANs and requests as seeded (dated relative to `at`), no documents and no
   * notifications, no connectors and no created shipments, and the legacy app in shadow mode with the first mapping.
   */
  reset(at: number): void {
    this.commit(fromSeed(this.seed, at));
  }

  private newRequest(input: NewRequest, at: number): DemoRequest {
    let id: string;
    do {
      id = `req-${randomBytes(4).toString('hex')}`;
    } while (this.request(id));
    const created = iso(at);
    return { id, ...input, status: 'pending', created_at: created, updated_at: created, history: [{ at: created, status: 'pending', by: input.initiated_by }] };
  }

  private commit(next: State): void {
    if (this.path !== undefined) {
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(next));
      renameSync(temp, this.path);
    }
    this.state = next;
  }
}
