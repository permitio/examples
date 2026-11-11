import type { Permit } from 'permitio';
import { ITEMS, type Item, USER_KEY } from '#src/items';
import {
  ACTIONS,
  type Action,
  type BotType,
  RESOURCE_KEY,
  type ResourceSetKey,
  resourceSetFor,
} from '#src/policy';

/** The part of the Permit SDK the app uses. Tests replace it. */
export type PermitChecker = Pick<Permit, 'bulkCheck'>;

/** Permit's answers for one item: may this kind of caller do each action on it? */
export interface ItemDecision {
  item: Item;
  resourceSet: ResourceSetKey;
  allowed: Record<Action, boolean>;
}

/** The PDP could not answer. The SDK's multi-line messages are put on one line. */
export class PdpError extends Error {
  constructor(cause: unknown) {
    const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ');
    super(`Permit's PDP did not answer: ${detail.trim()}`, { cause });
    this.name = 'PdpError';
  }
}

/**
 * Asks Permit, in one bulk check, whether a caller of this bot type may do each action on each
 * item. The user is always the same; its `botType` attribute and the item's `owner` and `private`
 * attributes are all the policy looks at.
 */
export async function decide(permit: PermitChecker, botType: BotType): Promise<ItemDecision[]> {
  const pairs = ITEMS.flatMap((item) => ACTIONS.map((action) => ({ item, action })));
  let answers: boolean[];
  try {
    // Permit check: one bulk call, a check per item and action.
    answers = await permit.bulkCheck(
      pairs.map(({ item, action }) => ({
        user: { key: USER_KEY, attributes: { botType } },
        action,
        resource: {
          type: RESOURCE_KEY,
          attributes: { owner: item.owner, private: item.private },
        },
      })),
    );
  } catch (err) {
    throw new PdpError(err);
  }
  if (answers.length !== pairs.length)
    throw new PdpError(`asked ${pairs.length} checks, got ${answers.length} answers`);
  return ITEMS.map((item, i) => ({
    item,
    resourceSet: resourceSetFor(item, USER_KEY),
    allowed: Object.fromEntries(
      ACTIONS.map((action, j) => [action, answers[i * ACTIONS.length + j] === true]),
    ) as Record<Action, boolean>,
  }));
}
