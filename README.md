# Permit.io examples

Runnable applications that use [Permit.io](https://www.permit.io) for authorization. Each example
lives in its own folder, with a README that explains how to run it and a CI workflow that runs only
when that folder changes.

| Example                                    | What it shows                                                                         | Stack                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| [permit-portal-demo](permit-portal-demo)   | A business portal whose every protected action asks Permit first, with five scenarios | TypeScript, Express, React, Docker, local PDP |

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
