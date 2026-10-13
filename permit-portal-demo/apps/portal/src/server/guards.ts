/** Separation of duties, enforced in portal code: the API answers 409. */
export class SelfApprovalError extends Error {}

export function assertDifferentApprover(
  req: { initiated_by: string; requested_for: string },
  approver: string,
): void {
  if (approver === req.initiated_by || approver === req.requested_for) {
    throw new SelfApprovalError(
      'A request cannot be approved by the person who made it or the person it is for.',
    );
  }
}

/**
 * The holders of the admin role whose admin power is in effect right now (Permit allows them
 * `manage_members`).
 */
export async function effectiveAdmins(
  holders: readonly string[],
  isEffective: (user: string) => Promise<boolean>,
): Promise<string[]> {
  const results = await Promise.all(holders.map(async (u) => ((await isEffective(u)) ? u : null)));
  return results.filter((u): u is string => u !== null);
}
