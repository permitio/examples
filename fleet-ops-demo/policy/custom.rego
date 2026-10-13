package permit.custom

import future.keywords.in

# Installed into the GitOps repo (custom/root.rego) by `make apply-policy`, which stamps the version
# below whenever these rules change. Every decision's debug output carries it (scenario 17).
policy_version := "{{POLICY_VERSION}}"

# Permit's OR extension point. It stays false: the grants below go through their own allow rule in
# root.rego, which also requires every constraint.
default allow := false

# -------------------------------------------------------------------------------------------------
# Facts about the request.
# -------------------------------------------------------------------------------------------------

acting_org := object.get(input.resource, "tenant", null)

instance_key := sprintf("%s:%s", [input.resource.type, input.resource.key])

resource_org := data.resource_instances[instance_key].tenant

user_id := sprintf("user:%s", [input.user.key])

# The truck (asset) a request is about.
truck := data.resource_instances[instance_key] {
	input.resource.type == "asset"
}

# Org-level roles the user holds in the acting organization, and roles on its org instance.
acting_org_roles[role] {
	some role in data.role_assignments[user_id][sprintf("__tenant:%s", [acting_org])]
}

acting_org_roles[role] {
	some role in data.role_assignments[user_id][sprintf("org:%s", [acting_org])]
}

# Platform staff are the org admins of the platform operator's own organization, which manages all
# the tenants.
platform_staff {
	"org_admin" in data.role_assignments[user_id]["org:platform"]
}

operational_actions := {"view", "operate", "service_basic", "service_advanced"}

# -------------------------------------------------------------------------------------------------
# Tenant isolation: every decision is constrained to the acting organization.
#
# The application sends the acting organization as the check's tenant. When the resource instance
# is stored in Permit, it must belong to that organization, so roles, relationships and attribute
# rules the user holds through other organizations never apply (scenarios 10 and 12). root.rego
# requires `acting_org_ok` on every allow.
#
# Scenario 7: the one exception is a truck owned by one organization and operated by another. The
# operating organization may act on it for operational actions only.
# -------------------------------------------------------------------------------------------------

operator_access {
	input.action in operational_actions
	truck.attributes.operator_org == acting_org
	truck.tenant != acting_org
}

default acting_org_ok := false

# A check about a specific resource (it names a key) must find that resource in the PDP's data. A
# type-level check (no key) has no owning organization to compare. An unknown resource fails closed.
resource_key_given {
	input.resource.key != ""
}

acting_org_ok {
	not resource_key_given
}

acting_org_ok {
	resource_org == acting_org
}

acting_org_ok {
	operator_access
}

acting_org_code := "same_org" {
	resource_org == acting_org
} else := "operator_org" {
	operator_access
} else := "no_acting_org" {
	resource_org
	acting_org == null
} else := "acting_org_mismatch" {
	resource_org
} else := "unknown_resource" {
	resource_key_given
} else := "not_applicable" {
	true
}

acting_org_reason := sprintf("%s belongs to the acting organization '%s'", [instance_key, resource_org]) {
	acting_org_code == "same_org"
} else := sprintf("%s belongs to '%s' and is operated by the acting organization '%s', which may use it", [instance_key, resource_org, acting_org]) {
	acting_org_code == "operator_org"
} else := sprintf("%s belongs to organization '%s', but the request names no acting organization", [instance_key, resource_org]) {
	acting_org_code == "no_acting_org"
} else := sprintf("%s belongs to organization '%s', but the request acts for '%s': roles, relationships and rules held through other organizations do not apply", [instance_key, resource_org, acting_org]) {
	acting_org_code == "acting_org_mismatch"
} else := sprintf("%s is not in the PDP's data, so its organization can't be checked: denied", [instance_key]) {
	acting_org_code == "unknown_resource"
} else := "a type-level check has no resource organization to compare" {
	true
}

default resource_org_or_null := null

resource_org_or_null := resource_org

acting_org_debug := {
	"allow": acting_org_ok,
	"code": acting_org_code,
	"reason": acting_org_reason,
	"acting_org": acting_org,
	"resource_org": resource_org_or_null,
}

# -------------------------------------------------------------------------------------------------
# Fleet rules: constraints every allow must also satisfy. root.rego requires `fleet_rules_ok`.
#
# Scenario 13: a truck's lifecycle state limits what anyone may do with it.
# Scenario 9: service needs a certification: tier 1 or tier 2 for basic, tier 3 for advanced.
# Scenario 7: on a truck operated by another organization, the owner keeps ownership actions only.
# -------------------------------------------------------------------------------------------------

lifecycle := truck.attributes.lifecycle_state

default user_certifications := []

user_certifications := certs {
	certs := data.users[input.user.key].attributes.certifications
}

certified_basic {
	some c in user_certifications
	c in {"tier1", "tier2"}
}

fleet_violations[v] {
	lifecycle == "unassigned"
	not platform_staff
	v := {"code": "unassigned", "reason": sprintf("%s is unassigned: only the platform staff can see or use it", [instance_key])}
}

fleet_violations[v] {
	lifecycle == "decommissioned"
	not input.action in {"view", "decommission"}
	v := {"code": "decommissioned", "reason": sprintf("%s is decommissioned: only view and decommission are allowed", [instance_key])}
}

fleet_violations[v] {
	input.action == "service_basic"
	not certified_basic
	v := {"code": "certification_missing", "reason": "basic service needs a tier 1 or tier 2 certification"}
}

fleet_violations[v] {
	input.action == "service_advanced"
	not "tier3" in user_certifications
	v := {"code": "certification_missing", "reason": "advanced service needs a tier 3 certification"}
}

fleet_violations[v] {
	truck.attributes.operator_org != truck.tenant
	acting_org == truck.tenant
	input.action in operational_actions
	input.action != "view"
	v := {"code": "operated_by_other_org", "operator_org": truck.attributes.operator_org, "reason": sprintf("%s is operated by '%s': operational actions belong to the operating organization", [instance_key, truck.attributes.operator_org])}
}

fleet_rules_ok {
	count(fleet_violations) == 0
}

# -------------------------------------------------------------------------------------------------
# Grants. root.rego's second allow rule: one of these, AND tenant isolation, AND the fleet rules.
#
# Scenario 7: the operating organization's people use a truck it operates for another organization,
# by the role they hold in their own organization.
# Scenario 14: a time-boxed break-glass grant for an incident. It expires by the clock, with no
# cleanup job. Grants are a user attribute: [{tenant, incident_id, expires_at (Unix seconds)}].
# -------------------------------------------------------------------------------------------------

operator_grants := {
	"org_admin": operational_actions,
	"operator": {"view", "operate"},
	"viewer": {"view"},
}

operator_org_allow {
	operator_access
	some role in acting_org_roles
	input.action in operator_grants[role]
}

breakglass_grants[g] {
	some g in object.get(data.users[input.user.key].attributes, "breakglass", [])
	g.tenant == acting_org
	time.now_ns() < g.expires_at * 1000000000
}

breakglass_allow {
	input.resource.type == "asset"
	input.action in {"view", "service_basic"}
	resource_org == acting_org
	count(breakglass_grants) > 0
}

extra_allow {
	operator_org_allow
}

extra_allow {
	breakglass_allow
}

# -------------------------------------------------------------------------------------------------
# Debug output, merged into every decision's debug by root.rego.
# -------------------------------------------------------------------------------------------------

default granted_by := null

granted_by := "operator_org" {
	operator_org_allow
} else := "breakglass" {
	breakglass_allow
}

default fleet_rules_pass := false

fleet_rules_pass {
	fleet_rules_ok
}

fleet_rules_debug := {
	"allow": fleet_rules_pass,
	"violations": [v | some v in fleet_violations],
	"granted_by": granted_by,
	"breakglass": [g | some g in breakglass_grants],
	"policy_version": policy_version,
}
