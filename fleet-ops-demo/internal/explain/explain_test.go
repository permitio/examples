package explain

import (
	"strings"
	"testing"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
)

func nameOf(id string) string {
	if i, ok := model.SeedByID[id]; ok {
		return i.Name
	}
	return id
}

// Debug payloads in the shape the PDP returns (pdp-v2 0.9.16, with the custom rules' debug merged
// in by root.rego), cut down to the fields Explain reads.
func sameOrg(org string) map[string]any {
	return map[string]any{"allow": true, "code": "same_org", "acting_org": org, "resource_org": org}
}

func TestExplain(t *testing.T) {
	for name, tc := range map[string]struct {
		allow  bool
		check  pdp.Check
		debug  map[string]any
		reason string // a part of the expected reason
		code   string
		fleet  string
		grant  string
	}{
		"relationship route, origin first": {
			allow: true,
			check: pdp.NewCheck("rachel", "view", "asset:acme-hou-01", "acme"),
			debug: map[string]any{
				"rebac": map[string]any{"allow": true, "allowing_roles": []any{map[string]any{
					"resource": "asset:acme-hou-01", "role": "asset#site_manager",
					"sources": []any{map[string]any{
						"type": "role_derivation", "resource": "site:acme-houston", "role": "site#site_manager",
						"sources": []any{map[string]any{"type": "role_derivation", "resource": "region:acme-south", "role": "region#region_manager"}},
					}},
				}}},
				"acting_org": sameOrg("acme"),
			},
			reason: "Rachel can view Truck HOU-01 through relationships: region manager on South, derived 2 levels down.",
			code:   "same_org",
		},
		"another organization's resource": {
			check: pdp.NewCheck("quinn", "view", "asset:lonestar-ftw-01", "acme"),
			debug: map[string]any{"acting_org": map[string]any{
				"allow": false, "code": "acting_org_mismatch", "acting_org": "acme", "resource_org": "lonestar",
			}},
			reason: "Truck FTW-01 belongs to Lone Star Logistics, and Quinn is acting for Acme Freight.",
			code:   "acting_org_mismatch",
		},
		"a fleet rule": {
			check: pdp.NewCheck("ivy", "service_advanced", "asset:acme-dal-01", "acme"),
			debug: map[string]any{
				"acting_org": sameOrg("acme"),
				"fleet_rules": map[string]any{"allow": false, "violations": []any{map[string]any{
					"code": "certification_missing", "reason": "advanced service needs a tier 3 certification",
				}}},
			},
			reason: "Ivy can't do advanced service on Truck DAL-01: advanced service needs a tier 3 certification.",
			code:   "same_org",
			fleet:  "certification_missing",
		},
		"the operator's grant": {
			allow: true,
			check: pdp.NewCheck("lena", "operate", "asset:acme-dal-04", "lonestar"),
			debug: map[string]any{
				"acting_org":  map[string]any{"allow": true, "code": "operator_org", "acting_org": "lonestar", "resource_org": "acme"},
				"fleet_rules": map[string]any{"allow": true, "granted_by": "operator_org", "policy_version": "v1"},
			},
			reason: "Lone Star Logistics operates it for Acme Freight",
			code:   "operator_org",
			grant:  "operator_org",
		},
		"nothing allows it": {
			check:  pdp.NewCheck("sam", "view", "asset:acme-hou-01", "acme"),
			debug:  map[string]any{"rebac": map[string]any{"allow": false}, "acting_org": sameOrg("acme")},
			reason: "No role, relationship or rule in Acme Freight lets Sam view Truck HOU-01.",
			code:   "same_org",
		},
	} {
		t.Run(name, func(t *testing.T) {
			e := Explain(tc.allow, tc.debug, tc.check, nameOf)
			if !strings.Contains(e.Reason, tc.reason) {
				t.Errorf("reason %q, want it to contain %q", e.Reason, tc.reason)
			}
			if e.ActingOrg != tc.code || e.FleetRule != tc.fleet || e.Grant != tc.grant {
				t.Errorf("got actingOrg %q, fleetRule %q, grant %q", e.ActingOrg, e.FleetRule, e.Grant)
			}
		})
	}
}

// Without the PDP's debug output there is nothing to explain from: the verdict only, never a
// reason guessed from the missing fields (a denial for another organization's truck used to read
// "No role, relationship or rule in ... lets ...").
func TestExplainWithoutDebug(t *testing.T) {
	c := pdp.NewCheck("sam", "view", "asset:acme-hou-01", "lonestar")
	for name, debug := range map[string]map[string]any{"nil": nil, "empty": {}} {
		t.Run(name, func(t *testing.T) {
			deny := Explain(false, debug, c, nameOf)
			if !strings.HasPrefix(deny.Reason, "Sam can't view Truck HOU-01. No reason to show: ") || strings.Contains(deny.Reason, "No role, relationship or rule") {
				t.Errorf("deny: %q", deny.Reason)
			}
			if allow := Explain(true, debug, c, nameOf); !strings.HasPrefix(allow.Reason, "Sam can view Truck HOU-01. No reason to show: ") {
				t.Errorf("allow: %q", allow.Reason)
			}
		})
	}
	e := Unavailable(false, c, nameOf, "the PDP's debug output couldn't be read: POST /allowed: 500 Internal Server Error")
	if e.Reason != "Sam can't view Truck HOU-01. No reason to show: the PDP's debug output couldn't be read: POST /allowed: 500 Internal Server Error." {
		t.Errorf("Unavailable: %q", e.Reason)
	}
}
