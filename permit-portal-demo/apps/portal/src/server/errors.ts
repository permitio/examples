/** An error the API answers with its own status and `{ error: message }`; the message is shown on screen. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Permit answered deny: the API answers `403 { error, decision: 'deny' }`. */
export class DeniedError extends HttpError {
  constructor(message: string) {
    super(403, message);
  }
}

export function deniedBy(action: string, ref: { type: string; key: string }): DeniedError {
  return new DeniedError(`Permit denied ${action} on ${ref.type}:${ref.key}.`);
}

/** A failure's message. Node's fetch says only "fetch failed" and keeps the useful part in `cause`. */
export function messageOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined;
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

/** The HTTP status an SDK error carries (`PermitApiError.status`), if any. */
export const statusOf = (e: unknown) => (typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined);

/** The SDK's errors for its API calls: `PermitContextError` for the API key's scope, `PermitApiError` for the rest. */
const PERMIT_API_ERRORS: ReadonlySet<string> = new Set(['PermitContextError', 'PermitApiError']);
/** Key- and token-shaped text: the SDK already redacts its messages, and this removes anything it might have missed. */
const SECRETS: ReadonlyArray<[RegExp, string]> = [
  [/\bbearer\s+[^\s,;)]+/gi, 'Bearer [redacted]'],
  [/permit_key_\w+/g, '[redacted]'],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[redacted]'],
  [/\b(token|authorization|api[_-]?key)(\s*[:=]\s*|\s+)(?!bearer\b|\[redacted\])[^\s,;)]+/gi, '$1$2[redacted]'],
];

/** Why a Permit API call failed, for the screen: "Permit API unreachable: …" when it got no answer, else the error's own message. */
export function permitReason(e: unknown): string {
  return permitUnreachable(e) ?? messageOf(e);
}

/**
 * The on-screen text for a Permit API call that got no answer at all (a network error or a timeout, so no HTTP
 * status): "Permit API unreachable: <short reason>", the reason being the network error's code (ECONNREFUSED,
 * ETIMEDOUT, …) or else the scrubbed message. Undefined for anything else, including an error Permit answered.
 */
export function permitUnreachable(e: unknown): string | undefined {
  if (!(e instanceof Error) || !PERMIT_API_ERRORS.has(e.name) || statusOf(e) !== undefined) return undefined;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) return `Permit API unreachable: ${code}`;
  let reason = e.message.replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of SECRETS) reason = reason.replace(pattern, replacement);
  return `Permit API unreachable: ${reason.length > 120 ? `${reason.slice(0, 117)}...` : reason || 'no answer'}`;
}
