import type { LegacyUser, SeedAccount } from '#src/seed';
import type { LegacyMapping } from '#src/legacy/mapping';

/**
 * One logged request seen through both sides. `could_not_check` means Permit gave no answer: never
 * a match or a mismatch.
 */
export type Outcome = 'match' | 'mismatch' | 'could_not_check';
export interface Row {
  user: string;
  account: string;
  legacy: boolean;
  permit: boolean | null;
  outcome: Outcome;
  expected?: { reason: string; approved_by: string };
}
/** The mismatches of one user; an expected group carries the owner's approval of the tightening. */
export interface MismatchGroup {
  user: string;
  count: number;
  expected?: { reason: string; approved_by: string };
}
/**
 * The comparison in numbers. `unexpected` counts the mismatches no approved tightening covers: the
 * ones the owner has to look at, which the fixed mapping brings to 0.
 */
export interface Summary {
  total: number;
  matches: number;
  mismatches: number;
  unexpected: number;
  could_not_check: number;
  groups: MismatchGroup[];
}
export interface Access {
  user: string;
  account: string;
}

/** How many times the recorded log has each user asking for each account. */
const REPEATS = 13;

/**
 * The legacy app's access log, generated from its users table: 13 rounds, each every user on every
 * account in table order, so 195 requests for the seeded five users and three accounts, and the
 * same order every time.
 */
export function accessLog(users: LegacyUser[], accounts: SeedAccount[]): Access[] {
  const round = users.flatMap((user) =>
    accounts.map((account): Access => ({ user: user.key, account: account.key })),
  );
  return Array.from({ length: REPEATS }, () => round.map((access) => ({ ...access }))).flat();
}

/**
 * Permit's answer to each question, null for each it did not give: a call that failed, or an answer
 * that cannot be lined up with the questions (a different number of them, or something that is not
 * true or false).
 */
async function answersTo(
  log: readonly Access[],
  permit: (pairs: readonly Access[]) => Promise<Array<boolean | null>>,
): Promise<Array<boolean | null>> {
  const unanswered = () => log.map(() => null);
  let answers: unknown;
  try {
    answers = await permit(log);
  } catch {
    return unanswered();
  }
  if (!Array.isArray(answers) || answers.length !== log.length) return unanswered();
  return answers.map((answer) => (typeof answer === 'boolean' ? answer : null));
}

/**
 * The mismatches of each user, in the order each first appears. A group is expected when every one
 * of its mismatches is.
 */
function groupsOf(rows: readonly Row[]): MismatchGroup[] {
  const groups = new Map<
    string,
    { count: number; expected: Row['expected']; allExpected: boolean }
  >();
  for (const row of rows) {
    if (row.outcome !== 'mismatch') continue;
    const group = groups.get(row.user) ?? { count: 0, expected: row.expected, allExpected: true };
    group.count += 1;
    group.allExpected = group.allExpected && row.expected !== undefined;
    groups.set(row.user, group);
  }
  return [...groups].map(([user, { count, expected, allExpected }]) => ({
    user,
    count,
    ...(allExpected && expected ? { expected } : {}),
  }));
}

/**
 * Replays the log through the legacy rule and through Permit (one bulk check), and compares.
 * `approved` are the tightenings the domain owner signed off: a mismatch where the legacy app
 * allowed and Permit denies is expected when its user is among them. A mismatch that loosens access
 * is never expected, and a question Permit did not answer is neither a match nor a mismatch: it is
 * counted on its own.
 */
export async function compare(
  log: readonly Access[],
  legacy: (user: string, account: string) => boolean,
  permit: (pairs: readonly Access[]) => Promise<Array<boolean | null>>,
  approved: LegacyMapping['approved_tightenings'] = [],
): Promise<{ rows: Row[]; summary: Summary }> {
  const answers = await answersTo(log, permit);
  const rows = log.map((access, i): Row => {
    const legacyAllows = legacy(access.user, access.account);
    const permitAllows = answers[i] ?? null;
    const row = {
      user: access.user,
      account: access.account,
      legacy: legacyAllows,
      permit: permitAllows,
    };
    if (permitAllows === null) return { ...row, outcome: 'could_not_check' };
    if (permitAllows === legacyAllows) return { ...row, outcome: 'match' };
    const tightening = legacyAllows ? approved.find((a) => a.user === access.user) : undefined;
    return {
      ...row,
      outcome: 'mismatch',
      ...(tightening
        ? { expected: { reason: tightening.reason, approved_by: tightening.approved_by } }
        : {}),
    };
  });
  const count = (outcome: Outcome) => rows.filter((row) => row.outcome === outcome).length;
  const unexpected = rows.filter(
    (row) => row.outcome === 'mismatch' && row.expected === undefined,
  ).length;
  return {
    rows,
    summary: {
      total: rows.length,
      matches: count('match'),
      mismatches: count('mismatch'),
      unexpected,
      could_not_check: count('could_not_check'),
      groups: groupsOf(rows),
    },
  };
}
