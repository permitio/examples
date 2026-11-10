/**
 * The headers that tell the server who is asking: the app has no sign-in, so the user switcher's
 * current user and city travel with each request. `accept` makes the server answer errors as JSON.
 */
export function callerHeaders(user: string, city: string): Record<string, string> {
  return { user, city, accept: 'application/json' };
}

/** The server's message from a failed `$fetch` or `useFetch`, or the error's own message. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const { data } = error;
    if (typeof data === 'object' && data !== null && 'message' in data) {
      if (typeof data.message === 'string' && data.message !== '') return data.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether a failed `$fetch` or `useFetch` was a 403: Permit denied the action. */
export function isDenied(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403
  );
}
