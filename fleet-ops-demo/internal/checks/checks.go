// Package checks lists the pre-flight checks for `make verify`: the PDP decisions the runbook relies
// on, one group per scenario.
//
// Scenarios 4 (re-parenting), 6's transfer, 14 (time-boxed access), 15 (revocation) and 16 (tenant
// merge) are flows: the app runs them and its log shows the decisions before and after.
package checks

import (
	"fmt"

	"fleetops/internal/model"
)

type Check struct {
	ID, User, ActingOrg, Resource, Action string
	Expect                                string // allow or deny
}

type row struct{ user, org, resource, action, expect string }

var byScenario = []struct {
	scenario string
	rows     []row
}{
	{"S1", []row{ // role derivation down the tree
		{"rachel", "acme", "asset:acme-hou-01", "view", "allow"}, // region manager: every site and truck in South
		{"rachel", "acme", "asset:acme-dal-02", "view", "allow"},
		{"sam", "acme", "asset:acme-dal-01", "view", "allow"}, // site manager: Dallas only
		{"sam", "acme", "asset:acme-hou-01", "view", "deny"},  // Houston is a sibling site
		{"sam", "acme", "site:acme-houston", "view", "deny"},
	}},
	{"S2", []row{ // scoped admin delegation
		{"rachel", "acme", "site:acme-houston", "assign_roles", "allow"},
		{"sam", "acme", "site:acme-dallas", "assign_roles", "allow"},
		{"sam", "acme", "site:acme-houston", "assign_roles", "deny"},
	}},
	{"S3", []row{ // nested orgs
		{"avery", "summit", "asset:summit-atl-01", "view", "allow"}, // parent org's admin, into Summit East
		{"avery", "summit", "asset:summit-den-01", "view", "allow"}, // and into Summit West
		{"jamie", "summit", "asset:summit-atl-01", "view", "allow"}, // Summit East's admin
		{"jamie", "summit", "asset:summit-den-01", "view", "deny"},  // nothing in Summit West
	}},
	{"S5", []row{ // team supervisor
		{"sam", "acme", "team:acme-dallas-night", "view_activity", "allow"}, // supervises the night shift
		{"sam", "acme", "team:acme-dallas-day", "view_activity", "deny"},    // not the day shift
		{"ivy", "acme", "team:acme-dallas-night", "view_activity", "deny"},  // members don't supervise
	}},
	{"S6", []row{ // partner access on named trucks
		{"pat", "acme", "asset:acme-dal-01", "service_basic", "allow"},
		{"pat", "acme", "asset:acme-hou-01", "view", "deny"},          // not granted
		{"pat", "mesa", "asset:acme-dal-01", "service_basic", "deny"}, // acting for his own organization
	}},
	{"S7", []row{ // owner vs operator
		{"lena", "lonestar", "asset:acme-dal-04", "operate", "allow"},     // the operating organization operates
		{"lena", "lonestar", "asset:acme-dal-04", "decommission", "deny"}, // but owns nothing
		{"sam", "acme", "asset:acme-dal-04", "decommission", "allow"},     // the owner keeps ownership actions
		{"quinn", "acme", "asset:acme-dal-04", "operate", "deny"},         // but not operational ones
		{"ivy", "acme", "asset:acme-dal-04", "service_basic", "deny"},
		// Acting for the operator, only the operator's own roles count: not a role the owner granted.
		{"ivy", "lonestar", "asset:acme-dal-04", "service_basic", "deny"},
		{"jordan", "lonestar", "asset:acme-dal-04", "service_advanced", "deny"},
	}},
	{"S8", []row{ // broker, read-only on shared trucks
		{"skyler", "acme", "asset:acme-hou-01", "view", "allow"},
		{"skyler", "lonestar", "asset:lonestar-ftw-01", "view", "allow"},
		{"skyler", "summit", "asset:summit-atl-01", "view", "allow"},
		{"skyler", "acme", "asset:acme-dal-01", "view", "deny"},    // not shared
		{"skyler", "acme", "asset:acme-hou-01", "operate", "deny"}, // read-only
	}},
	{"S9", []row{ // certifications
		{"ivy", "acme", "asset:acme-dal-01", "service_basic", "allow"},              // tier 1
		{"ivy", "acme", "asset:acme-dal-01", "service_advanced", "deny"},            // no tier 3
		{"olivia", "acme", "org:acme", "manage_users", "allow"},                     // the tenant admin gives tier 1 and 2
		{"olivia", model.PlatformTenant, model.PlatformOrg, "manage_users", "deny"}, // but not tier 3
		{"ava", model.PlatformTenant, model.PlatformOrg, "manage_users", "allow"},   // the platform operator does
	}},
	{"S10", []row{ // portable certification, per-tenant delegation
		{"jordan", "acme", "asset:acme-dal-01", "service_advanced", "allow"},
		{"jordan", "lonestar", "asset:lonestar-ftw-01", "service_advanced", "allow"},
		{"jordan", "acme", "asset:lonestar-ftw-01", "service_advanced", "deny"},
		{"jordan", "lonestar", "asset:acme-dal-01", "service_advanced", "deny"},
	}},
	{"S11", []row{ // attribute-based resource sets
		{"quinn", "acme", "asset:acme-hou-01", "operate", "allow"}, // region South
		{"quinn", "acme", "asset:acme-phx-01", "operate", "deny"},  // region West
		{"riley", "acme", "asset:acme-dal-01", "view", "allow"},    // Acct1
		{"riley", "acme", "asset:acme-dal-02", "view", "deny"},     // Acct2
	}},
	{"S12", []row{ // attribute rules never cross tenants
		{"quinn", "acme", "asset:lonestar-ftw-01", "view", "deny"},     // South, but Lone Star's
		{"quinn", "lonestar", "asset:lonestar-ftw-01", "view", "deny"}, // no role in Lone Star
		{"ava", "lonestar", "asset:acme-dal-01", "view", "deny"},       // even the platform operator: one organization at a time
	}},
	{"S13", []row{ // lifecycle state
		{"ava", "acme", "asset:acme-phx-02", "view", "allow"},   // unassigned: platform staff
		{"olivia", "acme", "asset:acme-phx-02", "view", "deny"}, // and nobody else
		{"riley", "acme", "asset:acme-phx-02", "view", "deny"},  // not even through an attribute rule
		{"sam", "acme", "asset:acme-dal-03", "view", "allow"},   // decommissioned: view
		{"sam", "acme", "asset:acme-dal-03", "decommission", "allow"},
		{"ivy", "acme", "asset:acme-dal-03", "service_basic", "deny"},
	}},
	{"S14", []row{ // time-boxed access: no grant, no access
		{"pat", "acme", "asset:acme-hou-01", "view", "deny"},
	}},
}

var Checks = func() []Check {
	var all []Check
	for _, group := range byScenario {
		for n, r := range group.rows {
			all = append(all, Check{
				ID: fmt.Sprintf("%s-%d", group.scenario, n+1), User: r.user, ActingOrg: r.org, Resource: r.resource,
				Action: r.action, Expect: r.expect,
			})
		}
	}
	return all
}()
