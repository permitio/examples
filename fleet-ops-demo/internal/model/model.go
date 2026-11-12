// Package model is the seed data for Fleet Ops: the smallest dataset that shows the demo's
// scenarios 1 to 17 on its fleet model (see the README).
//
// The sync command writes it to Permit. The app reads authorization data back from Permit and takes
// names, team members, delivery lanes and starting activity from here.
//
// Tenancy: every customer organization is a Permit tenant, and so is Fleet Ops, the platform operator,
// whose org admins are platform staff. The acting organization is passed as the tenant on every
// check; the custom tenant-isolation rule denies a check about another organization's resource.
// Hierarchy (ReBAC): org -> (sub-org ->) region -> site -> asset (truck), plus team under site.
package model

import (
	"fmt"
	"strings"
)

type Tenant struct {
	Key, Name, Description string
	Partner                bool // a partner organization (maintenance company), not a carrier
	Platform               bool // Fleet Ops, the platform operator
}

type User struct {
	Key, FirstName, LastName string
	// HomeTenant is the organization that employs the person. "freightline" (a broker) holds no
	// Permit tenant of its own.
	HomeTenant     string
	Certifications []string
	Title, Email   string
}

// Instance is a resource instance. Parent is the instance it hangs under, written to Permit as a
// `parent` relationship tuple.
type Instance struct {
	Type, Key, Tenant, Name, Parent string
	Attributes                      map[string]any
}

func (i Instance) ID() string { return i.Type + ":" + i.Key }

// Tuple is one relationship tuple: Subject --Relation--> Object.
type Tuple struct{ Subject, Relation, Object, Tenant string }

// RoleAssignment is an org-level (tenant) role when ResourceInstance is empty, else a role on that
// instance ("type:key").
type RoleAssignment struct{ User, Role, ResourceInstance, Tenant string }

// PlatformTenant is Fleet Ops, the platform operator, which manages all the tenants. Its org admins
// are platform staff; platform-only actions are checked on its org.
const (
	PlatformTenant = "platform"
	PlatformOrg    = "org:" + PlatformTenant
)

var Tenants = []Tenant{
	{Key: "acme", Name: "Acme Freight", Description: "Customer (tenant A)"},
	{Key: "lonestar", Name: "Lone Star Logistics", Description: "Customer (tenant B)"},
	{Key: "summit", Name: "Summit Freight Group", Description: "Customer with two sub-organizations, Summit East and Summit West (scenario 3)"},
	{Key: "mesa", Name: "Mesa Fleet Services", Description: "Maintenance partner (tenant P)", Partner: true},
	{Key: PlatformTenant, Name: "Fleet Ops", Description: "Platform operator: manages every customer organization", Platform: true},
}

// homeNames names the employers that are not Permit tenants.
var homeNames = map[string]string{"freightline": "Freightline Brokers"}

var Users = func() []User {
	people := []struct {
		key, first, last, home string
		certs                  []string
		title                  string
	}{
		{"ava", "Ava", "Stone", PlatformTenant, nil, "Platform operator at Fleet Ops"},
		{"olivia", "Olivia", "Chen", "acme", nil, "Org admin at Acme Freight"},
		{"rachel", "Rachel", "Reyes", "acme", nil, "Region manager for South at Acme Freight"},
		{"sam", "Sam", "Ortiz", "acme", nil, "Site manager for Dallas, supervisor of the night shift"},
		{"ivy", "Ivy", "Walker", "acme", []string{"tier1"}, "Technician at Dallas with tier 1, night shift"},
		{"quinn", "Quinn", "Ellis", "acme", nil, "Operator on Acme's South trucks, day shift"},
		{"riley", "Riley", "Shaw", "acme", nil, "Viewer on Acme's Acct1 trucks"},
		{"lena", "Lena", "Park", "lonestar", nil, "Org admin at Lone Star Logistics"},
		{"avery", "Avery", "Cole", "summit", nil, "Org admin at Summit Freight Group"},
		{"jamie", "Jamie", "Ortega", "summit", nil, "Org admin of Summit East"},
		{"pat", "Pat", "Morgan", "mesa", []string{"tier1", "tier2"}, "Partner technician at Mesa Fleet Services"},
		{"jordan", "Jordan", "Lee", "mesa", []string{"tier1", "tier3"}, "Contract technician at Mesa, delegated by Acme and Lone Star"},
		{"skyler", "Skyler", "Grant", "freightline", nil, "Freight broker at Freightline (shared trucks only)"},
	}
	users := make([]User, len(people))
	for n, p := range people {
		certs := p.certs
		if certs == nil {
			certs = []string{}
		}
		users[n] = User{Key: p.key, FirstName: p.first, LastName: p.last, HomeTenant: p.home, Certifications: certs, Title: p.title, Email: fmt.Sprintf("%s@%s.example", p.key, p.home)}
	}
	return users
}()

// ---- Resource instances -------------------------------------------------------------------------

var Orgs = []Instance{
	{Type: "org", Key: "acme", Tenant: "acme", Name: "Acme Freight"},
	{Type: "org", Key: "lonestar", Tenant: "lonestar", Name: "Lone Star Logistics"},
	// Scenario 3: a group with two sub-organizations, each owning its own tree.
	{Type: "org", Key: "summit", Tenant: "summit", Name: "Summit Freight Group"},
	{Type: "org", Key: "summit-east", Tenant: "summit", Name: "Summit East", Parent: "org:summit"},
	{Type: "org", Key: "summit-west", Tenant: "summit", Name: "Summit West", Parent: "org:summit"},
	{Type: "org", Key: "mesa", Tenant: "mesa", Name: "Mesa Fleet Services"},
	{Type: "org", Key: PlatformTenant, Tenant: PlatformTenant, Name: "Fleet Ops"},
}

var Regions = []Instance{
	{Type: "region", Key: "acme-south", Tenant: "acme", Name: "South", Parent: "org:acme"},
	{Type: "region", Key: "acme-west", Tenant: "acme", Name: "West", Parent: "org:acme"},
	{Type: "region", Key: "lonestar-south", Tenant: "lonestar", Name: "South", Parent: "org:lonestar"},
	{Type: "region", Key: "summit-east-main", Tenant: "summit", Name: "East", Parent: "org:summit-east"},
	{Type: "region", Key: "summit-west-main", Tenant: "summit", Name: "West", Parent: "org:summit-west"},
}

var Sites = []Instance{
	// Scenarios 1, 2 and 4: two sibling sites in one region.
	{Type: "site", Key: "acme-dallas", Tenant: "acme", Name: "Dallas terminal", Parent: "region:acme-south"},
	{Type: "site", Key: "acme-houston", Tenant: "acme", Name: "Houston terminal", Parent: "region:acme-south"},
	{Type: "site", Key: "acme-phoenix", Tenant: "acme", Name: "Phoenix terminal", Parent: "region:acme-west"},
	{Type: "site", Key: "lonestar-fortworth", Tenant: "lonestar", Name: "Fort Worth terminal", Parent: "region:lonestar-south"},
	{Type: "site", Key: "summit-atlanta", Tenant: "summit", Name: "Atlanta terminal", Parent: "region:summit-east-main"},
	{Type: "site", Key: "summit-denver", Tenant: "summit", Name: "Denver terminal", Parent: "region:summit-west-main"},
}

// Teams: scenario 5. Both teams work at Dallas; Sam supervises the night shift only.
var Teams = []Instance{
	{Type: "team", Key: "acme-dallas-night", Tenant: "acme", Name: "Dallas night shift", Parent: "site:acme-dallas"},
	{Type: "team", Key: "acme-dallas-day", Tenant: "acme", Name: "Dallas day shift", Parent: "site:acme-dallas"},
}

// TeamMembers is app data: who works on which team. Permit decides who may view a team's activity.
var TeamMembers = map[string][]string{
	"team:acme-dallas-night": {"ivy"},
	"team:acme-dallas-day":   {"quinn"},
}

func truck(tenant, site, code, region string, extra map[string]any) Instance {
	attrs := map[string]any{
		"region":          region,
		"served_account":  "Acct1",
		"lifecycle_state": "active",
		"owner_org":       tenant,
		"operator_org":    tenant,
	}
	for k, v := range extra {
		attrs[k] = v
	}
	return Instance{
		Type:       "asset",
		Key:        tenant + "-" + strings.ToLower(code),
		Tenant:     tenant,
		Name:       "Truck " + code,
		Parent:     "site:" + site,
		Attributes: attrs,
	}
}

var Assets = []Instance{
	// Scenario 6: the partner technician's two named trucks; DAL-01 later moves to Lone Star.
	// Scenario 4: DAL-02 moves to Houston. Scenario 11: DAL-02 serves Acct2.
	truck("acme", "acme-dallas", "DAL-01", "South", nil),
	truck("acme", "acme-dallas", "DAL-02", "South", map[string]any{"served_account": "Acct2"}),
	// Scenario 13: decommissioned.
	truck("acme", "acme-dallas", "DAL-03", "South", map[string]any{"lifecycle_state": "decommissioned"}),
	// Scenario 7: owned by Acme, operated by Lone Star.
	truck("acme", "acme-dallas", "DAL-04", "South", map[string]any{"operator_org": "lonestar"}),
	// Scenario 1: the sibling site's truck. Scenario 8: shared with the broker.
	truck("acme", "acme-houston", "HOU-01", "South", nil),
	// Scenario 11: region West.
	truck("acme", "acme-phoenix", "PHX-01", "West", nil),
	// Scenario 13: not yet assigned to a customer; only platform staff see it.
	truck("acme", "acme-phoenix", "PHX-02", "West", map[string]any{"lifecycle_state": "unassigned"}),
	// Scenarios 8, 10 and 12: Lone Star's truck, also in region South.
	truck("lonestar", "lonestar-fortworth", "FTW-01", "South", nil),
	// Scenario 3: one truck in each sub-organization. Scenario 8: ATL-01 is shared with the broker.
	truck("summit", "summit-atlanta", "ATL-01", "East", nil),
	truck("summit", "summit-denver", "DEN-01", "West", nil),
}

// Lanes are delivery lanes by truck code prefix, offered when dispatching a truck.
var Lanes = map[string][]string{
	"DAL": {"Dallas → Houston", "Dallas → Fort Worth"},
	"HOU": {"Houston → Dallas", "Houston → San Antonio"},
	"PHX": {"Phoenix → El Paso", "Phoenix → Tucson"},
	"FTW": {"Fort Worth → El Paso", "Fort Worth → Houston"},
	"ATL": {"Atlanta → Charlotte", "Atlanta → Nashville"},
	"DEN": {"Denver → Salt Lake City", "Denver → Albuquerque"},
}

// CodeOf is a truck's code, e.g. "DAL-01" for "Truck DAL-01".
func CodeOf(truck Instance) string { return strings.TrimPrefix(truck.Name, "Truck ") }

var Instances = func() []Instance {
	var all []Instance
	for _, group := range [][]Instance{Orgs, Regions, Sites, Teams, Assets} {
		all = append(all, group...)
	}
	return all
}()

// Tuples: every parent link.
var Tuples = func() []Tuple {
	var tuples []Tuple
	for _, i := range Instances {
		if i.Parent != "" {
			tuples = append(tuples, Tuple{Subject: i.Parent, Relation: "parent", Object: i.ID(), Tenant: i.Tenant})
		}
	}
	return tuples
}()

// ---- Role assignments ---------------------------------------------------------------------------
// Resource roles live in the tenant that owns the instance; they reach lower levels by derivation.

var RoleAssignments = func() []RoleAssignment {
	ras := []RoleAssignment{
		{User: "olivia", Role: "org_admin", ResourceInstance: "org:acme", Tenant: "acme"},
		{User: "rachel", Role: "region_manager", ResourceInstance: "region:acme-south", Tenant: "acme"},
		{User: "sam", Role: "site_manager", ResourceInstance: "site:acme-dallas", Tenant: "acme"},
		{User: "sam", Role: "team_supervisor", ResourceInstance: "team:acme-dallas-night", Tenant: "acme"},
		{User: "ivy", Role: "technician", ResourceInstance: "site:acme-dallas", Tenant: "acme"},
		// Scenario 11: org-level roles granted on attribute-based sets of assets.
		{User: "quinn", Role: "operator", Tenant: "acme"},
		{User: "riley", Role: "viewer", Tenant: "acme"},
		{User: "lena", Role: "org_admin", ResourceInstance: "org:lonestar", Tenant: "lonestar"},
		// Scenario 3: the parent organization's admin, and the admin of one sub-organization.
		{User: "avery", Role: "org_admin", ResourceInstance: "org:summit", Tenant: "summit"},
		{User: "jamie", Role: "org_admin", ResourceInstance: "org:summit-east", Tenant: "summit"},
		// Scenario 6: Acme gives Mesa's technician two named trucks, and nothing else.
		{User: "pat", Role: "partner_technician", ResourceInstance: "asset:acme-dal-01", Tenant: "acme"},
		{User: "pat", Role: "partner_technician", ResourceInstance: "asset:acme-dal-02", Tenant: "acme"},
		// Scenario 10: one tier-3 technician, delegated by two organizations.
		{User: "jordan", Role: "technician", ResourceInstance: "site:acme-dallas", Tenant: "acme"},
		{User: "jordan", Role: "technician", ResourceInstance: "site:lonestar-fortworth", Tenant: "lonestar"},
		// Scenario 8: a broker sees the trucks three organizations shared, and nothing else.
		{User: "skyler", Role: "viewer", ResourceInstance: "asset:acme-hou-01", Tenant: "acme"},
		{User: "skyler", Role: "viewer", ResourceInstance: "asset:lonestar-ftw-01", Tenant: "lonestar"},
		{User: "skyler", Role: "viewer", ResourceInstance: "asset:summit-atl-01", Tenant: "summit"},
	}
	// The platform operator manages every tenant: Ava is org admin of Fleet Ops (platform staff) and of
	// each customer organization. The tenant-isolation rule still applies, so she works inside one
	// organization at a time.
	for _, t := range Tenants {
		ras = append(ras, RoleAssignment{User: "ava", Role: "org_admin", ResourceInstance: "org:" + t.Key, Tenant: t.Key})
	}
	return ras
}()

// SeedActivity is what the people page shows as recent activity before anyone uses the app (scenario 5).
var SeedActivity = []struct{ User, Text string }{
	{"ivy", "Logged basic service on Truck DAL-01"},
	{"quinn", "Dispatched Truck HOU-01 on Houston → Dallas"},
	{"ivy", "Logged basic service on Truck DAL-02"},
}

// ---- Lookups ------------------------------------------------------------------------------------

// SeedByID indexes the seeded instances by "type:key".
var SeedByID = func() map[string]Instance {
	m := make(map[string]Instance, len(Instances))
	for _, i := range Instances {
		m[i.ID()] = i
	}
	return m
}()

func TenantOf(key string) (Tenant, bool) {
	for _, t := range Tenants {
		if t.Key == key {
			return t, true
		}
	}
	return Tenant{}, false
}

func UserOf(key string) (User, bool) {
	for _, u := range Users {
		if u.Key == key {
			return u, true
		}
	}
	return User{}, false
}

// UserName is a person's first name.
func UserName(key string) string {
	if u, ok := UserOf(key); ok {
		return u.FirstName
	}
	return key
}

func FullName(key string) string {
	if u, ok := UserOf(key); ok {
		return strings.TrimSpace(u.FirstName + " " + u.LastName)
	}
	return key
}

// OrgName names an organization: a tenant, or another employer (Freightline).
func OrgName(key string) string {
	if t, ok := TenantOf(key); ok {
		return t.Name
	}
	if name, ok := homeNames[key]; ok {
		return name
	}
	return key
}

// PartnerOrgs are the keys of partner organizations.
var PartnerOrgs = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range Tenants {
		if t.Partner {
			m[t.Key] = true
		}
	}
	return m
}()

// TeamOf is the team a person works on, "" when none.
func TeamOf(user string) string {
	for team, members := range TeamMembers {
		for _, m := range members {
			if m == user {
				return team
			}
		}
	}
	return ""
}
