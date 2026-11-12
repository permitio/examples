import { PermitPDPStatusError } from 'permitio';
import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { permitFake } from '#test/permit-fake';
import { GET as getHealthPlan } from '@/app/api/account/dashboard/health-plan/[[...user]]/route';
import { GET as getMedicalRecords } from '@/app/api/account/dashboard/medical-records/[[...user]]/route';
import { healthPlanFor, medicalRecordsFor } from '@/lib/demo-data';

let morty: Member;

beforeAll(async () => {
  await setUpDatabase();
  morty = await signUp('Morty');
});

const routes = [
  { name: 'health-plan', handler: getHealthPlan, type: 'health_plan' },
  { name: 'medical-records', handler: getMedicalRecords, type: 'medical_records' },
] as const;

describe.each(routes)('GET /api/account/dashboard/$name', ({ name, handler, type }) => {
  const path = `/api/account/dashboard/${name}`;

  it('answers 401 without a session', async () => {
    const response = await handler(request(path), params({}));
    expect(response.status).toBe(401);
  });

  it("returns the member's own data after checking read on their instance", async () => {
    const response = await handler(request(path, { cookie: morty.cookie }), params({}));
    expect(response.status).toBe(200);
    expect(permitFake.check).toHaveBeenCalledWith(morty.id, 'read', {
      type,
      key: `${type}_${morty.id}`,
    });
    const expected = type === 'health_plan' ? healthPlanFor(morty.id) : medicalRecordsFor(morty.id);
    expect(await body(response)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("checks another member's instance when a caregiver opens it", async () => {
    const response = await handler(
      request(`${path}/rick`, { cookie: morty.cookie }),
      params({ user: ['rick'] }),
    );
    expect(response.status).toBe(200);
    expect(permitFake.check).toHaveBeenCalledWith(morty.id, 'read', { type, key: `${type}_rick` });
  });

  it('answers 403 when Permit denies', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    const response = await handler(
      request(`${path}/homer`, { cookie: morty.cookie }),
      params({ user: ['homer'] }),
    );
    expect(response.status).toBe(403);
  });

  it('answers 502 when the PDP returns an error', async () => {
    permitFake.check.mockRejectedValueOnce(new PermitPDPStatusError('PDP answered 500'));
    const response = await handler(request(path, { cookie: morty.cookie }), params({}));
    expect(response.status).toBe(502);
  });
});
