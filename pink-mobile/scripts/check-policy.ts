import type { IResource } from 'permitio';
import { check } from '#lib/authorizer';
import { describeError } from '#lib/errors';

// Run: pnpm check:policy, after setup, with the PDP from Compose on PERMIT_PDP_URL. It asks the
// PDP the questions the API routes ask and compares each answer with the demo's starting state.
// It needs a live PDP, so CI does not run it; the unit tests mock the SDK instead.

interface Expectation {
  user: string;
  action: string;
  resource: string | IResource;
  allowed: boolean;
  because: string;
}

const ownPlan = (user: string): IResource => ({ type: 'plan', attributes: { owner: user } });

const expectations: Expectation[] = [
  {
    user: 'albus@pink.mobile',
    action: 'list',
    resource: 'representatives',
    allowed: true,
    because: 'manager role',
  },
  {
    user: 'albus@pink.mobile',
    action: 'assign',
    resource: 'representatives',
    allowed: true,
    because: 'manager role',
  },
  {
    user: 'sirius@pink.mobile',
    action: 'list',
    resource: 'representatives',
    allowed: false,
    because: 'the representative role cannot list representatives',
  },
  {
    user: 'sirius@pink.mobile',
    action: 'list',
    resource: 'users',
    allowed: true,
    because: 'representative role',
  },
  {
    user: 'harry@potter.io',
    action: 'list',
    resource: 'users',
    allowed: false,
    because: 'customers have no tenant role',
  },
  {
    user: 'harry@potter.io',
    action: 'manage',
    resource: 'account:harry',
    allowed: true,
    because: 'owner of account:harry',
  },
  {
    user: 'hermione@granger.app',
    action: 'manage',
    resource: 'account:hermione',
    allowed: false,
    because: 'Hermione owns no account',
  },
  {
    user: 'hermione@granger.app',
    action: 'view',
    resource: 'account:harry',
    allowed: true,
    because: 'member of account:harry',
  },
  {
    user: 'sirius@pink.mobile',
    action: 'view',
    resource: 'account:harry',
    allowed: true,
    because: 'editor on account:harry',
  },
  {
    user: 'sirius@pink.mobile',
    action: 'view',
    resource: 'account:ron',
    allowed: false,
    because: 'not assigned to Ron',
  },
  {
    user: 'sirius@pink.mobile',
    action: 'change',
    resource: 'plan:harry',
    allowed: true,
    because: 'plan#editor derived from account#editor through parent',
  },
  {
    user: 'luna@pink.mobile',
    action: 'change',
    resource: 'plan:ron',
    allowed: true,
    because: 'plan#editor derived from account#editor through parent',
  },
  {
    user: 'luna@pink.mobile',
    action: 'change',
    resource: 'plan:harry',
    allowed: false,
    because: 'not assigned to Harry',
  },
  {
    user: 'harry@potter.io',
    action: 'change',
    resource: ownPlan('harry@potter.io'),
    allowed: true,
    because: 'active user, owned plan',
  },
  {
    user: 'ron@weasley.me',
    action: 'change',
    resource: ownPlan('ron@weasley.me'),
    allowed: false,
    because: 'Ron is blocked',
  },
  {
    user: 'ron@weasley.me',
    action: 'view',
    resource: ownPlan('ron@weasley.me'),
    allowed: true,
    because: 'blocked users may view their own plan',
  },
  {
    user: 'harry@potter.io',
    action: 'change',
    resource: ownPlan('ron@weasley.me'),
    allowed: false,
    because: 'not the plan owner',
  },
];

const describeResource = (resource: string | IResource) =>
  typeof resource === 'string'
    ? resource
    : `${resource.type} ${JSON.stringify(resource.attributes)}`;

try {
  const answers = await Promise.all(
    expectations.map(({ user, action, resource }) => check(user, action, resource)),
  );
  let failures = 0;
  for (const [index, expectation] of expectations.entries()) {
    const allowed = answers[index];
    const passed = allowed === expectation.allowed;
    if (!passed) failures += 1;
    const verdict = expectation.allowed ? 'allow' : 'deny';
    console.log(
      `${passed ? 'ok  ' : 'FAIL'} ${expectation.user} ${expectation.action} ` +
        `${describeResource(expectation.resource)}: expected ${verdict} (${expectation.because})`,
    );
  }
  console.log(`${expectations.length - failures} of ${expectations.length} decisions as expected`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error(`The policy check could not ask the PDP: ${describeError(error)}`);
  process.exitCode = 1;
}
