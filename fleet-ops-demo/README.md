# Fleet Ops: multi-tenant fleet authorization with the Permit Go SDK

Fleet Ops is a small multi-tenant fleet operations app. Customer organizations own regions, sites,
trucks and teams; partner organizations get access to single trucks; a platform operator manages
every organization. Every page and every write is decided by a Permit PDP container running next to
the app, through the Permit Go SDK (`github.com/permitio/permit-golang` v1.2.8).

You sign in as a person, pick the organization you act for, and work with trucks, sites and people.
The acting organization goes into every check as its tenant. A panel beside each page lists every
check the backend sent, with the PDP's answer and why: the relationship route, the attribute rule's
conditions with the values evaluated, the tenant-isolation verdict and the custom policy version.

## What it shows

| # | Scenario | How it is built |
|---|---|---|
| 1 | Role derivation down the tree: a region manager reaches every site and truck in the region; a site manager stops at the site | Built into Permit (ReBAC) |
| 2 | Scoped admin delegation: a region manager may give roles on any site of the region, a site manager only on their own site | Built into Permit (ReBAC) |
| 3 | Nested organizations: a group admin reaches both sub-organizations; a sub-organization's admin sees nothing in the other | Built into Permit (ReBAC) |
| 4 | Re-parenting: moving a truck to another site replaces one parent link, and derived access follows | Built into Permit (ReBAC) |
| 5 | Team supervisor: sees the activity of their own team's members only | Built into Permit (ReBAC) |
| 6 | Partner access on named trucks, and a transfer that doesn't carry the grant along | Built in, with custom Rego |
| 7 | Owner vs. operator: the operating organization gets operational actions, the owner keeps ownership actions | Custom Rego |
| 8 | Aggregated read-only: a broker sees one shared truck from each of three organizations, and nothing else | Built into Permit (ReBAC) |
| 9 | Certification-gated service; only platform staff may give tier 3 | Built in, with custom Rego |
| 10 | A portable certification with per-organization access | Custom Rego |
| 11 | Attribute-based resource sets ("region = South", "served account = Acct1") granted to org-level roles | Built into Permit (ABAC) |
| 12 | An attribute rule never reaches across organizations | Custom Rego |
| 13 | Lifecycle gating: unassigned and decommissioned trucks | Custom Rego |
| 14 | Time-boxed break-glass access that ends on its own | Custom Rego |
| 15 | Revocation: a partner grant, a person and a whole organization, with nothing left behind | Built into Permit |
| 16 | Merging one organization into another as a sub-organization | Built into Permit |
| 17 | Audit: every decision's reason and policy version, in the app and in Permit's Audit Log | Built in, with custom Rego |

"Custom Rego" means rules Permit's policy editor can't express, kept in the environment's GitOps
repository (`policy/custom.rego`); every allow must also satisfy them. They are configuration, not
out-of-the-box behavior.

## Run it

You need Docker, Go 1.23 or later, a Permit project with an empty environment, and, for the custom
rules, a Git repository connected to that environment through
[GitOps](https://docs.permit.io/integrations/gitops/github). `make test` also needs the
[opa](https://www.openpolicyagent.org/docs/latest/#running-opa) CLI.

1. Copy `.env.example` to `.env` and put the environment's API key in `PERMIT_API_KEY`. The key
   stays on the server; the browser never sees it.
2. Start the PDP, then create the schema and the seed data in Permit:
   ```bash
   make pdp
   make setup
   ```
3. Install the custom rules. Clone the environment's GitOps branch into `policy-repo/` (gitignored),
   with push access, then apply:
   ```bash
   git clone --branch permit/generated/<environment id> <your policy repository> policy-repo
   make apply-policy
   ```
   It writes `custom/root.rego`, makes every allow in `root.rego` require it, pushes, restarts the
   PDP and waits until the PDP has loaded the new version.
4. Check, then start the app on http://localhost:3000:
   ```bash
   make verify
   make start
   ```
   `make verify` should end with "All checks match" (53 checks). In the app, the top of the right
   panel should say "Local PDP connected" and "Custom rules loaded".

| Command | What it does |
|---|---|
| `make pdp` | Start the local container PDP (port 7766) from `docker-compose.yml` |
| `make setup` | Make Permit's schema match `internal/schema` exactly (create what is missing, remove what it doesn't have), then restore the seed |
| `make reset` | Restore the seeded data in Permit (organizations, people, instances, relationships, role assignments, people's attributes); restart the app afterwards |
| `make apply-policy` | Install the custom rules in the GitOps branch, restart the PDP and wait for the new version |
| `make verify` | Pre-flight: PDP up, custom rules loaded, the 53 decisions the scenarios rely on |
| `make start` | Build and run the app on http://localhost:3000 |
| `make test` | Go unit tests, and the custom Rego's unit tests (`opa test --v0-compatible policy/`) |

Steps 13 to 16 of the walkthrough change data for good. Afterwards, stop the app, run `make reset`
and start it again: the app reads its data from Permit when it starts.

## The model

| Resource | Parent | Actions | Roles on it |
|---|---|---|---|
| org | parent org (sub-orgs) | manage_users, assign_roles | org_admin |
| region | parent org | view, assign_roles | region_manager |
| site | parent region | view, assign_roles | site_manager, operator, technician, viewer |
| asset (truck) | parent site | view, operate, service_basic, service_advanced, decommission | site_manager, operator, technician, viewer, partner_technician |
| team | parent site | view_activity | team_supervisor |

- **Derivation down the tree.** An org admin is org admin of every sub-org, and region manager of
  the org's regions. A region manager is site manager of the region's sites. Each site role carries
  down to the site's trucks under the same name. On a truck, the site manager can view and
  decommission, an operator operates, and a technician services. `partner_technician` and
  `team_supervisor` are given directly and never derived.
- **Attributes.** User: `certifications` (tier1 to tier3), `home_tenant` and `breakglass` (the
  time-boxed grants, each with `tenant`, `incident_id` and `expires_at`: Permit can't put attributes
  on a role assignment). Asset: `region`, `served_account`, `lifecycle_state` (unassigned, active,
  transferring, decommissioned), `owner_org` and `operator_org`.
- **Attribute-based sets.** "Assets where region = South" and "Assets where served_account = Acct1".
  The `operator` and `viewer` roles, given at org level, hold permissions on those sets and nothing
  else.
- **The platform operator.** Fleet Ops is an organization of its own; its org admins are platform
  staff. Platform-only actions (giving tier 3, transferring a truck to another organization,
  deleting or merging an organization) are checked as `manage_users` on its organization.

## People and trucks

The sign-in menu groups people by employer. All the organizations and people are fictional.

| Person | Access |
|---|---|
| Ava Stone (Fleet Ops) | Platform operator: org admin of Fleet Ops (platform staff) and of every customer organization |
| Olivia Chen | Org admin, Acme Freight |
| Rachel Reyes | Region manager, Acme South (Dallas and Houston) |
| Sam Ortiz | Site manager, Dallas; supervisor of the Dallas night shift |
| Ivy Walker | Technician at Dallas, tier 1; on the night shift |
| Quinn Ellis | Org-level operator: Acme's trucks in region South; on the day shift |
| Riley Shaw | Org-level viewer: Acme's trucks serving Acct1 |
| Lena Park | Org admin, Lone Star Logistics |
| Avery Cole | Org admin, Summit Freight Group, the parent of Summit East and Summit West |
| Jamie Ortega | Org admin of Summit East only |
| Pat Morgan (Mesa) | Partner technician on DAL-01 and DAL-02 only; tier 1 and 2 |
| Jordan Lee (Mesa) | Technician at Acme's Dallas and Lone Star's Fort Worth, tier 3 |
| Skyler Grant (Freightline) | Broker: viewer on one truck each from Acme, Lone Star and Summit |

Acme has DAL-01 to DAL-04 (Dallas), HOU-01 (Houston), PHX-01 and PHX-02 (Phoenix). DAL-02 serves
Acct2 and the others Acct1. DAL-03 is decommissioned, DAL-04 is operated by Lone Star, PHX-02 is
unassigned, and the Phoenix trucks are in region West. Lone Star has FTW-01 (region South). Summit has
ATL-01 (Summit East) and DEN-01 (Summit West).

## Walkthrough

Use **Signed in as** and **Organization** in the top bar; switching either one re-checks the page
you are on. Steps 13 to 16 change data, so they come last.

| # | Scenario | Do | Point at in the panel |
|---|---|---|---|
| 1 | 1. Role derivation | Sign in as **Rachel**: the fleet shows Dallas and Houston's five trucks. Open **HOU-01**. Switch to **Sam** on the same page | Rachel's ALLOW. Why: region manager on South, then site manager on Houston terminal, then site manager on HOU-01. Sam: DENY, a site role stops at its site |
| 2 | 2. Scoped admin delegation | As **Sam**, open **People**, Give a role: Ivy Walker, Operator, **Houston terminal**: denied. Switch to **Rachel** and give the same role | Sam: DENY on `assign_roles` for Houston. Rachel: ALLOW, then "Can Ivy Walker operate Truck HOU-01 now?" ALLOW |
| 3 | 4. Re-parenting | As **Rachel**, open **DAL-02**, Fleet management, **Move to this site**: Houston terminal | Two site-admin checks, one parent link replaced, no role changed. Then Sam: DENY; Ivy (operator at Houston): ALLOW |
| 4 | 5. Team supervisor | Sign in as **Sam**, open **People** | `view_activity` allowed on the night shift (Ivy's activity shows), denied on the day shift (Quinn's doesn't) |
| 5 | 3. Nested organizations | Sign in as **Avery**: ATL-01 and DEN-01. Open **DEN-01**. Sign in as **Jamie**: ATL-01 only | Avery's route: org admin on Summit Freight Group, Summit West, West, Denver terminal, DEN-01. Jamie's DEN-01 check denies |
| 6 | 9. Certifications | Sign in as **Ivy**, open **DAL-01**: basic service only. Sign in as **Olivia**, **People**, tick Tier 3 for Ivy, **Save certifications**: denied. Tick Tier 2 instead: saved. Sign in as **Ava**, organization **Acme Freight**, **People**, give Ivy Tier 3 | Olivia's tier 3: DENY on `manage_users` for Fleet Ops (platform staff only). Tier 2: ALLOW on Acme. Ava: ALLOW, then "Can Ivy Walker do advanced service on DAL-01 now?" ALLOW |
| 7 | 10. Portable certification | Sign in as **Jordan**, organization **Acme Freight**: Run advanced service on **DAL-01**. Organization **Lone Star Logistics**: Run advanced service on **FTW-01**. Still acting for Lone Star, go to `#/truck/acme-dal-01` | Same certification in both. The last check: DENY, `acting_org_mismatch` |
| 8 | 11. Attribute-based sets | Sign in as **Quinn**: Acme's South trucks, no Phoenix. Sign in as **Riley**: the Acct1 trucks, no DAL-02. As **Rachel**, open **DAL-02**, Details: served account Acct1, **Save details**. Then region West | "Can Riley Shaw see Truck DAL-02 now?" ALLOW. "Can Quinn Ellis operate Truck DAL-02 now?" DENY, with the unmet region condition |
| 9 | 12. Attributes never cross organizations | As **Quinn** (Acme), go to `#/truck/lonestar-ftw-01`: Lone Star's truck is in region South too | DENY with `acting_org_mismatch`: the attribute rule would match, the tenant rule stops it |
| 10 | 7. Owner vs. operator | Sign in as **Lena**: FTW-01 and DAL-04, "Operated by Lone Star". Open **DAL-04**: Dispatch, no Decommission. As **Sam**: Decommission. As **Quinn**: no Dispatch | Lena's allow: "Lone Star Logistics operates it for Acme Freight". Quinn's deny: `operated_by_other_org` |
| 11 | 8. Aggregated read-only | Sign in as **Skyler**, organization **All my organizations**: HOU-01, FTW-01, ATL-01. Open one: view only | One bulk check per organization, each acting for its own organization |
| 12 | 13. Lifecycle gating | As **Ava** acting for Acme, the fleet has 7 trucks including **PHX-02** (unassigned). **Olivia** sees 6. Open **DAL-03** (decommissioned) as **Ivy**: no service. As **Sam**: Reactivate | The `unassigned` and `decommissioned` fleet rules in Why |
| 13 | 6. Partner access, then a transfer | Sign in as **Pat**, organization **Acme Freight**: DAL-01 and DAL-02 only. Sign in as **Ava** (Acme), open **DAL-01**, **Transfer to this organization**: Lone Star Logistics, Fort Worth terminal | "After the transfer: can Pat Morgan still view Truck DAL-01": denied acting for Acme (`acting_org_mismatch`) and for Lone Star (no grant) |
| 14 | 14. Time-boxed access | As **Olivia**, open **Access**, give **Pat** break-glass for INC-1042, 2 minutes. As **Pat** acting for Acme, every Acme truck except the unassigned PHX-02; 2 minutes later only DAL-02 | "During incident INC-1042: can Pat Morgan view …" ALLOW, "under a break-glass grant" |
| 15 | 15. Revocation | As **Olivia**, open **DAL-02**, Partner access, **Revoke** Pat. **People**, **Remove from Permit**: Riley. As **Ava**, open **Organizations**, **Delete** Summit Freight Group | Each shows a before ALLOW and an after DENY, and what Permit still holds: 0 |
| 16 | 16. Merge | As **Ava**, **Organizations**: **Merge** Lone Star Logistics into Acme Freight (about 15 seconds) | Lena keeps her role, now acting for Acme; Olivia reaches Lone Star's trucks through the new sub-organization link |

**17. Audit**, along the way: any check's **Why**, its **PDP response**, and Permit's **Audit Log**
filtered by user. The decision record carries `debug.acting_org` (`same_org` or
`acting_org_mismatch` and its reason) and `debug.fleet_rules.policy_version`.

## Questions you may get

- **Is tenant isolation out of the box?** No, it is configuration. The PDP takes the tenant in a
  check as given: relationship-derived roles apply whatever tenant is passed, and org-level roles and
  attribute rules are read in the tenant passed, without comparing it with the resource's own
  organization. The custom rule adds that comparison and fails closed: a check about a resource the
  PDP doesn't know is denied (`unknown_resource`).
- **Why does a truck have a site manager role?** Permit keeps a resource's permissions on that
  resource's own roles. So each site role is also a role on trucks, derived from the truck's site.
- **Why are operator and viewer also org-level roles?** Attribute rules grant permissions to user
  sets, and a user set can require an org-level role but not a relationship-derived one.
- **Does the tenant rule cover lists?** It covers `/allowed`, `/allowed/bulk` and AuthZEN
  `/access/v1/evaluation`. `/user-permissions` and AuthZEN search don't evaluate the root policy, so
  the app builds its lists with `BulkCheck`.
- **Can an instance move to another organization?** Not in place: a resource instance's tenant is
  fixed. A transfer or a merge deletes the instances and creates them again in the new organization;
  their old links and grants go with the deletion.
- **Where do the reasons in the panel come from?** The SDK's `Check()` and `BulkCheck()` return
  booleans, as an application uses them. For the panel, the app sends the same checks again to the
  PDP's `/allowed` or `/allowed/bulk` and words the debug output it returns.
- **Is the app enforcing, or just hiding buttons?** Both. Pages show only what the PDP allows, and
  every write is checked again on the server before anything is written.

## How it's built

| Path | What it is |
|---|---|
| `cmd/server`, `internal/server` | The app: loads authorization data from Permit at start, asks the PDP before showing anything, checks every write again before making it, writes through the SDK's API client, and returns each check for the panel. Pages: fleet, truck, site, people, access, organizations |
| `web/` | The page (`index.html`, `app.js`, `styles.css`), built into the binary |
| `internal/schema` | The Permit schema: resource types, actions, roles and derivations, the two org-level roles and the attribute rules |
| `internal/model` | Seed data: 5 organizations (the platform operator and four customers), 13 people, 30 resources, 25 parent links, 22 role assignments, team members and starting activity |
| `policy/` | The custom Rego (`custom.rego`) and its unit tests; `make apply-policy` installs it as `custom/root.rego` |
| `cmd/sync` | `make setup` makes Permit's schema match the code and restores the seed; `make reset` (`--reset`) restores the seed only |
| `internal/pdp` | `permitClient.Check()` and `permitClient.BulkCheck()`, the PDP debug requests, status, and waits on the PDP's data |
| `internal/explain` | Turns the PDP's debug output into the reason, route, rule conditions and fleet rules in the panel |
| `internal/checks`, `cmd/verify` | The 53 pre-flight checks behind `make verify` |
| `cmd/apply-policy` | Installs the custom rules in the GitOps branch, restarts the PDP and waits for the new version |
| `internal/permitapi` | A timeout, retries and paging around every API call |

### Where the SDK is used

- Decisions: `permitClient.Check` and `permitClient.BulkCheck` in
  [`internal/pdp/pdp.go`](internal/pdp/pdp.go).
- Writes from the app: `Api.ResourceInstances`, `Api.RelationshipTuples`, `Api.Users` (assign and
  unassign resource roles, update attributes, delete), `Api.Tenants.Delete` and
  `Api.Roles.BulkAssignRole` in [`internal/server`](internal/server).
- Setup and reset: `Api.Resources`, `ResourceActions`, `ResourceAttributes`, `ResourceRelations`,
  `ResourceRoles`, `ImplicitGrants`, `Roles`, `ConditionSets`, `Tenants`, `Users.SyncUser`,
  `Roles.BulkAssignRole` and `BulkUnAssignRole` in [`cmd/sync/main.go`](cmd/sync/main.go), with
  their `Delete` methods to remove what the schema or the seed doesn't have.

### Notes on the Go SDK (v1.2.8)

- `BulkCheck` splits the checks by tenant and sends one `/allowed/bulk` request per tenant.
- `ResourceRoleUpdate` has no `granted_to`, so role derivations are created one rule at a time with
  `Api.ImplicitGrants.Create`, and removed with `Api.ImplicitGrants.Delete`. `Delete` names its
  arguments `(roleId, resourceId)` but builds the URL from them as resource then role, the same order
  as `Create`.
- `ConditionSets.ListSetPermissions` always sends its three filters, and empty filters match
  nothing; `ConditionSets.List` expects a paginated answer and reads the API's plain list as empty.
  `cmd/sync` reads both collections from the REST API instead.
- The facts API clients (resource instances, relationship tuples, role assignments) have no HTTP
  timeout. Every API call here runs with a 20-second timeout and retries.

### Notes on the PDP (pdp-v2 0.9.16)

- After an instance is deleted, the PDP keeps a stub without a tenant. The tenant-isolation rule
  therefore fails closed for unknown instances.
- Deleting an instance and creating it again with the same key (transfer, merge, reset) can race:
  the deletion of the old links can reach the PDP after the new data. The app and `make reset` wait
  until the PDP has dropped the old instance before creating it again, then require every parent
  link to stay in the PDP, refetching its data when some are missing.
- A schema change leaves the relationship cache that `/user-permissions` and AuthZEN search use
  incomplete until it is rebuilt; `make setup` rebuilds it.
