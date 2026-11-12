import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/account/api/elements-login/route';
import { appRequest, prepareDatabase, signedIn } from '@/test/auth';
import { permitApiError } from '@/test/fake-permit';
import { fakePermit } from '@/test/permit-client';

vi.mock('permitio', async (original) => ({
  ...(await original<typeof import('permitio')>()),
  Permit: (await import('@/test/fake-permit')).FakePermit,
}));

let cookie: string;

beforeAll(async () => {
  await prepareDatabase();
  cookie = await signedIn('alice@mesaverde.example');
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /account/api/elements-login', () => {
  it('answers 401 without a session and 400 without an account', async () => {
    expect((await GET(appRequest('/account/api/elements-login?tenant=a'))).status).toBe(401);
    expect((await GET(appRequest('/account/api/elements-login', { cookie }))).status).toBe(400);
    expect(fakePermit().elements.loginAs).not.toHaveBeenCalled();
  });

  it("redirects to Permit's login URL for the signed-in user in the account", async () => {
    const redirectUrl = 'http://localhost:8000/v2/auth/login_elements?token=one-time';
    fakePermit().elements.loginAs.mockResolvedValue({
      redirect_url: redirectUrl,
      content: { url: redirectUrl },
    });

    const response = await GET(
      appRequest('/account/api/elements-login?tenant=alice-mesaverde-example', { cookie }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(redirectUrl);
    expect(fakePermit().elements.loginAs).toHaveBeenCalledWith({
      userId: 'alice@mesaverde.example',
      tenantId: 'alice-mesaverde-example',
    });
  });

  it('answers 502 when Permit refuses the login', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakePermit().elements.loginAs.mockRejectedValue(permitApiError(403));
    const response = await GET(appRequest('/account/api/elements-login?tenant=x', { cookie }));
    expect(response.status).toBe(502);
  });
});
