package permit.custom_test

import data.permit.custom

# Morty is a caregiver of Rick's member record; the role reaches the health plan by derivation.
derived_from_member := [{
	"role": "health_plan#caregiver",
	"resource": "health_plan:health_plan_rick",
	"sources": [{"type": "role_derivation", "role": "member#caregiver", "resource": "member:member_rick"}],
}]

# Morty is a caregiver of Rick's health plan itself.
assigned_on_plan := [{
	"role": "health_plan#caregiver",
	"resource": "health_plan:health_plan_rick",
	"sources": [{"type": "role_assignment"}],
}]

# Morty reads Rick's profile as a member of the same group.
group_profile := [{
	"role": "profile#caregiver",
	"resource": "profile:profile_rick",
	"sources": [{"type": "role_derivation", "role": "member_group#org_member", "resource": "member_group:family"}],
}]

june := time.parse_rfc3339_ns("2026-06-01T00:00:00Z")

year := {"start_date": "2026-01-01T00:00:00Z", "end_date": "2026-12-31T00:00:00Z"}

bounds(resource) := {"user": {"caregiver_bounds": {resource: year}}}

test_other_decisions_pass {
	custom.allow with data.permit.policies.__allow_sources as ["rbac"]
}

test_rebac_without_caregiver_passes {
	custom.allow with data.permit.policies.__allow_sources as ["rebac"]
		with data.permit.rebac.rebac_roles_debugger as [{"role": "member#owner", "resource": "member:member_rick", "sources": [{"type": "role_assignment"}]}]
}

test_group_member_reads_profile_without_bounds {
	custom.allow with data.permit.policies.__allow_sources as ["rebac"]
		with data.permit.rebac.rebac_roles_debugger as group_profile
}

test_derived_caregiver_within_bounds {
	custom.allow with data.permit.policies.__allow_sources as ["rebac"]
		with data.permit.rebac.rebac_roles_debugger as derived_from_member
		with data.permit.utils.abac.attributes as bounds("member:member_rick")
		with time.now_ns as june
}

test_assigned_caregiver_within_bounds {
	custom.allow with data.permit.policies.__allow_sources as ["rebac"]
		with data.permit.rebac.rebac_roles_debugger as assigned_on_plan
		with data.permit.utils.abac.attributes as bounds("health_plan:health_plan_rick")
		with time.now_ns as june
}

test_caregiver_after_bounds_is_denied {
	not custom.allow with data.permit.policies.__allow_sources as ["rebac"]
		with data.permit.rebac.rebac_roles_debugger as derived_from_member
		with data.permit.utils.abac.attributes as bounds("member:member_rick")
		with time.now_ns as time.parse_rfc3339_ns("2027-02-01T00:00:00Z")
}

test_caregiver_without_bounds_is_denied {
	not custom.allow with data.permit.policies.__allow_sources as ["rebac"]
		with data.permit.rebac.rebac_roles_debugger as derived_from_member
		with data.permit.utils.abac.attributes as {"user": {}}
		with time.now_ns as june
}
