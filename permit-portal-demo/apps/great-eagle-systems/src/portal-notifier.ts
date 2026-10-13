export type Subject = 'user' | 'org';
/** What a notification came to. Failures are values, never exceptions, so a route can always answer. */
export type NotifyResult = { ok: true } | { error: string };
export type CleanupResult = { removed: number } | { error: string };

/** The portal's internal API, as the mock calls it. */
export interface PortalNotifier {
  /** Tells the portal that a trust fact changed, so it writes the new facts to Permit. */
  factsChanged(subject: Subject, key: string): Promise<NotifyResult>;
  /** Asks the portal to remove expired grant entries. */
  runCleanup(): Promise<CleanupResult>;
}

export interface NotifierOptions {
  /**
   * How long to wait for the portal. Its writes wait up to 5 s for the PDP, and a cleanup may make
   * several.
   */
  timeoutMs?: number | undefined;
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The reason a fetch failed: the socket error behind undici's generic "fetch failed", when there is
 * one.
 */
function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const { code, message } = (cause ?? {}) as { code?: unknown; message?: unknown };
  if (typeof message === 'string' && message !== '') return message;
  return typeof code === 'string' ? code : String(error);
}

/**
 * Calls the portal at PORTAL_INTERNAL_URL. A failure (unreachable, timed out, or a non-2xx answer)
 * is logged with the subject and key only, and returned as { error }; nothing here throws.
 */
export class HttpPortalNotifier implements PortalNotifier {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(baseUrl: string, options: NotifierOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? ((line) => console.error(line));
  }

  async factsChanged(subject: Subject, key: string): Promise<NotifyResult> {
    const answer = await this.post(
      '/internal/facts-changed',
      { subject, key },
      `facts-changed for ${subject} ${key}`,
    );
    return 'error' in answer ? answer : { ok: true };
  }

  async runCleanup(): Promise<CleanupResult> {
    const answer = await this.post('/internal/cleanup-expired', {}, 'cleanup-expired');
    if ('error' in answer) return answer;
    // `removed` is a count; a list of the removed grant entries is counted.
    const removed = (answer.body as { removed?: unknown } | undefined)?.removed;
    if (typeof removed === 'number') return { removed };
    if (Array.isArray(removed)) return { removed: removed.length };
    return this.fail('cleanup-expired', 'portal answered without a removed count');
  }

  private async post(
    path: string,
    payload: object,
    what: string,
  ): Promise<{ body: unknown } | { error: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      return this.fail(
        what,
        timedOut
          ? `portal did not answer within ${this.timeoutMs} ms`
          : `portal unreachable: ${reasonOf(error)}`,
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = (body as { error?: unknown } | undefined)?.error;
      return this.fail(
        what,
        `portal answered ${response.status}: ${typeof message === 'string' ? message : response.statusText}`,
      );
    }
    return { body };
  }

  private fail(what: string, reason: string): { error: string } {
    this.log(`great-eagle-systems: portal notification ${what} failed: ${reason}`);
    return { error: reason };
  }
}
