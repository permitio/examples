import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSeed } from '#src/seed';
import { Store } from '#src/store';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const SECRET = 'a'.repeat(64);
const connector = {
  key: 'shire-erp',
  name: 'Shire ERP connector',
  owner: 'pippin',
  customer: 'shire-freight',
  secret: SECRET,
};

const dirs: string[] = [];
const tempStorePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'great-eagle-store-'));
  dirs.push(dir);
  return join(dir, 'store.json');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('integrations (S5)', () => {
  it('round-trip: a registered connector is listed and found by its secret', () => {
    const store = new Store(loadSeed(), { at: NOW });
    const added = store.addIntegration(connector, NOW);
    expect(added).toEqual({ ...connector, created_at: iso(NOW) });
    expect(store.listIntegrations()).toEqual([added]);
    expect(store.findIntegrationBySecret(SECRET)).toEqual(added);
  });

  it('finds no connector for an unknown, shorter or empty secret', () => {
    const store = new Store(loadSeed(), { at: NOW });
    store.addIntegration(connector, NOW);
    for (const secret of ['b'.repeat(64), SECRET.slice(1), ''])
      expect(store.findIntegrationBySecret(secret), JSON.stringify(secret)).toBeUndefined();
  });

  it("refuses a key that is taken, so a registration never hands back another connector's secret", () => {
    const store = new Store(loadSeed(), { at: NOW });
    store.addIntegration(connector, NOW);
    expect(store.addIntegration({ ...connector, secret: 'c'.repeat(64) }, NOW + 1)).toBeUndefined();
    expect(store.listIntegrations()).toEqual([{ ...connector, created_at: iso(NOW) }]);
  });
});

describe('shipments the connector creates (S5)', () => {
  it('round-trip: numbered from SHP-80001 and listed by EAN', () => {
    const store = new Store(loadSeed(), { at: NOW });
    const first = store.addShipment(
      { ean: 'EAN-1001', title: 'Created by Shire ERP connector', created_by: 'shire-erp' },
      NOW,
    );
    const second = store.addShipment(
      { ean: 'EAN-SANDBOX', title: 'Test', created_by: 'shire-erp' },
      NOW + 1_000,
    );
    expect(first).toEqual({
      key: 'SHP-80001',
      ean: 'EAN-1001',
      title: 'Created by Shire ERP connector',
      created_by: 'shire-erp',
      created_at: iso(NOW),
    });
    expect(second.key).toBe('SHP-80002');
    expect(store.listShipments('EAN-1001')).toEqual([first]);
    expect(store.listShipments('EAN-SANDBOX')).toEqual([second]);
    expect(store.listShipments('EAN-1002')).toEqual([]);
  });
});

describe('the legacy app (S8)', () => {
  it('round-trip: starts in shadow mode with mapping 1, and keeps what setLegacy changes', () => {
    const store = new Store(loadSeed(), { at: NOW });
    expect(store.getLegacy()).toEqual({ mode: 'shadow', mappingVersion: 1, validations: 0 });
    expect(store.setLegacy({ mode: 'both' })).toEqual({
      mode: 'both',
      mappingVersion: 1,
      validations: 0,
    });
    store.setLegacy({ mappingVersion: 2, validations: 3 });
    expect(store.getLegacy()).toEqual({ mode: 'both', mappingVersion: 2, validations: 3 });
  });
});

describe('reset', () => {
  it('clears integrations, shipments and the legacy state', () => {
    const store = new Store(loadSeed(), { at: NOW });
    store.addIntegration(connector, NOW);
    store.addShipment({ ean: 'EAN-1001', title: 't', created_by: 'shire-erp' }, NOW);
    store.setLegacy({ mode: 'permit', mappingVersion: 2, validations: 4 });
    store.reset(NOW + 60_000);
    expect(store.listIntegrations()).toEqual([]);
    expect(store.findIntegrationBySecret(SECRET)).toBeUndefined();
    expect(store.listShipments('EAN-1001')).toEqual([]);
    expect(store.getLegacy()).toEqual({ mode: 'shadow', mappingVersion: 1, validations: 0 });
    expect(
      store.addShipment({ ean: 'EAN-1001', title: 't', created_by: 'shire-erp' }, NOW).key,
    ).toBe('SHP-80001');
  });
});

describe('persistence of the new state', () => {
  it('keeps integrations, shipments and the legacy state across a restart', () => {
    const path = tempStorePath();
    const store = new Store(loadSeed(), { path, at: NOW });
    const integration = store.addIntegration(connector, NOW);
    const shipment = store.addShipment(
      { ean: 'EAN-1001', title: 't', created_by: 'shire-erp' },
      NOW,
    );
    store.setLegacy({ mode: 'both' });
    const restarted = new Store(loadSeed(), { path, at: NOW + 60_000 });
    expect(restarted.listIntegrations()).toEqual([integration]);
    expect(restarted.listShipments('EAN-1001')).toEqual([shipment]);
    expect(restarted.getLegacy()).toEqual({ mode: 'both', mappingVersion: 1, validations: 0 });
  });

  it('opens a store saved before S5 and S8 with no integrations, no shipments and the legacy app in shadow mode', () => {
    const path = tempStorePath();
    new Store(loadSeed(), { path, at: NOW }).updateUserFacts('eowyn', { risk_state: 'suspended' });
    const {
      integrations: _i,
      shipments: _s,
      legacy: _l,
      ...older
    } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(older));
    const opened = new Store(loadSeed(), { path, at: NOW });
    expect(opened.userFacts('eowyn')?.risk_state).toBe('suspended');
    expect(opened.listIntegrations()).toEqual([]);
    expect(opened.getLegacy()).toEqual({ mode: 'shadow', mappingVersion: 1, validations: 0 });
  });

  it('refuses a store whose new state is malformed, rather than starting it empty', () => {
    const path = tempStorePath();
    new Store(loadSeed(), { path, at: NOW });
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const broken of [
      { integrations: {} },
      { shipments: null },
      { legacy: { mode: 'off', mappingVersion: 1, validations: 0 } },
    ]) {
      writeFileSync(path, JSON.stringify({ ...saved, ...broken }));
      expect(() => new Store(loadSeed(), { path, at: NOW }), JSON.stringify(broken)).toThrow(path);
    }
  });

  it("never quotes the store file in its error, since the file holds the connectors' secrets", () => {
    const path = tempStorePath();
    writeFileSync(path, `{"integrations":[{"secret":"${SECRET}"}],"users": [x`);
    expect(() => new Store(loadSeed(), { path, at: NOW })).toThrow(path);
    let message = '';
    try {
      new Store(loadSeed(), { path, at: NOW });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('aaaa');
    expect(message).not.toContain('users');
  });
});
