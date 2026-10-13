import { describe, expect, it } from 'vitest';
import { DemoClock } from '#src/server/clock';
import { HttpError } from '#src/server/errors';
import { EventLog } from '#src/server/events';

const write = (what: string) => ({ kind: 'write' as const, at: 0, what, ms: 1, ok: true });
const check = (action: string) => ({
  kind: 'check' as const,
  at: 0,
  user: 'aragorn',
  action,
  resource: 'shipment:SHP-77001',
  tenant: 'shire-freight',
  source: 'action' as const,
  allow: false,
  ms: 1,
  input: {
    user: { key: 'aragorn', attributes: { current_time: 0 } },
    action,
    resource: {
      type: 'shipment',
      key: 'SHP-77001',
      tenant: 'shire-freight',
      attributes: { id: 'SHP-77001' },
    },
  },
});

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('EventLog', () => {
  it('gives each event a larger id than the last', () => {
    const log = new EventLog();
    const a = log.push(write('a'));
    const b = log.push(check('view'));
    expect(b).toBeGreaterThan(a);
    expect(log.lastId()).toBe(b);
  });

  it('returns only the events newer than the id it is given', () => {
    const log = new EventLog();
    const first = log.push(write('a'));
    log.push(write('b'));
    log.push(write('c'));
    expect(log.since(first).map((e) => (e.kind === 'write' ? e.what : e.kind))).toEqual(['b', 'c']);
    expect(log.since(log.lastId())).toEqual([]);
  });

  it('drops the oldest events beyond its capacity', () => {
    const log = new EventLog(3);
    for (const what of ['a', 'b', 'c', 'd', 'e']) log.push(write(what));
    expect(log.since(0).map((e) => (e.kind === 'write' ? e.what : ''))).toEqual(['c', 'd', 'e']);
    expect(log.lastId()).toBe(5);
  });

  it('patches a check event in place, keeping its id and kind', () => {
    const log = new EventLog();
    const id = log.push(check('view'));
    log.patch(id, { reason: { code: 'deny' }, id: 99, kind: 'check' });
    expect(log.since(0)).toEqual([{ ...check('view'), id, reason: { code: 'deny' } }]);
  });

  it('finds an event by id only while it is still held', () => {
    const log = new EventLog(2);
    const first = log.push(write('a'));
    const second = log.push(check('view'));
    expect(log.get(second)).toMatchObject({ id: second, kind: 'check', action: 'view' });
    log.push(write('c'));
    expect(log.get(first)).toBeUndefined();
    expect(log.get(999)).toBeUndefined();
  });

  it('ignores a patch for an id it no longer holds', () => {
    const log = new EventLog(1);
    const old = log.push(check('view'));
    log.push(check('upload_docs'));
    log.patch(old, { reason: 'late' });
    expect(log.since(0)).toHaveLength(1);
    expect(log.since(0)[0]).not.toHaveProperty('reason');
  });
});

describe('DemoClock', () => {
  it('refuses to move when switched off and keeps real time', () => {
    const clock = new DemoClock(false);
    for (const move of [() => clock.advance(60_000), () => clock.reset()]) {
      const error = thrown(move);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 409, message: 'The demo clock is switched off' });
    }
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
    expect(clock.offsetMs()).toBe(0);
  });

  it('shifts now() by the advanced amount when switched on, and reset returns to real time', () => {
    const clock = new DemoClock(true, () => 1_000_000);
    clock.advance(60_000);
    expect(clock.now()).toBe(1_060_000);
    expect(clock.offsetMs()).toBe(60_000);
    clock.reset();
    expect(clock.now()).toBe(1_000_000);
    expect(clock.offsetMs()).toBe(0);
  });
});
