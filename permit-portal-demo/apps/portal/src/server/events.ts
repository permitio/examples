import type { IUser } from 'permitio';
import type { CheckInput } from './permit/explainer';

/**
 * Why a check ran: a persona's own `action`, a page's background `refresh` (the request said `x-demo-source:
 * refresh`), or a `guard` the portal runs inside a flow, such as the last-admin guard.
 */
export type EventSource = 'action' | 'refresh' | 'guard';

export interface CheckEvent {
  id: number; kind: 'check'; at: number; user: string; action: string; resource: string; tenant: string; source: EventSource;
  allow: boolean; ms: number; bulk?: number; label?: string; input: CheckInput; reason?: unknown; error?: string;
}
export interface WriteEvent { id: number; kind: 'write'; at: number; what: string; ms: number; ok: boolean; error?: string }
/**
 * A question the PDP answers with a list, not a yes or no: S2's "What I can do" asks for a user's permissions
 * (permit.getUserPermissions). It has no decision, so the panel shows it without one, makes no directory sign of it and
 * has no reason to replay.
 */
export interface ReadEvent {
  id: number; kind: 'read'; at: number; user: string; tenants: string[]; source: EventSource; ms: number;
  /** The request exactly as the portal sent it through the SDK to the PDP's POST /user-permissions. */
  request: { user: IUser; tenants: string[] };
  /** How many entries the PDP listed, one per resource. Absent when the read failed: a failed read lists nothing. */
  entries?: number;
  error?: string;
}
export type DemoEvent = CheckEvent | WriteEvent | ReadEvent;

/** The decision panel's feed: every check, read and write, oldest first, keeping the newest `capacity` events. */
export class EventLog {
  private readonly events: DemoEvent[] = [];
  private last = 0;

  constructor(private readonly capacity = 500) {}

  push(e: Omit<CheckEvent, 'id'> | Omit<WriteEvent, 'id'> | Omit<ReadEvent, 'id'>): number {
    this.last += 1;
    this.events.push({ ...e, id: this.last });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return this.last;
  }

  /** The event with this id, while the log still holds it. */
  get(id: number): DemoEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Adds what arrives after the decision (the PDP's reason, on demand) to a check event that is still held. */
  patch(id: number, partial: Partial<CheckEvent>): void {
    const event = this.get(id);
    if (event?.kind === 'check') Object.assign(event, partial, { id: event.id, kind: event.kind });
  }

  since(id: number): DemoEvent[] {
    return this.events.filter((e) => e.id > id);
  }

  lastId(): number {
    return this.last;
  }
}
