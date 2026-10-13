// Which routes the persona header guards. The integration API is called server to server with the
// connector's own credential, never as a persona, while S2's and S5's own APIs are persona routes
// like the rest.
// They pin where each router sits, not what it answers.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from '#test/fakes';

const PICK_A_PERSONA = { error: 'Pick a persona' };

describe('routing', () => {
  it('the integration API answers without a persona header', async () => {
    const { app } = harness();
    for (const call of [
      request(app).get('/api/integration/shipments?ean=EAN-1001'),
      request(app).post('/api/integration/shipments').send({ ean: 'EAN-1001', title: 't' }),
    ]) {
      const res = await call;
      expect(res.body).not.toEqual(PICK_A_PERSONA);
      expect(res.status).not.toBe(404);
    }
  });

  it('the integration API does not answer for a persona route that only starts like it', async () => {
    const { app } = harness();
    expect((await request(app).get('/api/integrations')).body).toEqual(PICK_A_PERSONA);
  });

  it('S2 and S5 still need a persona', async () => {
    const { app } = harness();
    for (const path of ['/api/s2/team', '/api/s5/integrations']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body, path).toEqual(PICK_A_PERSONA);
    }
  });

  it('with a persona, S2 and S5 have routers of their own, and answer', async () => {
    const { app } = harness();
    for (const path of ['/api/s2/team', '/api/s5/integrations']) {
      const res = await request(app).get(path).set('x-demo-persona', 'sam');
      expect(res.status, path).toBe(200);
    }
    // The plain harness's systems mock is a whole MockClient: S5's registry answers, with nothing
    // registered.
    expect(
      (await request(app).get('/api/s5/integrations').set('x-demo-persona', 'sam')).body,
    ).toEqual({ integrations: [] });
  });
});
