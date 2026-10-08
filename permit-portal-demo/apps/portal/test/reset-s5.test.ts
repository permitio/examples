// What bin/demo reset does for S5: every connector goes from Permit, roles and all. A connector is a user
// registration marked `principal_type: 'integration'` for the customer `shire-freight`. Great Eagle's systems clear the
// credentials, requests and shipments in their own reset.
import type { Permit } from 'permitio';
import { describe, expect, it } from 'vitest';
import { resetS5 } from '../scripts/reset/s5';

interface FakeUser { key: string; attributes?: object }

/** What registration writes on a connector's Permit user. */
const connector = (key: string, customer = 'shire-freight'): FakeUser => ({ key, attributes: { principal_type: 'integration', owner: 'pippin', customer } });
const person = (key: string): FakeUser => ({ key, attributes: { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' } });
const fillers = (n: number): FakeUser[] => Array.from({ length: n }, (_unused, i) => ({ key: `filler-${i}` }));

interface Options {
  /** Users whose delete Permit answers with this status. */
  deleteFails?: Record<string, number>;
  /** Every list call fails with this status. */
  listFails?: number;
  /** The list never ends: every page is full, with users no earlier page had. */
  endless?: boolean;
}

/**
 * A Permit whose api.users.list pages through `users` as the API does (`page` from 1, `perPage` at most 100) and whose
 * api.users.delete records each key it is asked to delete.
 */
function permitWith(users: FakeUser[], options: Options = {}) {
  const deleted: string[] = [];
  const permit = {
    api: {
      users: {
        list: async ({ page = 1, perPage = 100 }: { page?: number; perPage?: number } = {}) => {
          if (options.listFails) throw Object.assign(new Error(`Permit answered ${options.listFails}`), { status: options.listFails });
          const data = options.endless ? Array.from({ length: perPage }, (_unused, i) => ({ key: `endless-${page}-${i}` })) : users.slice((page - 1) * perPage, page * perPage);
          return { data, total_count: users.length };
        },
        delete: async (key: string) => {
          deleted.push(key);
          const status = options.deleteFails?.[key];
          if (status !== undefined) throw Object.assign(new Error(`Permit answered ${status}`), { status });
        },
      },
    },
  } as unknown as Permit;
  return { deleted, permit };
}

const run = async (permit: Permit) => {
  const lines: string[] = [];
  await resetS5(permit, (line) => lines.push(line));
  return lines;
};

describe('resetS5', () => {
  it('deletes every connector of Shire Freight, on whichever page the list puts it, and nothing else', async () => {
    const users = [
      person('sam'), connector('shire-erp'), ...fillers(240), connector('second-erp'),
      // The preflight's connector is a user with no attributes, and stays. So does everything that is only half a connector:
      // another customer's, a user marked as an integration with no customer, and a user of Shire Freight who is not one.
      { key: 'pf-connector', attributes: {} }, connector('rohan-erp', 'riders-of-rohan'),
      { key: 'half-erp', attributes: { principal_type: 'integration' } }, { key: 'shire-person', attributes: { customer: 'shire-freight' } },
    ];
    const { permit, deleted } = permitWith(users);
    const lines = await run(permit);
    expect(deleted).toEqual(['shire-erp', 'second-erp']);
    expect(lines).toEqual([expect.stringMatching(/deleted\s+S5, the connector shire-erp/), expect.stringMatching(/deleted\s+S5, the connector second-erp/)]);
  });

  it('finds a connector that is the last user of a page that holds exactly 100', async () => {
    const { permit, deleted } = permitWith([...fillers(99), connector('last-on-page'), connector('first-on-next-page')]);
    await run(permit);
    expect(deleted).toEqual(['last-on-page', 'first-on-next-page']);
  });

  it('says there was no connector when none is registered, and deletes nobody', async () => {
    const { permit, deleted } = permitWith([person('sam'), { key: 'pf-connector', attributes: {} }]);
    const lines = await run(permit);
    expect(deleted).toEqual([]);
    expect(lines).toEqual([expect.stringMatching(/absent\s+S5, no connector/)]);
  });

  it('a connector Permit has already deleted is fine: its 404 is reported as absent, and the others still go', async () => {
    const { permit, deleted } = permitWith([connector('shire-erp'), connector('second-erp')], { deleteFails: { 'shire-erp': 404 } });
    const lines = await run(permit);
    expect(deleted).toEqual(['shire-erp', 'second-erp']);
    expect(lines).toEqual([expect.stringMatching(/absent\s+S5, the connector shire-erp/), expect.stringMatching(/deleted\s+S5, the connector second-erp/)]);
  });

  it.each([401, 500])('any other failure, such as Permit answering %i to a delete or to the list, stops the reset instead of reading as done', async (status) => {
    const deleting = permitWith([connector('shire-erp')], { deleteFails: { 'shire-erp': status } });
    await expect(run(deleting.permit)).rejects.toMatchObject({ status });
    const listing = permitWith([connector('shire-erp')], { listFails: status });
    await expect(run(listing.permit)).rejects.toMatchObject({ status });
    expect(listing.deleted).toEqual([]);
  });

  it('stops with an error when the list never ends, instead of passing for done after reading only part of it', async () => {
    const { permit, deleted } = permitWith([], { endless: true });
    await expect(run(permit)).rejects.toThrow(/users/i);
    expect(deleted).toEqual([]);
  });
});
