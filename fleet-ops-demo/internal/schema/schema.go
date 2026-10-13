// Package schema is the Permit schema for Fleet Ops: a multi-tenant fleet model, and nothing else.
// Resource types org, region, site, asset and team with
// their key actions; the roles org_admin, region_manager, site_manager, operator, technician, viewer,
// team_supervisor and partner_technician; and the model's attributes.
//
// A Derivation reads "a user with Role on the OnResource that is this instance's Relation gets this
// role here".
package schema

import "strings"

type Attribute struct{ Key, Type, Description string }

type Derivation struct{ Role, OnResource, Relation string }

type Role struct {
	Key, Name   string
	Permissions []string // action keys of the role's own resource type
	DerivedFrom []Derivation
}

type Relation struct{ Key, Subject string }

type Resource struct {
	Key, Name  string
	Actions    []string
	Relations  []Relation
	Attributes []Attribute
	Roles      []Role
}

// TenantRole is an org-level role: scoped to the tenant it is assigned in. Attribute-based rules read
// it through user.roles, which holds the user's roles in the check's tenant only.
type TenantRole struct {
	Key, Name, Description string
	Permissions            []string // "resource:action"
}

// Condition is one test in a condition set, e.g. {"resource.region": {"equals": "South"}}.
type Condition struct {
	Ref, Op string
	Value   any
}

type ConditionSet struct {
	Key, Name, Type string // Type: userset or resourceset
	Resource        string // resource sets only
	AllOf           []Condition
}

// Conditions is the condition set in Permit's JSON form.
func (cs ConditionSet) Conditions() map[string]any {
	all := make([]any, len(cs.AllOf))
	for n, c := range cs.AllOf {
		all[n] = map[string]any{c.Ref: map[string]any{c.Op: c.Value}}
	}
	return map[string]any{"allOf": all}
}

type ConditionSetRule struct{ UserSet, Permission, ResourceSet string }

var UserAttributes = []Attribute{
	{Key: "certifications", Type: "array", Description: "Service certifications held: tier1, tier2, tier3"},
	{Key: "home_tenant", Type: "string", Description: "Organization that employs the user"},
	// Scenario 14: the grant attributes, expires_at and incident_id. Permit can't put attributes on a
	// role assignment, so each time-boxed grant is stored on the person: [{tenant, incident_id,
	// expires_at (Unix seconds)}], read by the custom policy rule in the GitOps repo.
	{Key: "breakglass", Type: "json", Description: "Time-boxed grants: tenant, incident_id, expires_at"},
}

func from(role, onResource string) []Derivation {
	return []Derivation{{Role: role, OnResource: onResource, Relation: "parent"}}
}

var Resources = []Resource{
	{
		Key:       "org",
		Name:      "Organization",
		Actions:   []string{"manage_users", "assign_roles"},
		Relations: []Relation{{Key: "parent", Subject: "org"}}, // sub-orgs (scenario 3)
		Roles: []Role{
			// The parent organization's admin is also admin of every sub-organization (scenario 3).
			{Key: "org_admin", Name: "Org admin", Permissions: []string{"manage_users", "assign_roles"}, DerivedFrom: from("org_admin", "org")},
		},
	},
	{
		Key:       "region",
		Name:      "Region",
		Actions:   []string{"view", "assign_roles"},
		Relations: []Relation{{Key: "parent", Subject: "org"}},
		Roles: []Role{
			{Key: "region_manager", Name: "Region manager", Permissions: []string{"view", "assign_roles"}, DerivedFrom: from("org_admin", "org")},
		},
	},
	{
		Key:       "site",
		Name:      "Site",
		Actions:   []string{"view", "assign_roles"},
		Relations: []Relation{{Key: "parent", Subject: "region"}},
		Roles: []Role{
			{Key: "site_manager", Name: "Site manager", Permissions: []string{"view", "assign_roles"}, DerivedFrom: from("region_manager", "region")},
			// Assigned on a site; each carries down to the site's assets under the same name.
			{Key: "operator", Name: "Operator", Permissions: []string{"view"}},
			{Key: "technician", Name: "Technician", Permissions: []string{"view"}},
			{Key: "viewer", Name: "Viewer", Permissions: []string{"view"}},
		},
	},
	{
		Key:       "asset",
		Name:      "Asset (truck)",
		Actions:   []string{"view", "operate", "service_basic", "service_advanced", "decommission"},
		Relations: []Relation{{Key: "parent", Subject: "site"}},
		Attributes: []Attribute{
			{Key: "region", Type: "string", Description: "Operating region (South, West, East)"},
			{Key: "served_account", Type: "string", Description: "Shipper account the truck serves"},
			{Key: "lifecycle_state", Type: "string", Description: "unassigned, active, transferring, decommissioned"},
			{Key: "owner_org", Type: "string", Description: "Organization that owns the truck"},
			{Key: "operator_org", Type: "string", Description: "Organization that operates the truck"},
		},
		Roles: []Role{
			// Permit keeps a resource's permissions on that resource's own roles, so the site roles also
			// exist on assets, derived from the asset's site. The site manager's share is the ownership
			// action, decommission (scenarios 7 and 13); service needs a certification (scenario 9).
			{Key: "site_manager", Name: "Site manager", Permissions: []string{"view", "decommission"}, DerivedFrom: from("site_manager", "site")},
			{Key: "operator", Name: "Operator", Permissions: []string{"view", "operate"}, DerivedFrom: from("operator", "site")},
			{Key: "technician", Name: "Technician", Permissions: []string{"view", "service_basic", "service_advanced"}, DerivedFrom: from("technician", "site")},
			{Key: "viewer", Name: "Viewer", Permissions: []string{"view"}, DerivedFrom: from("viewer", "site")},
			// A user from another tenant, given this role on named assets only (scenario 6): never derived.
			{Key: "partner_technician", Name: "Partner technician", Permissions: []string{"view", "service_basic", "service_advanced"}},
		},
	},
	{
		Key:       "team",
		Name:      "Team",
		Actions:   []string{"view_activity"},
		Relations: []Relation{{Key: "parent", Subject: "site"}},
		Roles: []Role{
			{Key: "team_supervisor", Name: "Team supervisor", Permissions: []string{"view_activity"}},
		},
	},
}

// TenantRoles: scenario 11 grants roles on attribute-based sets of assets. The roles hold no permission
// of their own; the rules below give them the assets whose attributes match.
var TenantRoles = []TenantRole{
	{Key: "operator", Name: "Operator (org-level)", Description: "Views and operates the organization's assets in region South"},
	{Key: "viewer", Name: "Viewer (org-level)", Description: "Views the organization's assets that serve account Acct1"},
}

// ConditionSets: scenario 11's two resource sets.
var ConditionSets = []ConditionSet{
	{
		Key:      "south_assets",
		Name:     "Assets where region = South",
		Type:     "resourceset",
		Resource: "asset",
		AllOf:    []Condition{{Ref: "resource.region", Op: "equals", Value: "South"}},
	},
	{
		Key:      "acct1_assets",
		Name:     "Assets where served_account = Acct1",
		Type:     "resourceset",
		Resource: "asset",
		AllOf:    []Condition{{Ref: "resource.served_account", Op: "equals", Value: "Acct1"}},
	},
}

// RoleSet is the user set Permit makes for an org-level role: everyone who holds the role in the
// acting organization. A rule that only asks for a role attaches to it, the way the role card's
// resource-set columns in the dashboard do, so no user set of our own is needed.
func RoleSet(role string) string { return roleSetPrefix + role }

const roleSetPrefix = "__autogen_"

// IsRoleSet reports whether a condition set is one Permit made for a role.
func IsRoleSet(key string) bool { return strings.HasPrefix(key, roleSetPrefix) }

var ConditionSetRules = []ConditionSetRule{
	{UserSet: RoleSet("operator"), Permission: "asset:view", ResourceSet: "south_assets"},
	{UserSet: RoleSet("operator"), Permission: "asset:operate", ResourceSet: "south_assets"},
	{UserSet: RoleSet("viewer"), Permission: "asset:view", ResourceSet: "acct1_assets"},
}

// ConditionSetByKey finds a set of ours, or describes a role's own user set (which the sync doesn't
// create: Permit makes it with the role) as the one condition it holds.
func ConditionSetByKey(key string) (ConditionSet, bool) {
	for _, cs := range ConditionSets {
		if cs.Key == key {
			return cs, true
		}
	}
	if role, ok := strings.CutPrefix(key, roleSetPrefix); ok {
		return ConditionSet{Key: key, Name: role, Type: "userset", AllOf: []Condition{{Ref: "user.roles", Op: "array_contains", Value: role}}}, true
	}
	return ConditionSet{}, false
}

// ResourceByKey finds a resource type.
func ResourceByKey(key string) (Resource, bool) {
	for _, r := range Resources {
		if r.Key == key {
			return r, true
		}
	}
	return Resource{}, false
}
