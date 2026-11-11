# Permit.io examples

Runnable applications that use [Permit.io](https://www.permit.io) for authorization. Each example
lives in its own folder, with a README that explains how to run it and a CI workflow that runs only
when that folder changes.

| Example                                                    | What it shows                                                                                        | Stack                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [fine-grained-bot-protection](fine-grained-bot-protection) | Different access for humans, good bots and bad bots, classified by Arcjet                            | TypeScript, Express, Arcjet, Docker, local PDP                       |
| [galactic-health-corporation](galactic-health-corporation) | A healthcare portal with RBAC pilot groups, ReBAC caregivers and member groups, and ABAC date bounds | Next.js, MUI, permitio, permit-fe-sdk + CASL, Better Auth, local PDP |
| [mesa-verde-banking](mesa-verde-banking)                   | A bank whose wire transfers combine RBAC, ABAC, ReBAC, a one-time code and approvals                 | Next.js, Better Auth, Permit Elements, Terraform, Docker, local PDP  |
| [nuxt-food-delivery](nuxt-food-delivery)                   | A multi-city food delivery app that combines RBAC, ABAC and ReBAC on the same actions                | Nuxt, Vue, PrimeVue, Docker, local PDP                               |
| [permit-portal-demo](permit-portal-demo)                   | A business portal whose every protected action asks Permit first, with five scenarios                | TypeScript, Express, React, Docker, local PDP                        |
| [pink-mobile](pink-mobile)                                 | Phone plans where RBAC, ReBAC and ABAC decide what managers, representatives and customers may do    | TypeScript, Next.js, Chakra UI, Docker, local PDP                    |

## Checks

Install [prek](https://github.com/j178/prek) 0.5.5 or later, then from the repository root:

```
prek install
prek run --all-files
```

The root `.pre-commit-config.yaml` scans for secrets (gitleaks), checks spelling (typos, configured
in `.typos.toml`) and lints workflows (actionlint, zizmor) and shell scripts (shellcheck, shfmt).
Each example's own `.pre-commit-config.yaml` adds that example's checks, which prek runs from inside
its folder.

In CI, `.github/workflows/repository.yaml` runs the secret scan, the spelling check and the workflow
checks on every push and pull request, and `.github/workflows/<example>.yaml` runs one example's
checks when its folder or its workflow changes.

## Adding an example

1. Put it in a new top-level folder, with a README that explains how to run it.
2. Add `.github/workflows/<folder>.yaml`, filtered to `<folder>/**` and the workflow file itself,
   with every action pinned to a commit SHA.
3. Add the folder's package ecosystem to `.github/dependabot.yml`.
4. Give the folder a `.pre-commit-config.yaml` for its own linters and formatters.

API keys never go in the repository: examples read them from gitignored env files. gitleaks, with
a rule for Permit API keys (`permit_key_…`) in `.gitleaks.toml`, checks every commit locally and
in CI.

## License

MIT. See [LICENSE](LICENSE).
