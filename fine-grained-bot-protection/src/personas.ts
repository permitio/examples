/**
 * The callers the demo page can send a request as, one per user set in the policy. Each is only a
 * User-Agent: the page replaces the browser's own with it before the request is classified.
 */
export interface Persona {
  key: string;
  label: string;
  summary: string;
  /** null: the request goes without a User-Agent. */
  userAgent: string | null;
}

export const PERSONAS = [
  {
    key: 'human',
    label: 'Human',
    summary: 'Chrome on a desktop',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/142.0.0.0 Safari/537.36',
  },
  {
    key: 'trusted-bot',
    label: 'Trusted bot',
    summary: 'curl, which says what it is',
    userAgent: 'curl/8.11.1',
  },
  {
    key: 'untrusted-bot',
    label: 'Untrusted bot',
    summary: 'Headless Chrome, posing as a browser',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'HeadlessChrome/142.0.0.0 Safari/537.36',
  },
  {
    key: 'evil-bot',
    label: 'Evil bot',
    summary: 'Sends no User-Agent at all',
    userAgent: null,
  },
] as const satisfies readonly Persona[];

export function findPersona(key: string): Persona | undefined {
  return PERSONAS.find((p) => p.key === key);
}
