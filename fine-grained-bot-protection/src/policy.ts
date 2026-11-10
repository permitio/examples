/**
 * The Permit policy this example runs on, as data. `src/setup.ts` writes it to a Permit environment
 * and the app reads it to explain its decisions. It is the policy the blog post "Introduce AI bots
 * in your applications" builds by hand in Permit's UI.
 */
import type { ResourceAttributeCreate, ResourceCreate } from 'permitio';

/** The resource every item is checked against. */
export const RESOURCE_KEY = 'Content_Item';

export const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * What kind of caller sent a request, as the classifiers report it in the user's `botType`
 * attribute. The names are those of Arcjet's earlier bot ranks, which the blog post's user sets
 * match on.
 */
export const BOT_TYPES = [
  'LIKELY_NOT_A_BOT',
  'VERIFIED_BOT',
  'AUTOMATED',
  'LIKELY_AUTOMATED',
  'NOT_ANALYZED',
] as const;
export type BotType = (typeof BOT_TYPES)[number];

export const BOT_TYPE_ATTRIBUTE = {
  key: 'botType',
  type: 'string',
  description: 'What kind of caller sent the request (a bot type from the bot classifier)',
} as const satisfies ResourceAttributeCreate;

export const CONTENT_ITEM = {
  key: RESOURCE_KEY,
  name: 'Content Item',
  actions: { read: {}, create: {}, update: {}, delete: {} },
  attributes: {
    owner: { type: 'string', description: 'Key of the user who owns the item' },
    private: { type: 'bool', description: 'Whether only the owner may see the item' },
  },
} as const satisfies ResourceCreate & { actions: Record<Action, object> };

interface UserSetSpec {
  key: string;
  name: string;
  description: string;
  /** The user set matches a caller whose `botType` is any of these. */
  botTypes: readonly BotType[];
}

export const USER_SETS = [
  {
    key: 'Human_Users',
    name: 'Human Users',
    description: 'Known humans and verified bots',
    botTypes: ['LIKELY_NOT_A_BOT', 'VERIFIED_BOT'],
  },
  {
    key: 'Trusted_Bots',
    name: 'Trusted Bots',
    description: 'Bots that do not hide what they are',
    botTypes: ['AUTOMATED'],
  },
  {
    key: 'Untrusted_Bots',
    name: 'Untrusted Bots',
    description: 'Bots that pretend to be human',
    botTypes: ['LIKELY_AUTOMATED'],
  },
  {
    key: 'Evil_Bots',
    name: 'Evil Bots',
    description: 'Bots that hide what they are',
    botTypes: ['NOT_ANALYZED'],
  },
] as const satisfies readonly UserSetSpec[];
export type UserSetKey = (typeof USER_SETS)[number]['key'];

interface ResourceSetSpec {
  key: string;
  name: string;
  /** `caller`: the item's owner is the user asking. `other`: someone else owns it. */
  owner: 'caller' | 'other';
  private: boolean;
}

export const RESOURCE_SETS = [
  { key: 'Public_Items', name: 'Public Items', owner: 'caller', private: false },
  { key: 'Shared_Items', name: 'Shared Items', owner: 'other', private: false },
  { key: 'Private_Items', name: 'Private Items', owner: 'caller', private: true },
  { key: 'Blocked_Items', name: 'Blocked Items', owner: 'other', private: true },
] as const satisfies readonly ResourceSetSpec[];
export type ResourceSetKey = (typeof RESOURCE_SETS)[number]['key'];

/**
 * What each user set may do on each resource set. A pair that is not listed grants nothing: no one
 * may touch a blocked item, and evil bots may touch nothing.
 */
export const GRANTS: Record<UserSetKey, Partial<Record<ResourceSetKey, readonly Action[]>>> = {
  Human_Users: {
    Public_Items: ACTIONS,
    Shared_Items: ['read'],
    Private_Items: ACTIONS,
  },
  Trusted_Bots: {
    Public_Items: ['read'],
    Shared_Items: ['read'],
    Private_Items: ['read'],
  },
  Untrusted_Bots: {
    Public_Items: ['read'],
    Shared_Items: ['read'],
  },
  Evil_Bots: {},
};

/** The user set whose condition a `botType` matches. */
export function userSetFor(botType: BotType): UserSetKey {
  const set = USER_SETS.find((s) => (s.botTypes as readonly BotType[]).includes(botType));
  if (set === undefined) throw new Error(`No user set matches botType ${botType}`);
  return set.key;
}

/** The resource set an item falls in, for a given caller. */
export function resourceSetFor(item: { owner: string; private: boolean }, userKey: string) {
  const owner = item.owner === userKey ? 'caller' : 'other';
  const set = RESOURCE_SETS.find((s) => s.owner === owner && s.private === item.private);
  if (set === undefined) throw new Error(`No resource set matches owner ${owner}`);
  return set.key;
}
