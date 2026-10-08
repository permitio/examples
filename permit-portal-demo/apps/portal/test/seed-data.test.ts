import { describe, expect, it } from 'vitest';
import { loadSeed } from '../src/server/model';

const seed = loadSeed();

describe('demo-data/seed.json', () => {
  it('has unique persona keys', () => {
    const keys = seed.personas.map((p) => p.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("puts every shipment on a known EAN owned by the shipment's tenant", () => {
    expect(seed.shipments.length).toBeGreaterThan(0);
    for (const shipment of seed.shipments) {
      const ean = seed.eans.find((e) => e.key === shipment.ean);
      expect(ean, `${shipment.key}: unknown EAN ${shipment.ean}`).toBeDefined();
      const owner = seed.organizations.find((o) => o.key === ean?.org);
      expect(owner?.key, `${shipment.key}: ${shipment.ean} is not owned by ${shipment.tenant}`).toBe(shipment.tenant);
    }
  });

  it('files every request for a known persona', () => {
    const personas = new Set(seed.personas.map((p) => p.key));
    expect(seed.requests.length).toBeGreaterThan(0);
    for (const request of seed.requests) {
      expect(personas.has(request.requested_for), `${request.id}: unknown persona ${request.requested_for}`).toBe(true);
    }
  });

  it.each(['eowyn', 'eomer', 'grima', 'sam', 'frodo'])('gives %s a complete set of trust facts', (key) => {
    const persona = seed.personas.find((p) => p.key === key);
    expect(persona?.facts).toEqual({
      identity_verified: expect.any(Boolean),
      duplicate_check: expect.stringMatching(/^(clear|suspected|confirmed)$/),
      risk_state: expect.stringMatching(/^(ok|suspended)$/),
    });
  });
});
