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
   plan destroys, lists its role assignments or tuples through Permit's API and keeps them with the run.
2. When a push contains a commit that says "This reverts commit X", `restore` fetches the file X's run
   kept and recreates exactly those assignments and tuples, skipping people and instances that no longer
   exist.

If you'd rather a role were never deleted by accident, Terraform's `lifecycle { prevent_destroy = true }`
on it makes any plan that would delete it fail.

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
