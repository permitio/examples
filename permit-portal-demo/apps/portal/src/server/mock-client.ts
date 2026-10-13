import { HttpError, messageOf } from '#src/server/errors';
import type { DemoRequest, RequestStatus, RequestType, TrustFacts } from '#src/server/model';

export interface MockOrg { key: string; name: string; ownership_verified: boolean }
export interface Doc { name: string; by: string; at: string }
export interface EanAssociation { valid: boolean; reason: string; request: DemoRequest }
/** A connector as Great Eagle's systems list it (S5): never with its client secret, which only the registration answer carries. */
export interface MockIntegration { key: string; name: string; owner: string; customer: string; created_at: string }
export type NewIntegration = Pick<MockIntegration, 'key' | 'name' | 'owner' | 'customer'>;
/** What registering a connector answers: the connector and, this once, the client secret Great Eagle's systems issued. */
export type RegisteredIntegration = NewIntegration & { client_secret: string };
/** Whose credential a client secret is, as the registry resolves it: the connector's key and the customer it acts for. */
export interface IntegrationIdentity { key: string; customer: string }
/** A shipment a connector created, as Great Eagle's systems, its system of record, hold it. */
export interface MockShipment { key: string; ean: string; title: string; created_by: string; created_at: string }
export type NewShipment = Pick<MockShipment, 'ean' | 'title' | 'created_by'>;
/** The fields `POST /api/requests` accepts. The mock answers 400 to any other, so nothing else is ever sent. */
const NEW_REQUEST_FIELDS = ['type', 'tenant', 'target', 'role', 'requested_for', 'initiated_by', 'reason', 'duration_ms', 'requested_days', 'org_name'] as const;
export type NewRequest = Pick<DemoRequest, (typeof NEW_REQUEST_FIELDS)[number]>;
export interface RequestFilter { status?: RequestStatus; type?: RequestType | RequestType[]; tenant?: string; requested_for?: string; initiated_by?: string }
/** The cleanup job's status, passed to the UI unchanged. Times are epoch milliseconds, null before the first run. */
export interface CleanupStatus { intervalMs: number; lastRunAt: number | null; nextRunAt: number | null; lastRemoved: number | null; lastError: string | null }

const enc = encodeURIComponent;

/**
 * A thin client for the Great Eagle systems mock's HTTP contract. An unreachable mock is a 502; the mock's own
 * 409 (an illegal request transition) passes through with its text; any other failure answer is a 502.
 */
export class MockClient {
  constructor(
    readonly baseUrl: string,
    readonly timeoutMs = 10_000,
  ) {}

  getUserFacts(key: string): Promise<TrustFacts | null> {
    return find(this, `/api/trust/users/${enc(key)}`);
  }

  getOrg(key: string): Promise<MockOrg | null> {
    return find(this, `/api/trust/orgs/${enc(key)}`);
  }

  createOrg(key: string, name: string): Promise<MockOrg> {
    return send(this, 'POST', '/api/trust/orgs', { key, name });
  }

  associateEan(ean: string, org: string, proof: string, by: string): Promise<EanAssociation> {
    return send(this, 'POST', `/api/accounts/eans/${enc(ean)}/associate`, { org, proof, by });
  }

  listRequests(filter: RequestFilter = {}): Promise<DemoRequest[]> {
    const query = new URLSearchParams();
    if (filter.status) query.append('status', filter.status);
    for (const type of [filter.type ?? []].flat()) query.append('type', type);
    for (const name of ['tenant', 'requested_for', 'initiated_by'] as const) {
      const value = filter[name];
      if (value !== undefined) query.append(name, value);
    }
    const qs = query.toString();
    return send(this, 'GET', `/api/requests${qs ? `?${qs}` : ''}`);
  }

  getRequest(id: string): Promise<DemoRequest | null> {
    return find(this, `/api/requests/${enc(id)}`);
  }

  createRequest(request: NewRequest): Promise<DemoRequest> {
    const body = Object.fromEntries(NEW_REQUEST_FIELDS.filter((field) => request[field] !== undefined).map((field) => [field, request[field]]));
    return send(this, 'POST', '/api/requests', body);
  }

  transition(id: string, to: RequestStatus, by: string, comment?: string, durationMs?: number): Promise<DemoRequest> {
    return send(this, 'POST', `/api/requests/${enc(id)}/transition`, { to, by, comment, duration_ms: durationMs });
  }

  listDocuments(shipment: string): Promise<Doc[]> {
    return send(this, 'GET', `/api/shipments/${enc(shipment)}/documents`);
  }

  addDocument(shipment: string, name: string, by: string): Promise<Doc> {
    return send(this, 'POST', `/api/shipments/${enc(shipment)}/documents`, { name, by });
  }

  async notify(user: string, text: string): Promise<void> {
    const res = await call(this, 'POST', '/api/notifications', { user, text });
    await res?.arrayBuffer(); // the answer carries nothing we need; reading it frees the connection
  }

  cleanupStatus(): Promise<CleanupStatus> {
    return send(this, 'GET', '/api/cleanup/status');
  }

  /** S5: registers a connector. The answer is the only one that carries its client secret: never log it or keep it. A taken key is a 409. */
  registerIntegration(i: NewIntegration): Promise<RegisteredIntegration> {
    return send(this, 'POST', '/api/integrations', { key: i.key, name: i.name, owner: i.owner, customer: i.customer });
  }

  /**
   * S5: whose credential `secret` is, or null when the registry does not know it (its 401). Any other failure, an
   * unreachable registry included, is an error: a failed lookup is never read as an unknown credential.
   */
  async resolveIntegration(secret: string): Promise<IntegrationIdentity | null> {
    const res = await call(this, 'POST', '/api/integrations/resolve', { client_secret: secret }, 401);
    return res === null ? null : json<IntegrationIdentity>(res);
  }

  /** S5: every connector, oldest first, without secrets. */
  listIntegrations(): Promise<MockIntegration[]> {
    return send(this, 'GET', '/api/integrations');
  }

  /** S5: records a shipment a connector created, once the portal has authorized it. */
  createShipment(s: NewShipment): Promise<MockShipment> {
    return send(this, 'POST', '/api/shipments', { ean: s.ean, title: s.title, created_by: s.created_by });
  }

  /** S5: the shipments connectors created on `ean`, oldest first. */
  listShipments(ean: string): Promise<MockShipment[]> {
    return send(this, 'GET', `/api/shipments?ean=${enc(ean)}`);
  }
}

/** `nullOn`: the one failure status that is an answer in itself (404 for a missing record, 401 for an unknown credential), read as null. */
async function call(client: MockClient, method: string, path: string, body?: unknown, nullOn?: number): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetch(`${client.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(client.timeoutMs),
    });
  } catch (e) {
    throw new HttpError(502, `Great Eagle systems mock is unreachable: ${messageOf(e)}`);
  }
  if (res.ok) return res;
  const error = await errorText(res);
  if (res.status === nullOn) return null;
  if (res.status === 409) throw new HttpError(409, error ?? 'The Great Eagle systems mock refused the change');
  throw new HttpError(502, `Great Eagle systems mock answered ${res.status}${error ? `: ${error}` : ''}`);
}

async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new HttpError(502, `Great Eagle systems mock sent an unreadable answer: ${messageOf(e)}`);
  }
}

async function send<T>(client: MockClient, method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(client, method, path, body);
  if (res === null) throw new HttpError(502, 'Great Eagle systems mock answered 404');
  return json<T>(res);
}

async function find<T>(client: MockClient, path: string): Promise<T | null> {
  const res = await call(client, 'GET', path, undefined, 404);
  return res === null ? null : json<T>(res);
}

async function errorText(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}
