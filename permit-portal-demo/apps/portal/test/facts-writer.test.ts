import { describe, expect, it } from 'vitest';
import { FactsWriter } from '#src/server/permit/facts-writer';
import { EventLog } from '#src/server/events';
import { ResourceFactsWriter } from '#src/server/permit/resource-facts-writer';
import { WriteFailedError } from '#src/server/permit/writes';

function fakeUsers(initial: Record<string, object>) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key: string) { await Promise.resolve(); return { attributes: structuredClone(store.get(key) ?? {}) }; },
    async update(key: string, d: { attributes: object }) { await new Promise((r) => setTimeout(r, 5)); store.set(key, structuredClone(d.attributes)); return {}; },
  };
}

describe('FactsWriter', () => {
  it('serializes concurrent updates for one user so neither change is lost', async () => {
    const users = fakeUsers({ aragorn: { risk_state: 'ok' } });
    const w = new FactsWriter(users, new EventLog());
    await Promise.all([
      w.update('aragorn', 'grant', (a) => ({ ...a, time_based_grants: [{ resource: 'SHP-77001', role: 'collaborator', expires: 1, renewals_used: 0 }] })),
      w.update('aragorn', 'trust flip', (a) => ({ ...a, risk_state: 'suspended' })),
    ]);
    expect(users.store.get('aragorn')).toMatchObject({ risk_state: 'suspended', time_based_grants: [{ resource: 'SHP-77001' }] });
  });
  it('skips the write when the mutation changes nothing', async () => {
    const users = fakeUsers({ aragorn: { risk_state: 'ok' } });
    const log = new EventLog();
    const r = await new FactsWriter(users, log).update('aragorn', 'noop', (a) => a);
    expect(r.skipped).toBe(true);
    expect(log.since(0)).toHaveLength(0);
  });
  it('records a failed write and maps 424 to the PDP timeout message', async () => {
    const users = { ...fakeUsers({ aragorn: {} }), async update() { throw Object.assign(new Error('x'), { status: 424 }); } };
    const log = new EventLog();
    await expect(new FactsWriter(users, log).update('aragorn', 'grant', (a) => ({ ...a, x: 1 }))).rejects.toBeInstanceOf(WriteFailedError);
    expect(log.since(0)[0]).toMatchObject({ kind: 'write', ok: false, error: 'The PDP did not confirm this change within 5 seconds.' });
  });
  it('a failed update does not block the next one', async () => {
    let fail = true;
    const users = fakeUsers({ aragorn: {} });
    const flaky = { get: users.get, async update(k: string, d: { attributes: object }) { if (fail) { fail = false; throw new Error('boom'); } return users.update(k, d); } };
    const w = new FactsWriter(flaky, new EventLog());
    await expect(w.update('aragorn', 'a', (a) => ({ ...a, a: 1 }))).rejects.toThrow();
    await w.update('aragorn', 'b', (a) => ({ ...a, b: 1 }));
    expect(users.store.get('aragorn')).toEqual({ b: 1 });
  });
  it('records a successful write with its duration and names the user', async () => {
    const users = fakeUsers({ aragorn: {} });
    const log = new EventLog();
    const r = await new FactsWriter(users, log).update('aragorn', 'grant', (a) => ({ ...a, x: 1 }));
    expect(r).toMatchObject({ attributes: { x: 1 }, skipped: false });
    expect(log.since(0)).toEqual([expect.objectContaining({ kind: 'write', what: 'grant (aragorn)', ok: true, ms: r.ms })]);
  });
});

describe('ResourceFactsWriter', () => {
  it('serializes concurrent updates for one instance so neither change is lost', async () => {
    const instances = fakeUsers({ 'organization:riders-of-rohan': { id: 'riders-of-rohan', ownership_verified: false } });
    const w = new ResourceFactsWriter(instances, new EventLog());
    await Promise.all([
      w.update('organization:riders-of-rohan', 'ownership', (a) => ({ ...a, ownership_verified: true })),
      w.update('organization:riders-of-rohan', 'label', (a) => ({ ...a, label: 'gold' })),
    ]);
    expect(instances.store.get('organization:riders-of-rohan')).toEqual({ id: 'riders-of-rohan', ownership_verified: true, label: 'gold' });
  });
  it('skips the write when the mutation changes nothing', async () => {
    const instances = fakeUsers({ 'organization:riders-of-rohan': { ownership_verified: true } });
    const log = new EventLog();
    const r = await new ResourceFactsWriter(instances, log).update('organization:riders-of-rohan', 'ownership', (a) => ({ ...a, ownership_verified: true }));
    expect(r.skipped).toBe(true);
    expect(log.since(0)).toHaveLength(0);
  });
  it('maps 424 to the PDP timeout message and does not block the next update', async () => {
    let fail = true;
    const instances = fakeUsers({ 'organization:riders-of-rohan': {} });
    const flaky = {
      get: instances.get,
      async update(k: string, d: { attributes: object }) { if (fail) { fail = false; throw Object.assign(new Error('x'), { status: 424 }); } return instances.update(k, d); },
    };
    const log = new EventLog();
    const w = new ResourceFactsWriter(flaky, log);
    await expect(w.update('organization:riders-of-rohan', 'ownership', (a) => ({ ...a, ownership_verified: true }))).rejects.toMatchObject({ status: 424 });
    await w.update('organization:riders-of-rohan', 'ownership', (a) => ({ ...a, ownership_verified: true }));
    expect(instances.store.get('organization:riders-of-rohan')).toEqual({ ownership_verified: true });
    expect(log.since(0)[0]).toMatchObject({ kind: 'write', ok: false, error: 'The PDP did not confirm this change within 5 seconds.' });
  });
});
