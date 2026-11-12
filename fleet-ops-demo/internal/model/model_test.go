package model_test

import (
	"slices"
	"strings"
	"testing"

	"fleetops/internal/checks"
	"fleetops/internal/model"
	"fleetops/internal/schema"
)

// Every instance is of a schema type, in a seeded organization, under a parent of the type its
// relation names, in the same organization.
func TestInstancesFitTheSchema(t *testing.T) {
	for _, i := range model.Instances {
		res, ok := schema.ResourceByKey(i.Type)
		if !ok {
			t.Errorf("%s: no resource type %s", i.ID(), i.Type)
			continue
		}
		if _, ok := model.TenantOf(i.Tenant); !ok {
			t.Errorf("%s: unknown organization %s", i.ID(), i.Tenant)
		}
		for key := range i.Attributes {
			if !slices.ContainsFunc(res.Attributes, func(a schema.Attribute) bool { return a.Key == key }) {
				t.Errorf("%s: attribute %s is not in the schema", i.ID(), key)
			}
		}
		if i.Parent == "" {
			continue
		}
		parent, ok := model.SeedByID[i.Parent]
		switch {
		case !ok:
			t.Errorf("%s: parent %s doesn't exist", i.ID(), i.Parent)
		case parent.Tenant != i.Tenant:
			t.Errorf("%s: parent %s is in another organization", i.ID(), i.Parent)
		case !slices.ContainsFunc(res.Relations, func(r schema.Relation) bool { return r.Key == "parent" && r.Subject == parent.Type }):
			t.Errorf("%s: a %s can't be the parent of a %s", i.ID(), parent.Type, i.Type)
		}
	}
}

// Every role assignment names a seeded person, a role of the instance's type (or an org-level role)
// and the instance's own organization.
func TestRoleAssignmentsFitTheSchema(t *testing.T) {
	for _, ra := range model.RoleAssignments {
		if _, ok := model.UserOf(ra.User); !ok {
			t.Errorf("%+v: unknown person", ra)
		}
		if ra.ResourceInstance == "" {
			if !slices.ContainsFunc(schema.TenantRoles, func(tr schema.TenantRole) bool { return tr.Key == ra.Role }) {
				t.Errorf("%+v: no org-level role %s", ra, ra.Role)
			}
			continue
		}
		i, ok := model.SeedByID[ra.ResourceInstance]
		if !ok {
			t.Errorf("%+v: no instance %s", ra, ra.ResourceInstance)
			continue
		}
		if i.Tenant != ra.Tenant {
			t.Errorf("%+v: the instance is in %s", ra, i.Tenant)
		}
		res, _ := schema.ResourceByKey(i.Type)
		if !slices.ContainsFunc(res.Roles, func(r schema.Role) bool { return r.Key == ra.Role }) {
			t.Errorf("%+v: %s has no role %s", ra, i.Type, ra.Role)
		}
	}
}

// Team members, seed activity and the pre-flight checks name people, instances and actions that exist.
func TestReferencesExist(t *testing.T) {
	for team, members := range model.TeamMembers {
		if _, ok := model.SeedByID[team]; !ok {
			t.Errorf("team %s doesn't exist", team)
		}
		for _, m := range members {
			if _, ok := model.UserOf(m); !ok {
				t.Errorf("team %s: unknown person %s", team, m)
			}
		}
	}
	for _, e := range model.SeedActivity {
		if _, ok := model.UserOf(e.User); !ok {
			t.Errorf("activity: unknown person %s", e.User)
		}
	}
	for _, c := range checks.Checks {
		if _, ok := model.UserOf(c.User); !ok {
			t.Errorf("%s: unknown person %s", c.ID, c.User)
		}
		if _, ok := model.TenantOf(c.ActingOrg); !ok {
			t.Errorf("%s: unknown organization %s", c.ID, c.ActingOrg)
		}
		i, ok := model.SeedByID[c.Resource]
		if !ok {
			t.Errorf("%s: no instance %s", c.ID, c.Resource)
			continue
		}
		typ, _, _ := strings.Cut(c.Resource, ":")
		res, _ := schema.ResourceByKey(typ)
		if !slices.Contains(res.Actions, c.Action) {
			t.Errorf("%s: %s is not an action of %s", c.ID, c.Action, i.Type)
		}
	}
}

// Every person works for a seeded organization or a known employer.
func TestHomes(t *testing.T) {
	for _, u := range model.Users {
		if model.OrgName(u.HomeTenant) == u.HomeTenant {
			t.Errorf("%s: unknown employer %s", u.Key, u.HomeTenant)
		}
	}
}
