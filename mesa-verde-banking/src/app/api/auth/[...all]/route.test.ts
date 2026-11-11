import { beforeAll, describe, expect, it } from 'vitest';
import { GET, POST } from '@/app/api/auth/[...all]/route';
import { appRequest, prepareDatabase } from '@/test/auth';

const ORIGIN = { origin: 'http://localhost:3000' };
const USER = { email: 'erin@mesaverde.example', password: 'erin-password-1', name: 'Erin' };

beforeAll(async () => {
  await prepareDatabase();
});

describe('/api/auth (Better Auth)', () => {
  it('signs a user up and keeps their session', async () => {
    const signUp = await POST(
      appRequest('/api/auth/sign-up/email', { method: 'POST', body: USER, headers: ORIGIN }),
    );
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/session_token=/);

    const session = await GET(appRequest('/api/auth/get-session', { cookie: cookie ?? '' }));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: USER.email, name: USER.name } });
  });

  it('signs in with the right password only', async () => {
    const signIn = (password: string) =>
      POST(
        appRequest('/api/auth/sign-in/email', {
          method: 'POST',
          body: { email: USER.email, password },
          headers: ORIGIN,
        }),
      );
    expect((await signIn(USER.password)).status).toBe(200);
    expect((await signIn('wrong-password')).status).toBe(401);
  });

  it("keeps the email-OTP plugin's endpoints off the HTTP API", async () => {
    for (const path of [
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/email-otp/check-verification-otp',
      '/api/auth/sign-in/email-otp',
      '/api/auth/email-otp/reset-password',
    ]) {
      const response = await POST(
        appRequest(path, {
          method: 'POST',
          body: { email: USER.email, type: 'sign-in', otp: '123456' },
          headers: ORIGIN,
        }),
      );
      expect(response.status).toBe(404);
    }
  });
});
