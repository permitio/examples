import type { Permit } from 'permitio';
import { vi } from 'vitest';
import type { PermitChecker } from '#src/authorize';
import {
  type Action,
  type BotType,
  GRANTS,
  RESOURCE_KEY,
  resourceSetFor,
  userSetFor,
} from '#src/policy';

type Check = Parameters<Permit['bulkCheck']>[0][number];

/**
 * Answers a check the way a PDP running the example's policy would, from GRANTS. The policy's
 * conditions themselves are checked in write-policy.test.ts.
 */
function answer(check: Check): boolean {
  if (typeof check.user === 'string' || typeof check.resource === 'string')
    throw new Error('the app sends users and resources as objects');
  const botType = check.user.attributes?.['botType'] as BotType;
  const { owner, private: isPrivate } = check.resource.attributes as {
    owner: string;
    private: boolean;
  };
  if (check.resource.type !== RESOURCE_KEY) return false;
  const resourceSet = resourceSetFor({ owner, private: isPrivate }, check.user.key);
  const actions = GRANTS[userSetFor(botType)][resourceSet] ?? [];
  return actions.includes(check.action as Action);
}

/** A stand-in for the Permit SDK's bulkCheck, with the policy applied. */
export function fakePermit() {
  const bulkCheck = vi.fn<Permit['bulkCheck']>(async (checks) => checks.map(answer));
  return { bulkCheck } satisfies PermitChecker;
}
