import { Router } from 'express';
import { HttpError, jsonBody, messageOf, statusOf, text } from '#src/http';
import { accessLog, compare } from '#src/legacy/compare';
import { grantsFor, loadMapping, type MappedGrant, versionOf } from '#src/legacy/mapping';
import {
  LEGACY_TENANT,
  type LegacyPermit,
  legacyPermit,
  type RoleWrite,
  viewBilling,
} from '#src/legacy/permit';
import { legacyAllows } from '#src/legacy/rule';
import type { SeedData } from '#src/seed';
import type { LegacyMode, LegacyState, Store } from '#src/store';

export interface S8Deps {
  store: Store;
  seed: SeedData;
  env: NodeJS.ProcessEnv;
  /** The Permit client. Defaults to the legacy app's own, built from `env` on first use. */
  permit?: LegacyPermit;
  /** The app's clock, in ms: it dates each decision and every question asked of Permit. */
  now: () => number;
}

const MODES: readonly LegacyMode[] = ['shadow', 'both', 'permit'];
/** How many of its latest decisions the legacy app lists. */
const RECENT = 20;
/**
 * A mapped role is written through the PDP, which waits this many seconds for it to apply and fails
 * the write after that.
 */
const WAIT_SECONDS = 5;
/**
 * Asking Permit whether it knows a user: the page size, and how many pages one key may take before
 * something is wrong.
 */
const USERS_PER_PAGE = 100;
const MAX_USER_PAGES = 10;
/** Reading the roles a user holds: the page size, and how many pages before something is wrong. */
const ROLES_PER_PAGE = 100;
const MAX_ROLE_PAGES = 10;

/**
 * One decision the legacy app took: what each side said and what it enforced. `permit` is null when
 * Permit did not answer.
 */
interface Decision {
  at: string;
  user: string;
  account: string;
  legacy: boolean;
  permit: boolean | null;
  enforced: boolean;
  mode: LegacyMode;
}
type SyncStatus = 'written' | 'unchanged' | 'skipped' | 'failed';
/** A mapped grant and what the sync did with it. A skipped one says why. */
interface SyncedGrant extends MappedGrant {
  status: SyncStatus;
  reason?: string;
}
/**
 * Why a grant was skipped: its user is not in Permit's directory, or is a connector there. The
 * mapping maps people.
 */
const NOT_IN_PERMIT = 'not in Permit';
const NOT_A_PERSON = 'an integration in Permit, not a person';

/** Whether a Permit user's attributes mark it as a non-human principal: a connector S5 registered. */
const isIntegration = (attributes: unknown) =>
  typeof attributes === 'object' &&
  attributes !== null &&
  (attributes as Record<string, unknown>)['principal_type'] === 'integration';

/**
 * A role and the resource it is on (`type:key`), or the role alone for a role in the tenant: how a
 * held role and a grant are matched.
 */
const roleKey = (role: string, resource: string | null | undefined) =>
  resource ? `${role} ${resource}` : role;

/** Permit's answer to a write: 424 is the PDP not applying the change within the wait. */
const describeWrite = (error: unknown) =>
  statusOf(error) === 424
    ? `The PDP did not confirm this change within ${WAIT_SECONDS} seconds.`
    : messageOf(error);

/**
 * What the legacy app answers in `mode`. Shadow: the legacy rule decides, and Permit's answer is
 * only recorded. Both: each must allow, and a Permit that did not answer is a no, so the legacy
 * answer alone is never enough. Permit: Permit decides, and with no answer from it the answer is
 * no.
 */
function enforce(mode: LegacyMode, legacy: boolean, permit: boolean | null): boolean {
  switch (mode) {
    case 'shadow':
      return legacy;
    case 'both':
      return legacy && permit === true;
    case 'permit':
      return permit === true;
  }
}

/**
 * S8's legacy billing app: its users table and rule, shadow mode, the mapping and its validation,
 * and the mode switch. It asks Permit with its own SDK client, configured from `env`
 * (PERMIT_API_URL, PERMIT_API_KEY, PERMIT_PDP_URL). app.ts mounts it at the root, so its paths are
 * whole: /api/legacy/…. Its decisions are kept in memory: Permit holds the grants and the audit
 * log, and the legacy app is the one thing here that is not Permit's. A refusal is an HttpError,
 * which app.ts's error handler answers.
 */
export function s8Router({ store, seed, env, permit: injected, now }: S8Deps): Router {
  const r = Router();
  const mapping = loadMapping();
  const users = seed.legacy.users;
  const accounts = seed.accounts;
  const userByKey = new Map(users.map((user) => [user.key, user]));
  const accountByKey = new Map(accounts.map((account) => [account.key, account]));

  let client = injected;
  const permit = (): LegacyPermit => (client ??= legacyPermit(env));

  const recent: Decision[] = [];
  let seen = store.getLegacy();
  /**
   * The legacy app's state. Every change goes through `change`, so a state this router did not make
   * is the systems being reset: back to shadow mode and the first mapping, and the list of
   * decisions starts again with it.
   */
  const legacy = (): LegacyState => {
    const current = store.getLegacy();
    if (current !== seen) {
      seen = current;
      recent.length = 0;
    }
    return current;
  };
  const change = (partial: Partial<LegacyState>): LegacyState => {
    legacy();
    seen = store.setLegacy(partial);
    return seen;
  };

  /** Permit's answer to one view_billing question, or null with the reason when it gave none. */
  async function askPermit(
    user: string,
    account: string,
  ): Promise<{ answer: boolean | null; error?: string }> {
    const question = viewBilling(user, account, now());
    try {
      // Permit check: may this user view billing on this child account in shire-freight?
      return { answer: await permit().check(question.user, question.action, question.resource) };
    } catch (error) {
      return { answer: null, error: messageOf(error) };
    }
  }

  /**
   * The users among `keys` that Permit has, each with its attributes. A read that fails throws: not
   * knowing a user is never the same as the user being absent.
   */
  async function knownToPermit(keys: readonly string[]): Promise<Map<string, unknown>> {
    const found = new Map<string, unknown>();
    for (const key of keys) {
      for (let page = 1; ; page += 1) {
        if (page > MAX_USER_PAGES)
          throw new Error(
            `Permit lists more than ${MAX_USER_PAGES * USERS_PER_PAGE} users matching ${key}`,
          );
        // Permit read: the users whose key contains this one (api.users.list), and this one among
        // them, matched exactly.
        const { data } = await permit().api.users.list({
          search: key,
          page,
          perPage: USERS_PER_PAGE,
        });
        const user = data.find((candidate) => candidate.key === key);
        if (user !== undefined) {
          found.set(key, user.attributes);
          break;
        }
        if (data.length < USERS_PER_PAGE) break;
      }
    }
    return found;
  }

  /**
   * The roles each of `users` holds in the legacy tenant, as `role` or `role type:key`. Permit
   * answers a role held already with success, so only this read tells a grant that is there from
   * one the sync writes. A read that fails throws.
   */
  async function heldBy(users: readonly string[]): Promise<Map<string, Set<string>>> {
    const held = new Map<string, Set<string>>();
    for (const user of users) {
      const roles = new Set<string>();
      for (let page = 1; ; page += 1) {
        if (page > MAX_ROLE_PAGES)
          throw new Error(
            `Permit lists more than ${MAX_ROLE_PAGES * ROLES_PER_PAGE} roles for ${user}`,
          );
        // Permit read: the roles this user holds in shire-freight (api.roleAssignments.list), on a
        // resource or in the tenant.
        const rows = await permit().api.roleAssignments.list({
          user,
          tenant: LEGACY_TENANT,
          page,
          perPage: ROLES_PER_PAGE,
        });
        for (const row of rows) roles.add(roleKey(row.role, row.resource_instance));
        if (rows.length < ROLES_PER_PAGE) break;
      }
      held.set(user, roles);
    }
    return held;
  }

  r.get('/api/legacy/state', (_req, res) => {
    const state = legacy();
    res.json({
      ...state,
      mapping: versionOf(mapping, state.mappingVersion),
      users,
      accounts,
      recent: recent.slice(0, RECENT),
    });
  });

  r.post('/api/legacy/requests', async (req, res) => {
    const body = jsonBody(req, ['user', 'account']);
    const user = text(body, 'user');
    const accountKey = text(body, 'account');
    const account = accountByKey.get(accountKey);
    if (account === undefined) throw new HttpError(404, `No account ${accountKey}`);
    const { mode } = legacy();
    // The legacy app's own rule first; a user its table does not know has no access under it.
    const legacyAnswer = legacyAllows(userByKey.get(user), account);
    const { answer, error } = await askPermit(user, accountKey);
    const enforced = enforce(mode, legacyAnswer, answer);
    recent.unshift({
      at: new Date(now()).toISOString(),
      user,
      account: accountKey,
      legacy: legacyAnswer,
      permit: answer,
      enforced,
      mode,
    });
    recent.length = Math.min(recent.length, RECENT);
    res.json({
      legacy: legacyAnswer,
      permit: answer,
      enforced,
      mode,
      ...(error === undefined ? {} : { error }),
    });
  });

  r.post('/api/legacy/validate', async (_req, res) => {
    let error: string | undefined;
    const { rows, summary } = await compare(
      accessLog(users, accounts),
      (user, account) => {
        const target = accountByKey.get(account);
        return target !== undefined && legacyAllows(userByKey.get(user), target);
      },
      async (pairs) => {
        try {
          // Permit check: may each of these users view billing on each of these child accounts in
          // shire-freight? One bulk check.
          const answers = await permit().bulkCheck(
            pairs.map((pair) => viewBilling(pair.user, pair.account, now())),
          );
          if (answers.length === pairs.length) return answers;
          error = `The PDP answered ${answers.length} of the ${pairs.length} questions it was asked`;
        } catch (failure) {
          error = messageOf(failure);
        }
        return pairs.map(() => null);
      },
      mapping.approved_tightenings,
    );
    // A run that could not check anything proves nothing, so it is not counted.
    if (summary.could_not_check < summary.total) change({ validations: legacy().validations + 1 });
    res.json({ rows, summary, ...(error === undefined ? {} : { error }) });
  });

  r.put('/api/legacy/mapping', (req, res) => {
    const { version } = jsonBody(req, ['version']);
    if (version !== 1 && version !== 2) throw new HttpError(400, 'version must be 1 or 2');
    res.json(change({ mappingVersion: version }));
  });

  r.post('/api/legacy/sync', async (_req, res) => {
    const version = legacy().mappingVersion;
    const grants = grantsFor(version, users, accounts, mapping);
    const done: SyncedGrant[] = [];
    const tally = (status: SyncStatus) => done.filter((grant) => grant.status === status).length;
    const answer = () => ({
      version,
      written: tally('written'),
      unchanged: tally('unchanged'),
      skipped: tally('skipped'),
      grants: done,
    });

    // Who Permit has, and what each of them holds, is read before anything is written, so a read
    // that fails stops the sync with nothing half done.
    let inPermit: Map<string, unknown>;
    try {
      inPermit = await knownToPermit([...new Set(grants.map((grant) => grant.user))]);
    } catch (error) {
      res.status(502).json({
        error: `Permit could not say which users it has: ${messageOf(error)}`,
        ...answer(),
      });
      return;
    }
    const people = [...inPermit]
      .filter(([, attributes]) => !isIntegration(attributes))
      .map(([user]) => user);
    let held: Map<string, Set<string>>;
    try {
      held = await heldBy(people);
    } catch (error) {
      res.status(502).json({
        error: `Permit could not say which roles its users hold: ${messageOf(error)}`,
        ...answer(),
      });
      return;
    }

    for (const grant of grants) {
      if (!inPermit.has(grant.user)) {
        done.push({ ...grant, status: 'skipped', reason: NOT_IN_PERMIT });
        continue;
      }
      // A connector registered under a legacy user's key is no person of the table: it gets none of
      // that person's roles.
      if (isIntegration(inPermit.get(grant.user))) {
        done.push({ ...grant, status: 'skipped', reason: NOT_A_PERSON });
        continue;
      }
      if (held.get(grant.user)?.has(roleKey(grant.role, grant.resource)) === true) {
        done.push({ ...grant, status: 'unchanged' });
        continue;
      }
      const write: RoleWrite = {
        user: grant.user,
        role: grant.role,
        tenant: LEGACY_TENANT,
        ...(grant.resource === undefined ? {} : { resource_instance: grant.resource }),
      };
      try {
        // Permit write: the mapped role, on one resource or in the tenant (api.users.assignRole),
        // waited: it returns once the PDP has applied it.
        await permit().api.users.waitForSync(WAIT_SECONDS, 'fail').assignRole(write);
        done.push({ ...grant, status: 'written' });
      } catch (error) {
        // A 409, should Permit answer one for a role the user holds already: the write is done.
        if (statusOf(error) === 409) {
          done.push({ ...grant, status: 'unchanged' });
          continue;
        }
        done.push({ ...grant, status: 'failed' });
        res.status(502).json({ error: describeWrite(error), ...answer() });
        return;
      }
    }
    res.json(answer());
  });

  r.put('/api/legacy/mode', (req, res) => {
    const { mode } = jsonBody(req, ['mode']);
    const chosen = MODES.find((candidate) => candidate === mode);
    if (chosen === undefined) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
    res.json(change({ mode: chosen }));
  });

  return r;
}
