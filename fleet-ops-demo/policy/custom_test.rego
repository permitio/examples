package permit.custom

# Unit tests for custom.rego with mock data in the PDP's layout: opa test --v0-compatible policy/

import future.keywords.in

mock := {
	"resource_instances": {
		"asset:a1": {"tenant": "acme", "attributes": {"lifecycle_state": "active", "operator_org": "acme"}},
		"asset:dec": {"tenant": "acme", "attributes": {"lifecycle_state": "decommissioned", "operator_org": "acme"}},
		"asset:un": {"tenant": "acme", "attributes": {"lifecycle_state": "unassigned", "operator_org": "acme"}},
		"asset:op": {"tenant": "acme", "attributes": {"lifecycle_state": "active", "operator_org": "lonestar"}},
		"site:s1": {"tenant": "acme", "attributes": {}},
	},
	"role_assignments": {
		"user:ava": {"org:platform": ["org_admin"], "org:acme": ["org_admin"]},
		"user:olivia": {"org:acme": ["org_admin"]},
		"user:lena": {"org:lonestar": ["org_admin"]},
		"user:quinn": {"__tenant:acme": ["operator"]},
		"user:riley": {"__tenant:lonestar": ["viewer"]},
		# Roles the owner (acme) granted: they reach asset:op through relationships, whatever tenant.
		"user:ivy": {"site:s1": ["technician"]},
		"user:jordan": {"site:s1": ["technician"], "site:ls1": ["technician"]},
	},
	"users": {
		"tom": {"attributes": {"certifications": ["tier1", "tier3"]}},
		"ivy": {"attributes": {"certifications": ["tier1"]}},
		"jordan": {"attributes": {"certifications": ["tier1", "tier3"]}},
		"dan": {"attributes": {"certifications": []}},
		"pat": {"attributes": {"certifications": ["tier1"], "breakglass": [
			{"tenant": "acme", "incident_id": "INC-1", "expires_at": 4102444800},
			{"tenant": "lonestar", "incident_id": "INC-old", "expires_at": 1000}]}},
	},
}

req(user, action, typ, key, tenant) := {"user": {"key": user}, "action": action, "resource": {"type": typ, "key": key, "tenant": tenant}}

# root.rego's two allow rules as `make apply-policy` installs them (policy.RootAllow), with the
# generated policy's verdict passed in. A role held through relationships makes the generated policy
# allow whatever tenant the check passes, so the custom constraints have to stop it.
root_allow(generated) {
	generated
	acting_org_ok
	fleet_rules_ok
}

root_allow(_) {
	extra_allow
	acting_org_ok
	fleet_rules_ok
}

# Tenant isolation
test_same_org_ok { acting_org_ok with input as req("tom", "view", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances }
test_mismatch { not acting_org_ok with input as req("tom", "view", "asset", "a1", "lonestar") with data.resource_instances as mock.resource_instances }
test_mismatch_code { acting_org_code == "acting_org_mismatch" with input as req("tom", "view", "asset", "a1", "lonestar") with data.resource_instances as mock.resource_instances }
test_site_mismatch { not acting_org_ok with input as req("tom", "assign_roles", "site", "s1", "lonestar") with data.resource_instances as mock.resource_instances }
test_unknown_resource_fails_closed { not acting_org_ok with input as req("ava", "view", "asset", "gone", "lonestar") with data.resource_instances as mock.resource_instances }
test_unknown_resource_code { acting_org_code == "unknown_resource" with input as req("ava", "view", "asset", "gone", "lonestar") with data.resource_instances as mock.resource_instances }
test_type_level_ok { acting_org_ok with input as {"user": {"key": "ava"}, "action": "view", "resource": {"type": "asset", "tenant": "acme"}} with data.resource_instances as mock.resource_instances }

# Scenario 7: owner vs operator
test_operator_access_view { acting_org_ok with input as req("lena", "view", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_operator_code { acting_org_code == "operator_org" with input as req("lena", "operate", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_operator_no_ownership { not acting_org_ok with input as req("lena", "decommission", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances }
test_operator_grant_admin { operator_org_allow with input as req("lena", "operate", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_operator_grant_viewer_no_operate { not operator_org_allow with input as req("riley", "operate", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_operator_grant_viewer_view { operator_org_allow with input as req("riley", "view", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_owner_cannot_operate { not fleet_rules_ok with input as req("quinn", "operate", "asset", "op", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_owner_can_view { fleet_rules_ok with input as req("quinn", "view", "asset", "op", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_owner_can_decommission { fleet_rules_ok with input as req("olivia", "decommission", "asset", "op", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_granted_by { granted_by == "operator_org" with input as req("lena", "operate", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }

# Scenario 7, acting for the operator with a role the owner granted: the owner's technician (ivy), or
# a contractor with a site role in each organization (jordan), must not service the owner's truck by
# switching to the operating organization. The generated policy allows them there, so only the
# custom constraints can deny.
test_owner_granted_role_not_counted_for_operator { not root_allow(true) with input as req("ivy", "service_basic", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_owner_granted_role_view_not_counted_for_operator { not root_allow(true) with input as req("ivy", "view", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_owner_granted_role_code { acting_org_code == "acting_org_mismatch" with input as req("ivy", "service_basic", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_owner_granted_role_reason { contains(acting_org_reason, "but no role the user holds in 'lonestar' grants 'service_basic'") with input as req("ivy", "service_basic", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments }
test_site_role_elsewhere_not_counted_for_operator { not root_allow(true) with input as req("jordan", "service_advanced", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_operator_role_bounds_operator_access { not root_allow(true) with input as req("riley", "operate", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_operator_admin_operates { root_allow(false) with input as req("lena", "operate", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_operator_viewer_views { root_allow(false) with input as req("riley", "view", "asset", "op", "lonestar") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_owner_role_views_acting_for_owner { root_allow(true) with input as req("ivy", "view", "asset", "op", "acme") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_owner_role_no_service_acting_for_owner { not root_allow(true) with input as req("ivy", "service_basic", "asset", "op", "acme") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }

# Scenario 13: lifecycle state
test_decommissioned_view_ok { fleet_rules_ok with input as req("tom", "view", "asset", "dec", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_decommissioned_decommission_ok { fleet_rules_ok with input as req("olivia", "decommission", "asset", "dec", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_decommissioned_service_no { not fleet_rules_ok with input as req("tom", "service_basic", "asset", "dec", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_unassigned_platform { fleet_rules_ok with input as req("ava", "view", "asset", "un", "acme") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }
test_unassigned_tenant_admin { not fleet_rules_ok with input as req("olivia", "view", "asset", "un", "acme") with data.resource_instances as mock.resource_instances with data.role_assignments as mock.role_assignments with data.users as mock.users }

# Scenario 9: certifications
test_cert_basic_ok { fleet_rules_ok with input as req("ivy", "service_basic", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_cert_basic_missing { not fleet_rules_ok with input as req("dan", "service_basic", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_cert_advanced_missing { not fleet_rules_ok with input as req("ivy", "service_advanced", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_cert_advanced_ok { fleet_rules_ok with input as req("tom", "service_advanced", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }

# Scenario 14: time-boxed break-glass
test_breakglass_active { breakglass_allow with input as req("pat", "view", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_breakglass_expired { not breakglass_allow with input as req("pat", "view", "asset", "a1", "lonestar") with data.resource_instances as {"asset:a1": {"tenant": "lonestar", "attributes": {}}} with data.users as mock.users }
test_breakglass_no_operate { not breakglass_allow with input as req("pat", "operate", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
test_breakglass_assets_only { not breakglass_allow with input as req("pat", "view", "site", "s1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }

test_debug_shape { fleet_rules_debug.allow == false with input as req("dan", "service_basic", "asset", "a1", "acme") with data.resource_instances as mock.resource_instances with data.users as mock.users }
