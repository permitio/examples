import type { IResource, IUser } from 'permitio';
import { messageOf } from '../errors';

/** One check, exactly as the enforcer sends it to the PDP. */
export interface CheckInput { user: IUser; action: string; resource: IResource }

/**
 * The PDP's answer to a replayed check: Permit's own reason (the `debug` block verbatim, null when debug mode is
 * off, or `{ error }` when the replay failed) and the replay's decision (null when the PDP gave none).
 */
export interface Explanation { reason: unknown; allow: boolean | null }

/** Replays a recorded check against the PDP. It never throws: a failure comes back as an `{ error }` reason. */
export interface Explainer { explain(input: CheckInput): Promise<Explanation> }

/**
 * Sends a check's input to the PDP's `POST /allowed`. With debug mode on, the answer carries a `debug` block with
 * Permit's code and reason for each policy model; the SDK returns only the boolean, which is why this call exists.
 * It runs only when someone asks for a reason, so a decision appears in Permit's Audit Log a second time
 * only when the presenter expands it.
 */
export class PdpExplainer implements Explainer {
  private readonly url: string;

  constructor(
    pdpUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 5_000,
  ) {
    this.url = `${pdpUrl.replace(/\/+$/, '')}/allowed`;
  }

  async explain(input: CheckInput): Promise<Explanation> {
    try {
      // Not the SDK: the PDP's own POST /allowed, because permit.check returns only true or false, without the reason.
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ ...input, context: {} }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { reason: { error: `PDP answered ${res.status}` }, allow: null };
      const body: unknown = await res.json();
      const { debug, allow } = typeof body === 'object' && body !== null ? (body as { debug?: unknown; allow?: unknown }) : {};
      return { reason: debug ?? null, allow: typeof allow === 'boolean' ? allow : null };
    } catch (e) {
      return { reason: { error: messageOf(e) }, allow: null };
    }
  }
}
