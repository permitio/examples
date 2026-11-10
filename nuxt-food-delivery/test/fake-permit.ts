import type { IResource } from 'permitio';
import { vi } from 'vitest';

type Decide = (user: string, action: string, resource: IResource) => boolean;

/**
 * Stands in for the SDK's `Permit` client: `check` and the `api` methods the app calls, as mocks.
 * `decide` answers the checks; by default every check is allowed. This module imports nothing from
 * permitio at runtime, so a test can build the fake inside `vi.hoisted`, before `vi.mock` runs.
 */
export function fakePermit() {
  const asyncOk = () => vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
  const fake = {
    decide: vi.fn<Decide>(() => true),
    check: vi.fn(async (user: string, action: string, resource: IResource) =>
      fake.decide(user, action, resource),
    ),
    api: {
      resourceInstances: { create: asyncOk(), delete: asyncOk() },
      roleAssignments: { assign: asyncOk(), unassign: asyncOk() },
      users: { create: asyncOk(), sync: asyncOk(), delete: asyncOk() },
    },
  };
  return fake;
}

export type FakePermit = ReturnType<typeof fakePermit>;
