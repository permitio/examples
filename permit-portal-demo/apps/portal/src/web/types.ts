// Shapes of the portal HTTP API, mirrored here so the browser bundle carries no server code.

export type RequestType =
  | 'collaborator_invite' | 'renewal' | 'first_admin' | 'member_invite' | 'admin_transfer' | 'ean_association' | 'integration_access';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'canceled' | 'revoked' | 'expired';

export interface HistoryEntry {
  at: string;
  status: RequestStatus;
  by: string;
  comment?: string;
}

export interface DemoRequest {
  id: string;
  type: RequestType;
  tenant: string;
  target: string;
  role?: string;
  requested_for: string;
  initiated_by: string;
  reason?: string;
  duration_ms?: number;
  requested_days?: number;
  org_name?: string;
  status: RequestStatus;
  reviewer?: string;
  reviewer_comment?: string;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
}

export interface TrustFacts {
  identity_verified: boolean;
  duplicate_check: 'clear' | 'suspected' | 'confirmed';
  risk_state: 'ok' | 'suspended';
}

export interface Persona {
  key: string;
  name: string;
  company: string;
  title: string;
}

export interface Shipment {
  key: string;
  ean: string;
  tenant: string;
  title: string;
}

/** GET /api/meta */
export interface Meta {
  profile: string;
  permitAppUrl: string;
  demoClock: { enabled: boolean; offsetMs: number };
  grantDemoDurationMs: number;
  personas: Persona[];
  shipments: Shipment[];
}

/**
 * What made the portal record an event: something the presenter did, a page re-reading itself in the background
 * (requests sent with `x-demo-source: refresh`), or a guard the portal runs on its own, such as the last-admin check.
 */
export type EventSource = 'action' | 'refresh' | 'guard';

export interface CheckEvent {
  id: number;
  kind: 'check';
  at: number;
  user: string;
  action: string;
  resource: string;
  tenant: string;
  allow: boolean;
  ms: number;
  bulk?: number;
  label?: string;
  input: unknown;
  /** Set when the check failed before the PDP answered. */
  error?: string;
  source?: EventSource;
}

export interface WriteEvent {
  id: number;
  kind: 'write';
  at: number;
  what: string;
  ms: number;
  ok: boolean;
  error?: string;
  source?: EventSource;
}

/**
 * A question the PDP answers with a list, not a yes or no: S2's "What I can do" reads a user's permissions. It carries the
 * request as it was sent and how many entries came back, and no decision: the panel shows it without one, makes no sign
 * of it and has no reason to replay.
 */
export interface ReadEvent {
  id: number;
  kind: 'read';
  at: number;
  user: string;
  tenants: string[];
  ms: number;
  /** The request as the portal sent it to the PDP's POST /user-permissions. */
  request: unknown;
  /** How many entries the PDP listed, one per resource. Absent when the read failed. */
  entries?: number;
  /** Set when the read failed before the PDP answered. */
  error?: string;
  source?: EventSource;
}

export type DemoEvent = CheckEvent | WriteEvent | ReadEvent;

/** GET /api/events?since=N */
export interface EventsResponse {
  events: DemoEvent[];
  lastId: number;
}

/** POST /api/events/:id/explain: the PDP's reason for the recorded check, replayed now. */
export interface ExplainResponse {
  reason: unknown;
  allow: boolean;
}

/** POST /api/clock/advance and /api/clock/reset */
export interface ClockResponse {
  offsetMs: number;
}

export interface CheckResource {
  type: string;
  key: string;
  tenant: string;
  attributes?: Record<string, unknown>;
}

/** POST /api/checks/bulk */
export interface BulkCheckRequest {
  checks: Array<{ action: string; resource: CheckResource }>;
}

export interface BulkCheckResponse {
  results: Array<{ allow: boolean }>;
  ms: number;
}

/** GET /api/s4/shipments */
export interface ShipmentsResponse {
  shipments: Shipment[];
  shared: DemoRequest[];
}

export type ShipmentAction = 'view' | 'upload_docs' | 'invite_collaborator' | 'approve_collaborator' | 'revoke_collaborator' | 'request_renewal';

export interface Collaborator {
  user: string;
  // Null-tolerant: a requested_for whose grant entry is gone (revoked, or cleaned up) may come back without one.
  expires: number | null;
  renewals_used: number | null;
  active: boolean;
}

export interface Doc {
  name: string;
  by: string;
  at: string | number;
}

/** GET /api/s4/shipments/:key */
export interface ShipmentDetail {
  shipment: Shipment;
  can: Partial<Record<ShipmentAction, boolean>>;
  collaborators: Collaborator[];
  documents: Doc[];
  requests: DemoRequest[];
}

/** POST /api/s4/shipments/:key/revoke */
export interface RevokeResponse {
  ms: number;
}

/** GET /api/approvals */
export interface ApprovalsResponse {
  requests: DemoRequest[];
}

/** POST /api/requests/:id/approve */
export interface ApproveResponse {
  request: DemoRequest;
  ms: number;
}

/** POST /api/requests/:id/deny */
export interface DenyResponse {
  request: DemoRequest;
}

/** GET /api/cleanup/status, the mock's cleanup job proxied unchanged. Times are epoch ms, null before the first run. */
export interface CleanupStatus {
  intervalMs: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastRemoved: number | null;
  lastError: string | null;
}

export interface OrgSummary {
  key: string;
  name?: string;
}

/** POST /api/s1/organizations */
export interface CreateOrgResponse {
  org: OrgSummary;
  request: DemoRequest;
}

export type OrgAction = 'view_own_request' | 'view_profile' | 'manage_members' | 'invite' | 'transfer_admin' | 'request_ean_association';

/** GET /api/s1/organizations/:key */
export interface OrgDetail {
  org: OrgSummary;
  can: Partial<Record<OrgAction, boolean>>;
  facts: { user: TrustFacts | null; ownership_verified: boolean };
  members: Array<{ user: string; roles: string[] }>;
  eans: Array<{ key: string; visible: boolean }>;
  requests: DemoRequest[];
}

/** POST /api/s1/organizations/:key/ean-associations */
export interface EanAssociationResponse {
  ean: string;
  ms: number;
}

/** GET /api/s1/reviewer-queue */
export interface ReviewerQueueResponse {
  requests: Array<{ request: DemoRequest; facts: TrustFacts | null; ownership_verified: boolean }>;
}
