import { PermitApiError } from 'permitio';

/**
 * One line per error in the `cause` chain. A Permit API error adds its HTTP status and the body
 * Permit answered with, which says what was wrong with the request.
 */
export function describeError(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  while (current !== undefined) {
    if (current instanceof PermitApiError) {
      const status = current.response?.status ?? 'no response';
      const body: unknown = current.response?.data;
      lines.push(`${current.message} (HTTP ${status}) ${JSON.stringify(body) ?? ''}`.trimEnd());
    } else if (current instanceof Error) {
      lines.push(current.message);
    } else {
      lines.push(String(current));
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join('\n  caused by: ');
}
