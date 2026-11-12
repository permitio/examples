import { Permit } from 'permitio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('permitio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('permitio')>()),
  Permit: vi.fn(function Permit() {
    return {};
  }),
}));

/** A fresh copy of the module, so its cached client does not carry over between tests. */
const loadClient = async () => (await import('#server/utils/permit')).permit;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(Permit).mockClear();
  vi.stubEnv('PERMIT_API_KEY', 'test-api-key');
  vi.stubEnv('PERMIT_PDP_URL', 'http://pdp:7000');
  vi.stubEnv('PERMIT_API_URL', 'http://host.docker.internal:8000');
});
afterEach(() => vi.unstubAllEnvs());

describe('permit()', () => {
  it('sends checks to the PDP and writes to the API, with the SDK log off', async () => {
    const permit = await loadClient();

    permit();

    expect(Permit).toHaveBeenCalledWith({
      token: 'test-api-key',
      pdp: 'http://pdp:7000',
      apiUrl: 'http://host.docker.internal:8000',
      log: { level: 'silent' },
    });
  });

  it("uses Permit's cloud API when PERMIT_API_URL is empty", async () => {
    vi.stubEnv('PERMIT_API_URL', '');
    const permit = await loadClient();

    permit();

    expect(Permit).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://api.permit.io' }),
    );
  });

  it('makes one client and reuses it', async () => {
    const permit = await loadClient();

    expect(permit()).toBe(permit());
    expect(Permit).toHaveBeenCalledTimes(1);
  });

  it.each(['PERMIT_API_KEY', 'PERMIT_PDP_URL'])(
    'fails with a pointer when %s is missing',
    async (name) => {
      vi.stubEnv(name, '');
      const permit = await loadClient();

      expect(() => permit()).toThrow(`${name} is not set.`);
    },
  );
});
