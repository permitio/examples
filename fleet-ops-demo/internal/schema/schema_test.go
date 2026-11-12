package schema

import (
	"slices"
	"strings"
	"testing"
)

// The schema is the model and nothing more: these resource types with these key actions.
func TestResourcesAreTheModel(t *testing.T) {
	model := map[string][]string{
		"org":    {"manage_users", "assign_roles"},
		"region": {"view", "assign_roles"},
		"site":   {"view", "assign_roles"},
		"asset":  {"view", "operate", "service_basic", "service_advanced", "decommission"},
		"team":   {"view_activity"},
	}
	if len(Resources) != len(model) {
		t.Errorf("%d resource types, the model has %d", len(Resources), len(model))
	}
	for _, r := range Resources {
		actions, ok := model[r.Key]
		if !ok {
			t.Errorf("resource %s is not in the model", r.Key)
			continue
		}
		if !slices.Equal(r.Actions, actions) {
			t.Errorf("%s actions = %v, the model has %v", r.Key, r.Actions, actions)
		}
	}
}

// Only the model's roles, and the model's attributes.
func TestRolesAndAttributesAreTheModel(t *testing.T) {
	roles := []string{"org_admin", "region_manager", "site_manager", "operator", "technician", "viewer", "team_supervisor", "partner_technician"}
	for _, r := range Resources {
		for _, role := range r.Roles {
			if !slices.Contains(roles, role.Key) {
				t.Errorf("role %s#%s is not in the model", r.Key, role.Key)
			}
		}
	}
	for _, tr := range TenantRoles {
		if !slices.Contains(roles, tr.Key) {
			t.Errorf("org-level role %s is not in the model", tr.Key)
		}
	}
	assetAttrs := []string{"region", "served_account", "lifecycle_state", "owner_org", "operator_org"}
	asset, _ := ResourceByKey("asset")
	for _, a := range asset.Attributes {
		if !slices.Contains(assetAttrs, a.Key) {
			t.Errorf("asset attribute %s is not in the model", a.Key)
		}
	}
	for _, r := range Resources {
		if r.Key != "asset" && len(r.Attributes) > 0 {
			t.Errorf("%s has attributes; the model gives attributes to assets only", r.Key)
		}
	}
}

// Every permission is an action of the role's resource, and every derivation names a role that exists
// on a resource the relation points to.
func TestRolesAreConsistent(t *testing.T) {
	for _, r := range Resources {
		for _, role := range r.Roles {
			for _, p := range role.Permissions {
				if !slices.Contains(r.Actions, p) {
					t.Errorf("%s#%s: %s is not an action of %s", r.Key, role.Key, p, r.Key)
				}
			}
			for _, d := range role.DerivedFrom {
				rel := slices.IndexFunc(r.Relations, func(x Relation) bool { return x.Key == d.Relation && x.Subject == d.OnResource })
				if rel < 0 {
					t.Errorf("%s#%s: no relation %s to %s", r.Key, role.Key, d.Relation, d.OnResource)
				}
				on, _ := ResourceByKey(d.OnResource)
				if !slices.ContainsFunc(on.Roles, func(x Role) bool { return x.Key == d.Role }) {
					t.Errorf("%s#%s: derived from %s#%s, which doesn't exist", r.Key, role.Key, d.OnResource, d.Role)
				}
			}
		}
	}
	for _, tr := range TenantRoles {
		for _, p := range tr.Permissions {
			typ, action, _ := strings.Cut(p, ":")
			r, ok := ResourceByKey(typ)
			if !ok || !slices.Contains(r.Actions, action) {
				t.Errorf("org-level role %s: unknown permission %s", tr.Key, p)
			}
		}
	}
}

// Every rule must name sets the log's explanation can look up, including a role's own user set, and
// grant an action of the resource set's type.
func TestRulesNameKnownSets(t *testing.T) {
	for _, r := range ConditionSetRules {
		if _, ok := ConditionSetByKey(r.UserSet); !ok {
			t.Errorf("rule %s: unknown user set %q", r.Permission, r.UserSet)
		}
		rs, ok := ConditionSetByKey(r.ResourceSet)
		if !ok {
			t.Errorf("rule %s: unknown resource set %q", r.Permission, r.ResourceSet)
			continue
		}
		if typ, _, _ := strings.Cut(r.Permission, ":"); typ != rs.Resource {
			t.Errorf("rule %s on %s, a set of %s", r.Permission, r.ResourceSet, rs.Resource)
		}
		if role, ok := strings.CutPrefix(r.UserSet, roleSetPrefix); ok && !slices.ContainsFunc(TenantRoles, func(tr TenantRole) bool { return tr.Key == role }) {
			t.Errorf("rule %s: %s is not an org-level role", r.Permission, role)
		}
	}
}

// A role's own user set is described as the one condition it holds, and is not one the sync creates.
func TestRoleSetIsTheRoleAlone(t *testing.T) {
	cs, ok := ConditionSetByKey(RoleSet("operator"))
	if !ok || len(cs.AllOf) != 1 {
		t.Fatalf("got %+v, %v", cs, ok)
	}
	if c := cs.AllOf[0]; c.Ref != "user.roles" || c.Op != "array_contains" || c.Value != "operator" {
		t.Errorf("condition = %+v", c)
	}
	if !IsRoleSet(cs.Key) {
		t.Errorf("%s is not recognized as a role's set", cs.Key)
	}
	for _, own := range ConditionSets {
		if own.Key == cs.Key || IsRoleSet(own.Key) {
			t.Errorf("%s is in ConditionSets, so the sync would try to create it", own.Key)
		}
	}
}
