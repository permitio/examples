import type { ConditionSetRuleCreate } from 'permitio';
import { describe, expect, it, vi } from 'vitest';
import { RESOURCE_SETS, USER_SETS } from '#src/policy';
import {
  describeError,
  grantRules,
  type PolicyApi,
  resourceSetPayload,
  userSetPayload,
  writePolicy,
} from '#src/write-policy';

const set = <T extends { key: string }>(list: readonly T[], key: string): T => {
  const found = list.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no ${key}`);
  return found;
};

describe('userSetPayload', () => {
  it('matches any of the set’s bot types', () => {
    expect(userSetPayload(set(USER_SETS, 'Human_Users'))).toEqual({
      key: 'Human_Users',
      name: 'Human Users',
      description: 'Known humans and verified bots',
      type: 'userset',
      conditions: {
        allOf: [
          {
            anyOf: [
              { 'user.botType': { equals: 'LIKELY_NOT_A_BOT' } },
              { 'user.botType': { equals: 'VERIFIED_BOT' } },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ['Trusted_Bots', 'AUTOMATED'],
    ['Untrusted_Bots', 'LIKELY_AUTOMATED'],
    ['Evil_Bots', 'NOT_ANALYZED'],
  ])('matches %s on botType %s', (key, botType) => {
    expect(userSetPayload(set(USER_SETS, key)).conditions).toEqual({
      allOf: [{ anyOf: [{ 'user.botType': { equals: botType } }] }],
    });
  });
});

describe('resourceSetPayload', () => {
  it.each([
    ['Public_Items', 'equals', false],
    ['Shared_Items', 'not-equals', false],
    ['Private_Items', 'equals', true],
    ['Blocked_Items', 'not-equals', true],
  ])('%s: owner %s the caller, private is %s', (key, ownerOperator, isPrivate) => {
    const payload = resourceSetPayload(set(RESOURCE_SETS, key));
    expect(payload).toMatchObject({ key, type: 'resourceset', resource_id: 'Content_Item' });
    expect(payload.conditions).toEqual({
      allOf: [
        {
          allOf: [
            { 'resource.owner': { [ownerOperator]: { ref: 'user.key' } } },
            { 'resource.private': { equals: isPrivate } },
          ],
        },
      ],
    });
  });
});

describe('grantRules', () => {
  it('grants what the policy grid in the blog post grants, and nothing else', () => {
    const rules = grantRules().map((r) => `${r.user_set} ${r.permission} ${r.resource_set}`);
    expect(rules.sort()).toEqual(
      [
        'Human_Users Content_Item:read Public_Items',
        'Human_Users Content_Item:create Public_Items',
        'Human_Users Content_Item:update Public_Items',
        'Human_Users Content_Item:delete Public_Items',
        'Human_Users Content_Item:read Shared_Items',
        'Human_Users Content_Item:read Private_Items',
        'Human_Users Content_Item:create Private_Items',
        'Human_Users Content_Item:update Private_Items',
        'Human_Users Content_Item:delete Private_Items',
        'Trusted_Bots Content_Item:read Public_Items',
        'Trusted_Bots Content_Item:read Shared_Items',
        'Trusted_Bots Content_Item:read Private_Items',
        'Untrusted_Bots Content_Item:read Public_Items',
        'Untrusted_Bots Content_Item:read Shared_Items',
      ].sort(),
    );
  });
});

interface Existing {
  resources?: string[];
  attributes?: string[];
  sets?: string[];
  rules?: ConditionSetRuleCreate[];
  users?: string[];
}

/**
 * A Permit API that holds what `existing` lists and records every write. Like the API, it lists the
 * grants of the user set it is asked about.
 */
function fakeApi(existing: Existing = {}) {
  const keys = (list: string[] = []) => list.map((key) => ({ key }));
  const rules = existing.rules ?? [];
  const api = {
    resources: {
      list: vi.fn(async () => keys(existing.resources)),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    resourceAttributes: {
      list: vi.fn(async () => keys(existing.attributes)),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    conditionSets: {
      list: vi.fn(async () => keys(existing.sets)),
      create: vi.fn(async (_set: { key: string }) => ({})),
      update: vi.fn(async () => ({})),
    },
    conditionSetRules: {
      list: vi.fn(async (filter: { userSetKey: string }) =>
        rules.filter((r) => r.user_set === filter.userSetKey),
      ),
      create: vi.fn(async (_rule: ConditionSetRuleCreate) => ({})),
      delete: vi.fn(async (_rule: ConditionSetRuleCreate) => {}),
    },
    users: {
      sync: vi.fn(async (user: { key: string }) => ({
        user,
        created: !(existing.users ?? []).includes(user.key),
      })),
    },
  };
  return { api, policyApi: api as unknown as PolicyApi };
}

const ALL_SETS = [...USER_SETS, ...RESOURCE_SETS].map((s) => s.key);

describe('writePolicy', () => {
  it('creates everything in an empty environment', async () => {
    const { api, policyApi } = fakeApi();
    const log = vi.fn();
    await writePolicy(policyApi, log);

    expect(api.resources.create).toHaveBeenCalledWith({
      key: 'Content_Item',
      name: 'Content Item',
      actions: { read: {}, create: {}, update: {}, delete: {} },
      attributes: {
        owner: { type: 'string', description: expect.any(String) },
        private: { type: 'bool', description: expect.any(String) },
      },
    });
    expect(api.resourceAttributes.list).toHaveBeenCalledWith({ resourceKey: '__user' });
    expect(api.resourceAttributes.create).toHaveBeenCalledWith('__user', {
      key: 'botType',
      type: 'string',
      description: expect.any(String),
    });
    expect(api.conditionSets.create.mock.calls.map(([s]) => s.key)).toEqual(ALL_SETS);
    expect(api.conditionSetRules.create).toHaveBeenCalledTimes(grantRules().length);
    expect(api.resources.update).not.toHaveBeenCalled();
    expect(api.conditionSets.update).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('created resource Content_Item');
    expect(log).toHaveBeenCalledWith('created user attribute botType');
    expect(log).toHaveBeenCalledWith('created resource set Shared_Items');
    expect(log).toHaveBeenCalledWith(
      'granted Untrusted_Bots may Content_Item:read on Shared_Items',
    );
    // The resource sets need the user's key attribute, which the PDP has only for a known user.
    expect(api.users.sync).toHaveBeenCalledWith({
      key: 'user@example.com',
      email: 'user@example.com',
    });
    expect(log).toHaveBeenLastCalledWith('created user user@example.com');
  });

  it('updates what exists, so a second run leaves the same policy', async () => {
    const { api, policyApi } = fakeApi({
      resources: ['Content_Item'],
      attributes: ['botType'],
      sets: ALL_SETS,
      rules: grantRules(),
      users: ['user@example.com'],
    });
    const log = vi.fn();
    await writePolicy(policyApi, log);

    expect(api.resources.create).not.toHaveBeenCalled();
    expect(api.resources.update).toHaveBeenCalledWith('Content_Item', {
      name: 'Content Item',
      actions: { read: {}, create: {}, update: {}, delete: {} },
      attributes: expect.any(Object),
    });
    expect(api.resourceAttributes.update).toHaveBeenCalledWith('__user', 'botType', {
      type: 'string',
      description: expect.any(String),
    });
    expect(api.conditionSets.create).not.toHaveBeenCalled();
    expect(api.conditionSets.update).toHaveBeenCalledWith('Evil_Bots', {
      name: 'Evil Bots',
      description: 'Bots that hide what they are',
      conditions: { allOf: [{ anyOf: [{ 'user.botType': { equals: 'NOT_ANALYZED' } }] }] },
    });
    expect(api.conditionSets.update).toHaveBeenCalledTimes(ALL_SETS.length);
    // Permit answers 409 to a grant that exists, so none is sent again.
    expect(api.conditionSetRules.create).not.toHaveBeenCalled();
    expect(api.conditionSetRules.delete).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('updated user set Human_Users');
    expect(log).toHaveBeenCalledWith('updated resource set Blocked_Items');
    expect(log).toHaveBeenCalledWith(
      'already granted Human_Users may Content_Item:read on Public_Items',
    );
    expect(log).toHaveBeenLastCalledWith('updated user user@example.com');
  });

  it("reads each user set's grants and sends only the missing ones", async () => {
    const [first, second, ...missing] = grantRules();
    if (first === undefined || second === undefined) throw new Error('expected grants');
    const { api, policyApi } = fakeApi({ rules: [first, second] });
    await writePolicy(policyApi, vi.fn());
    expect(api.conditionSetRules.list.mock.calls.map(([f]) => f)).toEqual(
      USER_SETS.map((s) => ({ userSetKey: s.key })),
    );
    expect(api.conditionSetRules.create.mock.calls.map(([r]) => r)).toEqual(missing);
  });

  it('revokes the grants between its own sets that GRANTS no longer lists', async () => {
    const dropped = {
      user_set: 'Trusted_Bots',
      permission: 'Content_Item:read',
      resource_set: 'Blocked_Items',
    };
    const evil = {
      user_set: 'Evil_Bots',
      permission: 'Content_Item:delete',
      resource_set: 'Public_Items',
    };
    // Grants that involve a set this policy does not define belong to someone else.
    const foreign = [
      { user_set: 'Human_Users', permission: 'Content_Item:read', resource_set: 'Archived_Items' },
      { user_set: 'Admins', permission: 'Content_Item:read', resource_set: 'Blocked_Items' },
    ];
    const { api, policyApi } = fakeApi({ rules: [...grantRules(), dropped, evil, ...foreign] });
    const log = vi.fn();
    await writePolicy(policyApi, log);

    expect(api.conditionSetRules.create).not.toHaveBeenCalled();
    expect(api.conditionSetRules.delete.mock.calls.map(([r]) => r)).toEqual([dropped, evil]);
    expect(log).toHaveBeenCalledWith('revoked Trusted_Bots may Content_Item:read on Blocked_Items');
    expect(log).toHaveBeenCalledWith('revoked Evil_Bots may Content_Item:delete on Public_Items');
  });

  it('labels a failed revoke', async () => {
    const dropped = {
      user_set: 'Evil_Bots',
      permission: 'Content_Item:read',
      resource_set: 'Public_Items',
    };
    const { api, policyApi } = fakeApi({ rules: [dropped] });
    api.conditionSetRules.delete.mockRejectedValueOnce(new Error('Request failed'));
    await expect(writePolicy(policyApi, vi.fn())).rejects.toThrow(
      'revoke Evil_Bots may Content_Item:read on Public_Items: Request failed',
    );
  });

  it('creates only the sets that are missing', async () => {
    const { api, policyApi } = fakeApi({ sets: ['Human_Users', 'Public_Items'] });
    await writePolicy(policyApi, vi.fn());
    const created = api.conditionSets.create.mock.calls.map(([s]) => s.key);
    expect(created).toEqual(ALL_SETS.filter((k) => k !== 'Human_Users' && k !== 'Public_Items'));
    expect(api.conditionSets.update).toHaveBeenCalledTimes(2);
  });

  it('stops at the first failed write and says what it was writing', async () => {
    const { api, policyApi } = fakeApi();
    const apiError = Object.assign(new Error('Request failed'), {
      response: { status: 422, data: { message: 'invalid conditions' } },
    });
    api.conditionSets.create.mockRejectedValueOnce(apiError);
    const run = writePolicy(policyApi, vi.fn());
    await expect(run).rejects.toThrow(
      'create user set Human_Users: Request failed (HTTP 422) {"message":"invalid conditions"}',
    );
    expect(api.conditionSetRules.create).not.toHaveBeenCalled();
  });

  it('labels a failed read too', async () => {
    const { api, policyApi } = fakeApi();
    api.resources.list.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.permit.io'));
    await expect(writePolicy(policyApi, vi.fn())).rejects.toThrow(
      'list resources: getaddrinfo ENOTFOUND api.permit.io',
    );
  });
});

describe('describeError', () => {
  it('describes a value that is not an Error', () => {
    expect(describeError('plain')).toBe('plain');
  });

  it('keeps the message of an error without a response', () => {
    expect(describeError(new Error('Missing PERMIT_API_KEY'))).toBe('Missing PERMIT_API_KEY');
  });

  it('cuts a long response body', () => {
    const err = Object.assign(new Error('Bad'), {
      response: { status: 500, data: 'x'.repeat(900) },
    });
    expect(describeError(err).length).toBeLessThan(530);
  });
});
