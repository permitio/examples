// Display formatting for the portal UI. Pure functions, so they are unit-tested without a browser.

import type { DemoRequest, RequestType, TrustFacts } from './types';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad2 = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Time left before a deadline: `m:ss`, `h:mm:ss` or `Nd h:mm:ss`, and `expired` once it has passed.
 * A part second counts as a whole one, so the display reads 0:01 up to the instant access ends.
 */
export function formatCountdown(ms: number): string {
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'expired';
  if (!Number.isFinite(ms)) return '—';
  const total = Math.ceil(ms / SECOND);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${minutes}:${pad2(seconds)}`;
}

/** How long a waited change took to be confirmed by the local PDP, in seconds to one decimal place. */
export function formatSeconds(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / SECOND).toFixed(1)} s` : '—';
}

/** A line under a replayed reason when the PDP now decides differently from the recorded check. */
export function replayNote(recordedAllow: boolean, replayedAllow: boolean): string | undefined {
  return recordedAllow === replayedAllow ? undefined : 'The data changed since this check; the reason reflects the current data.';
}

/** The durations an approver can give a collaborator's access, the demo's short one first (the default). */
export function grantDurations(demoMs: number): { label: string; ms: number }[] {
  return [
    { label: `${formatDuration(demoMs)} (demo)`, ms: demoMs },
    { label: '15 minutes', ms: 15 * MINUTE },
    { label: '1 hour', ms: HOUR },
    { label: '7 days', ms: 7 * DAY },
    { label: '30 days', ms: 30 * DAY },
  ];
}

/** A grant or request duration in the largest whole unit: "2 minutes", "7 days". */
export function formatDuration(ms: number): string {
  for (const [size, unit] of [
    [DAY, 'day'],
    [HOUR, 'hour'],
    [MINUTE, 'minute'],
  ] as const) {
    if (ms >= size && ms % size === 0) return plural(ms / size, unit);
  }
  return plural(Math.round(ms / SECOND), 'second');
}

/** The demo clock's offset as the badge shows it: "+60 min". */
export function formatOffset(offsetMs: number): string {
  return `${offsetMs < 0 ? '−' : '+'}${Math.round(Math.abs(offsetMs) / MINUTE)} min`;
}

/** Epoch milliseconds from a number or a date string; null when absent or unreadable. */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** How long ago something happened, coarsely: "just now", "10 min ago", "3 h ago", "2 d ago". */
export function formatRelative(at: string | number, now: number): string {
  const then = parseTime(at);
  if (then === null) return String(at);
  const ago = now - then;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  return `${Math.floor(ago / DAY)} d ago`;
}

/** Wall-clock time of day, to the second, in the viewer's locale. */
export function formatClock(at: unknown): string {
  const ms = parseTime(at);
  return ms === null ? '—' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Date and time, for timelines and documents. */
export function formatWhen(at: unknown): string {
  const ms = parseTime(at);
  if (ms === null) return '—';
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const REQUEST_TYPE_LABEL: Record<RequestType, string> = {
  collaborator_invite: 'Collaborator invitation',
  renewal: 'Access renewal',
  first_admin: 'First admin for a new organization',
  member_invite: 'Member invitation',
  admin_transfer: 'Admin handover',
  ean_association: 'EAN association',
  integration_access: 'Production access for an integration',
};

const ROLE_WORDS: Record<string, string> = {
  integration_client: 'View and create shipments',
  integration_reader: 'View shipments',
};

/** What a connector role allows, in words, for S5's pages and a production request's card; a role not named here shows as it is. */
export function roleWords(role: string): string {
  return ROLE_WORDS[role] ?? role;
}

/** How long a request asks for: a grant's duration, or a renewal's days. */
export function requestDuration(request: Pick<DemoRequest, 'duration_ms' | 'requested_days'>): string | undefined {
  if (request.duration_ms !== undefined) return formatDuration(request.duration_ms);
  if (request.requested_days !== undefined) return formatDuration(request.requested_days * DAY);
  return undefined;
}

export interface Check {
  label: string;
  allow: boolean | undefined;
}

/** The checks behind a `can` record, in a fixed order; an action the server did not answer has no result. */
export function canChecks<A extends string>(can: Partial<Record<A, boolean>> | undefined, actions: readonly A[]): Check[] {
  return actions.map((action) => ({ label: action, allow: can?.[action] }));
}

export interface FactItem {
  key: string;
  ok: boolean;
  text: string;
}

/** Great Eagle's trust facts for a user and an organization, each as a pass/fail line in words. */
export function trustFactItems(facts: TrustFacts | null, ownershipVerified: boolean): FactItem[] {
  const user: FactItem[] =
    facts === null
      ? [{ key: 'facts', ok: false, text: 'No identity facts on record' }]
      : [
          { key: 'identity', ok: facts.identity_verified, text: facts.identity_verified ? 'Identity verified' : 'Identity not verified' },
          {
            key: 'duplicate',
            ok: facts.duplicate_check === 'clear',
            text: facts.duplicate_check === 'clear' ? 'Duplicate check clear' : `Duplicate ${facts.duplicate_check}`,
          },
          { key: 'risk', ok: facts.risk_state === 'ok', text: facts.risk_state === 'ok' ? 'Risk ok' : `Risk ${facts.risk_state}` },
        ];
  return [...user, { key: 'ownership', ok: ownershipVerified, text: ownershipVerified ? 'Ownership verified' : 'Ownership not verified' }];
}

export interface RuleName {
  encoded: string;
  readable: string;
  kind: 'user set' | 'resource set';
}

// Permit encodes "_" inside a condition-set key as "_5f": userset_active_5fcollaborator is active_collaborator.
const RULE_NAME = /(?<![A-Za-z0-9])(userset|resourceset)_((?:[A-Za-z0-9]|_5f)+)/g;

export interface TimeName {
  label: string;
  ms: number;
}

/**
 * The epoch-millisecond times a check's input or a PDP reason carries (`current_time`, and each grant's `expires`,
 * labelled with its resource), once each. On screen they let a viewer compare the check's time with an expiry.
 */
export function timeLegend(value: unknown): TimeName[] {
  const found = new Map<string, TimeName>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    for (const [k, child] of Object.entries(obj)) {
      if ((k === 'current_time' || k === 'expires') && typeof child === 'number' && child > 1e12) {
        const label = k === 'expires' && typeof obj.resource === 'string' ? `expires (${obj.resource})` : k;
        if (!found.has(label)) found.set(label, { label, ms: child });
      } else {
        walk(child);
      }
    }
  };
  walk(value);
  return [...found.values()];
}

/** A date and clock time to the millisecond, for comparing a check's time with an expiry. */
export function formatPrecise(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** The encoded rule names a PDP reason mentions, each mapped once to the name the policy was written with. */
export function ruleLegend(reason: unknown): RuleName[] {
  if (reason === undefined || reason === null) return [];
  const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
  const names = new Map<string, RuleName>();
  for (const [encoded, prefix, name] of text.matchAll(RULE_NAME)) {
    if (!prefix || !name || names.has(encoded)) continue;
    names.set(encoded, { encoded, readable: name.replaceAll('_5f', '_'), kind: prefix === 'userset' ? 'user set' : 'resource set' });
  }
  return [...names.values()];
}
