# Permit portal demo

A business portal whose every protected action asks [Permit.io](https://www.permit.io) first. Great Eagle Logistics runs the portal for its business customers, Shire Freight and Riders of Rohan. A stand-in for Great Eagle's own systems sits beside it, and a local Permit PDP makes the decisions.

## What's in it

- **`apps/portal`**: the business portal. An Express API that asks Permit before every protected action, and a React web app with a decision panel that shows each check and each change as it happens (http://localhost:3000).
- **`apps/great-eagle-systems`**: a stand-in for the company's own systems: the request workflow, trust facts, the account master, a connector registry, a legacy billing app, and a presenter console (http://localhost:4100).
- **A local PDP** (`permitio/pdp-v2`), connected to your Permit environment (http://localhost:7766).
- **`bin/demo`**: one script to run, seed, reset and rehearse the demo.

The persona menu at the top of the portal stands in for sign-in. In production, the company's identity provider authenticates users; Permit only authorizes them.

## The scenarios

| | Scenario | Who |
|---|---|---|
| S1 | A new organization, the company's checks, and its first admin | Éowyn, Gandalf, Éomer |
| S2 | Delegated administration across EANs, child accounts and locations | Sam, Merry, Frodo |
| S4 | An external collaborator, with approval and automatic expiry | Frodo, Sam, Aragorn |
| S5 | An integration acting for a customer: approval, review, change and revoke | Pippin, Sam |
| S8 | A legacy app moving to Permit: validation, coexistence, revocation and audit | Sam, Frodo |

Each scenario has an automated runner (`bin/demo scenario <profile> <s1|s2|s4|s5|s8>`) that walks it through the portal's API in ten checks.

## Requirements

- Node 24 (see `.nvmrc`) and Docker with Compose.
- A Permit.io environment made for this demo. `bin/demo seed` creates its whole policy, and `bin/demo reset` rewrites its data, so don't use an environment you need for anything else.

## Setup

1. Install: `npm ci`
2. Create `profiles/demo.env` with the environment's API URL and key (see [`profiles/README.md`](profiles/README.md)).
3. Create the policy and the demo data in Permit: `bin/demo seed demo`
4. Build and start the PDP, the systems and the portal: `bin/demo up demo`
5. Check the policy and the starting state: `bin/demo preflight demo`
6. Open the portal at http://localhost:3000 and the presenter console at http://localhost:4100.

Reset to the starting state between runs with `bin/demo reset demo`.

## Commands

| Command | What it does |
|---|---|
| `bin/demo up <profile>` | Builds and starts the stack |
| `bin/demo down <profile>` | Stops it |
| `bin/demo logs <profile>` | Follows the containers' logs |
| `bin/demo seed <profile>` | Creates or updates the policy, the demo data and the preflight fixtures in Permit; safe to re-run |
| `bin/demo preflight <profile>` | Checks the PDP, the policy (a matrix of expected allows and denies) and the demo's starting state |
| `bin/demo reset <profile>` | Puts the demo back in its starting state, then runs preflight |
| `bin/demo scenario <profile> <s1\|s2\|s4\|s5\|s8>` | Runs one scenario end to end |
| `bin/demo replay <profile> --since <ISO time, or 30m, 2h> [--action view_billing] [--details]` | Re-asks the decisions in Permit's audit log against today's policy, and lists those that would change |
| `bin/demo measure <profile>` | Times checks and changes against the PDP |

Optional settings for the stack are in [`.env.example`](.env.example).

## Where the application asks Permit

Every route line that asks Permit carries a `// Permit check:` comment, and every line that writes to Permit a `// Permit write:` comment:

```
git grep -n "Permit check" apps
```

`apps/portal/src/server/permit/enforcer.ts` wraps the SDK's `check`, `bulkCheck`, `filterObjects` and `getUserPermissions`. It adds the current time and the resource's id to each check, and records each decision for the decision panel.

## The Permit SDK

The demo uses `permitio` 3.0.0, built from the open [permit-node pull request #134](https://github.com/permitio/permit-node/pull/134) and vendored as `vendor/permitio-3.0.0-ffe1ccc.tgz` (`tools/build-sdk.sh` rebuilds it). When this demo was built, the latest `permitio` release on npm was 2.7.6.

## Tests

```
npm run typecheck
npx vitest run
```
