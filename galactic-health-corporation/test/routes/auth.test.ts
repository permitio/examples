import { beforeAll, describe, expect, it } from 'vitest';
import { body, request, setUpDatabase } from '#test/http';
import { permitApiError, permitFake } from '#test/permit-fake';
import { POST } from '@/app/api/auth/[...all]/route';

beforeAll(setUpDatabase);

const profile = {
  password: 'summer-password',
  name: 'Summer Smith',
  firstName: 'Summer',
  lastName: 'Smith',
  phoneNumber: '(555) 010-0005',
  dateOfBirth: '2003-06-01',
};

function authRequest(path: string, payload: unknown) {
  const req = request(`/api/auth/${path}`, { method: 'POST', body: payload });
  req.headers.set('origin', 'http://localhost:3000');
  return req;
}

describe('POST /api/auth/sign-up/email', () => {
  it('creates the account, signs the member in and registers them in Permit as owner', async () => {
    const response = await POST(
      authRequest('sign-up/email', { ...profile, email: 'summer@example.com' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(';')).toContain('better-auth.session_token=');
    const { user } = await body<{ user: { id: string } }>(response);
    expect(permitFake.api.users.sync).toHaveBeenCalledWith({
      key: user.id,
      email: 'summer@example.com',
      first_name: 'Summer',
      last_name: 'Smith',
      attributes: { phoneNumber: '(555) 010-0005', dateOfBirth: '2003-06-01' },
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: user.id,
      role: 'owner',
      resource_instance: `member:member_${user.id}`,
      tenant: 'default',
    });
    for (const type of ['profile', 'health_plan', 'medical_records']) {
      expect(permitFake.api.relationshipTuples.create).toHaveBeenCalledWith({
        subject: `member:member_${user.id}`,
        relation: 'parent',
        object: `${type}:${type}_${user.id}`,
        tenant: 'default',
      });
    }
  });

  it('undoes the sign-up when Permit cannot register the member', async () => {
    const email = 'beth@example.com';
    permitFake.api.users.sync.mockRejectedValueOnce(permitApiError(500, 'Permit is down'));

    const failed = await POST(authRequest('sign-up/email', { ...profile, email }));
    expect(failed.status).toBe(502);

    const signIn = await POST(authRequest('sign-in/email', { email, password: profile.password }));
    expect(signIn.status).toBe(401);

    const retried = await POST(authRequest('sign-up/email', { ...profile, email }));
    expect(retried.status).toBe(200);
  });

  it('rejects a sign-up without the profile fields', async () => {
    const response = await POST(
      authRequest('sign-up/email', {
        email: 'jerry@example.com',
        password: 'jerry-password',
        name: 'Jerry',
      }),
    );
    expect(response.status).toBe(400);
    expect(permitFake.api.users.sync).not.toHaveBeenCalled();
  });
});
