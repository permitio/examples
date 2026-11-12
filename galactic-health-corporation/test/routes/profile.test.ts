import { PermitConnectionError } from 'permitio';
import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { permitApiError, permitFake, permitUser } from '#test/permit-fake';
import { GET } from '@/app/api/account/profile/[[...user]]/route';

let rick: Member;

beforeAll(async () => {
  await setUpDatabase();
  rick = await signUp('Rick');
});

const profileOf = (user?: string[]) => params(user === undefined ? {} : { user });

describe('GET /api/account/profile', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(request('/api/account/profile'), profileOf());
    expect(response.status).toBe(401);
    expect(permitFake.check).not.toHaveBeenCalled();
  });

  it("returns the member's own profile when Permit allows read on it", async () => {
    permitFake.api.users.get.mockResolvedValueOnce(
      permitUser(rick.id, {
        first_name: 'Rick',
        attributes: { phoneNumber: '(555) 1', dateOfBirth: '1950-03-04' },
      }),
    );
    const response = await GET(
      request('/api/account/profile', { cookie: rick.cookie }),
      profileOf(),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      id: rick.id,
      firstName: 'Rick',
      phoneNumber: '(555) 1',
      dateOfBirth: '1950-03-04',
      relationship: 'Self',
    });
    expect(permitFake.check).toHaveBeenCalledWith(rick.id, 'read', {
      type: 'profile',
      key: `profile_${rick.id}`,
    });
  });

  it("checks the other member's profile instance and leaves the relationship empty", async () => {
    permitFake.api.users.get.mockResolvedValueOnce(permitUser('morty'));
    const response = await GET(
      request('/api/account/profile/morty', { cookie: rick.cookie }),
      profileOf(['morty']),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id: 'morty', relationship: '' });
    expect(permitFake.check).toHaveBeenCalledWith(rick.id, 'read', {
      type: 'profile',
      key: 'profile_morty',
    });
  });

  it('answers 403 and reads nothing when Permit denies', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    const response = await GET(
      request('/api/account/profile/homer', { cookie: rick.cookie }),
      profileOf(['homer']),
    );
    expect(response.status).toBe(403);
    expect(permitFake.api.users.get).not.toHaveBeenCalled();
  });

  it('answers 503 when the PDP is unreachable', async () => {
    permitFake.check.mockRejectedValueOnce(new PermitConnectionError('connect ECONNREFUSED'));
    const response = await GET(
      request('/api/account/profile', { cookie: rick.cookie }),
      profileOf(),
    );
    expect(response.status).toBe(503);
  });

  it("answers 502 with Permit's message when the API fails", async () => {
    permitFake.api.users.get.mockRejectedValueOnce(permitApiError(500, 'database is down'));
    const response = await GET(
      request('/api/account/profile', { cookie: rick.cookie }),
      profileOf(),
    );
    expect(response.status).toBe(502);
    expect(await body(response)).toMatchObject({ detail: 'database is down' });
  });
});
