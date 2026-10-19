# Policy as code: the Fleet Ops schema in Terraform

This folder is laid out like the Git repository that Permit's
[GitOps](https://docs.permit.io/integrations/gitops/github) reads. Copy its contents to the root of that
repository to manage the whole policy in Git:

- **the schema** (resource types, roles and what they may do, relations, derivations, attribute rules) as
  Terraform, with Permit's [Terraform provider](https://registry.terraform.io/providers/permitio/permit-io);
- **the custom Rego rules**, which `make apply-policy` installs as `custom/root.rego`, tested on every pull
  request;
- **the CI** that plans every change on its pull request and applies it when it's pushed.

Each Permit environment follows one branch: **Development** follows `main` and **Production** follows a
release branch (`release/*`). Moving a change between environments is ordinary Git: merge, cherry-pick,
revert.

| Path | What it is |
|---|---|
| `terraform/` | The schema: the same objects `make setup` writes through the API (`internal/schema/schema.go`) |
| `terraform/cloud.tf` | Keeps the state in HCP Terraform, one workspace per environment. Delete it to keep the state in a local file |
| `.github/workflows/terraform.yaml` | On a pull request: format check, validate, plan, and the plan posted as a comment. On a push: save what the plan deletes, apply, and restore after a revert |
| `.github/workflows/policy-tests.yaml` | `opa check` and `opa test` on the custom rules, on every pull request and push |
| `ci/permit_snapshot.py` | Saves the data a plan deletes, and puts it back after a revert (below) |

## What a destructive change costs, and the snapshot step

Git and Terraform version the schema: every change is a commit, and rolling back is `git revert` followed
by an apply. They don't version Permit's data. Deleting a role in Permit also deletes every assignment of
it, and deleting a relation deletes its relationship tuples. Reverting the commit brings the role back,
empty: nobody holds it anymore.

`ci/permit_snapshot.py` covers that gap. It is part of this example, not a feature of Permit or of
Terraform:

1. Before each apply, `save` reads the plan (`terraform show -json`), and for every role or relation the
   plan destroys, lists its role assignments or tuples through Permit's API and keeps them with the run
   as an artifact, for 30 days. A run whose plan deletes nothing keeps an empty one, so a revert of it
   can tell "nothing to restore" from "snapshot missing". If the plan destroys a resource type that still
   has instances, `save` stops the apply instead: Permit would delete the instances too, with every
   assignment on them and every relationship they're in, and no snapshot can bring them back. If that's
   what you mean, delete the instances yourself first, then run the job again.
2. After each apply, CI looks through the commits since the branch's last apply for ones that changed
   `terraform/` and say "This reverts commit X". For each, it finds the run that applied X, fetches the
   snapshot that run kept, and `restore` recreates those assignments and tuples. It leaves out what's
   already there and what names a person or instance that no longer exists, and lists anything Permit
   refuses, such as an assignment in a tenant deleted since.

The log shows how many assignments of each role, and relationships of each kind, were saved or restored,
never who holds them.

If you'd rather a role were never deleted by accident, Terraform's `lifecycle { prevent_destroy = true }`
on it makes any plan that would delete it fail.

### What to know before you rely on it

- **Revert the commit a push ended on.** CI knows a run by the last commit of its push, so that's the
  commit whose snapshot it can find. With squash merges every pull request lands as one commit, and this
  always holds. Revert a commit from the middle of a push (a rebase merge, say) and the apply fails and
  says so; see [below](#when-ci-cant-restore-a-revert). CI looks back over the branch's last 100 runs, on
  that branch only.
- **Keep the line `git revert` writes.** CI finds reverts by the `This reverts commit <sha>` line in the
  commit message. A squash merge set to use only the pull request's title drops it, and one set to use
  the title and description keeps it only if the description has it.
- **Snapshots last 30 days** (`retention-days` in `terraform.yaml`, at most 90 unless the repository's
  settings allow more). Revert an older change and the apply fails, reporting the snapshot expired.
- **A failed run doesn't pass its revert on.** If the run carrying a revert fails before its restore
  step, and nothing has been applied from that branch since, fix the cause and re-run it. Once a newer
  push has been applied, don't: re-running an older commit's apply applies its older schema. Restore by
  hand instead. (A run that GitHub cancelled while it waited is different: the next run applies that
  push too, and restores its reverts.)
- **Restore gives back access as it was when the snapshot was taken.** Permit's bulk assignment also
  puts the person back in the tenant if they had left it. Someone whose access was removed on purpose
  since then gets it back. For Production, consider a GitHub environment with required reviewers on the
  `apply` job, so a person approves each apply, revert or not.
- **The snapshot says who had which role.** The log shows only counts, but the artifact holds user keys
  (often emails), and anyone with read access to the repository can download it while it lasts. Keep the
  policy repository private.
- **Use one release branch at a time.** Every `release/*` branch applies to Production. Runs take turns
  per environment, so two never apply at once. But a push to an older release branch applies that branch's
  older schema, deleting what newer releases added, and that isn't a revert, so CI saves it but doesn't
  put it back.

### When CI can't restore a revert

The apply job fails and says why: no run on the branch ended on the reverted commit, or that run's
snapshot has expired or was never kept (the run stopped before saving it). The schema change is applied either way: only the data is missing. To
restore by hand, download the snapshot from the run that applied the reverted change (that run's page in
the Actions tab, under Artifacts, or `gh run download <run id> --name <artifact>`), check it's the one you
mean, and run it with that environment's API key:

```bash
PERMIT_PROJECT=<project key> PERMIT_ENV=<environment key> PERMIT_API_KEY=<environment API key> \
  python3 ci/permit_snapshot.py restore snapshot-<environment>-<commit>-<attempt>.json
```

If the reverted commit came in a push with other commits, that run's snapshot holds what the whole push
deleted, and `restore` puts back whatever of it can exist again. `restore` refuses a snapshot saved in
another environment, and running it twice changes nothing the second time.

## Setting it up

1. **A Permit project with two environments**, Development and Production, both empty, and a
   repository connected through GitOps. Point each environment at its branch with the environment's
   `custom_branch_name` setting (environments API): `main` for Development, your release branch for
   Production.
2. **HCP Terraform**: an organization with two workspaces, `fleet-ops-dev` and `fleet-ops-prod`, set to
   local execution (the runner is GitHub Actions; HCP Terraform keeps the state and its history).
3. **Repository settings**, listed at the top of `terraform.yaml`: the two environments' API keys and an
   HCP Terraform token as secrets, the Permit project key and the HCP Terraform organization as
   variables.
4. **The custom rules.** `make apply-policy` installs `policy/custom.rego` as `custom/root.rego`. Copy
   `policy/custom_test.rego` to `custom/root_test.rego` so `policy-tests.yaml` runs it; the PDP loads only
   the files `.manifest` lists, so the tests never reach it.
5. **The first apply** creates the schema. Then load the seed data with `make reset`, not `make setup`:
   `reset` changes only data, while `setup` would also write the schema Terraform now manages.

To try the schema from your machine first: delete `cloud.tf`, then

```bash
cd terraform
terraform init
TF_VAR_permit_api_key=<environment API key> terraform plan
```
