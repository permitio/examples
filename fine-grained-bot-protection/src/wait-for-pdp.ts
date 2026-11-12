import { decide, type PermitChecker } from '#src/authorize';
import { ITEMS } from '#src/items';
import { ACTIONS, GRANTS, USER_SETS } from '#src/policy';

/** The PDP still answers from another policy, or not at all, when the wait runs out. */
export class PdpNotReadyError extends Error {
  override name = 'PdpNotReadyError';
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
}

const DEFAULT_WAIT: WaitOptions = { timeoutMs: 60_000, intervalMs: 1_000 };

/**
 * Asks the PDP every check the app can send, one bulk check per user set, and lists each answer
 * that differs from GRANTS, such as `Untrusted_Bots read on Private Item: allowed, GRANTS denies`.
 */
export async function differencesFromGrants(permit: PermitChecker): Promise<string[]> {
  const differences: string[] = [];
  for (const set of USER_SETS) {
    const decisions = await decide(permit, set.botTypes[0]);
    for (const { item, resourceSet, allowed } of decisions) {
      const granted: readonly string[] = GRANTS[set.key][resourceSet] ?? [];
      for (const action of ACTIONS) {
        const expected = granted.includes(action);
        if (allowed[action] === expected) continue;
        const answer = allowed[action] ? 'allowed' : 'denied';
        differences.push(
          `${set.key} ${action} on ${item.name}: ${answer}, GRANTS ${expected ? 'allows' : 'denies'}`,
        );
      }
    }
  }
  return differences;
}

/**
 * Waits until the PDP answers every check as GRANTS says. The PDP gets a policy change a few
 * seconds after Permit stores it, so without this wait the app's first requests are decided by the
 * policy the PDP had before setup ran.
 */
export async function waitForPdp(
  permit: PermitChecker,
  log: (line: string) => void,
  { timeoutMs, intervalMs }: WaitOptions = DEFAULT_WAIT,
): Promise<void> {
  const total = USER_SETS.length * ITEMS.length * ACTIONS.length;
  const deadline = Date.now() + timeoutMs;
  let logged = '';
  for (;;) {
    let problem: string;
    try {
      const differences = await differencesFromGrants(permit);
      if (differences.length === 0) return;
      problem = `${differences.length} of ${total} answers differ from GRANTS, such as ${differences[0]}`;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline)
      throw new PdpNotReadyError(
        `The PDP did not apply the policy within ${timeoutMs / 1000} s: ${problem}`,
      );
    if (problem !== logged) log(`waiting for the PDP: ${problem}`);
    logged = problem;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
