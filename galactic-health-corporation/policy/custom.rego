package permit.custom

import data.permit.policies
import data.permit.rebac
import data.permit.utils.abac
import future.keywords.in

default allow := false

# Applies the caregiver date bounds (ABAC) on top of the ReBAC decision. Permit's root policy
# allows a request only when both `policies.allow` and this `allow` hold (see the README).
allow {
	# Decisions that ReBAC did not allow are left to the other policies.
	not "rebac" in policies.__allow_sources
} else {
	# ReBAC decisions that no caregiver role took part in.
	count(caregiver_resources) == 0
} else {
	# A caregiver role allowed it: now must be within the caregiver's bounds for that resource.
	some resource in caregiver_resources
	within_bounds(resource)
}

# The resource instances whose caregiver role, assigned or derived, allowed this decision. Profile
# roles are left out: group members read profiles without date bounds.
caregiver_resources[resource] {
	some allowing_role in rebac.rebac_roles_debugger
	some source in allowing_role.sources
	resource := caregiver_resource(allowing_role, source)
}

caregiver_resource(allowing_role, source) := resource {
	# The caregiver role was assigned on the instance itself.
	source.type == "role_assignment"
	endswith(allowing_role.role, "#caregiver")
	not startswith(allowing_role.role, "profile")
	resource := allowing_role.resource
} else := resource {
	# The caregiver role was derived from a parent instance (a caregiver of the member record).
	source.type == "role_derivation"
	endswith(source.role, "#caregiver")
	not startswith(allowing_role.role, "profile")
	resource := source.resource
}

# Whether now is within the `caregiver_bounds` the app stored on the user for this resource.
within_bounds(resource) {
	bounds := abac.attributes.user.caregiver_bounds[resource]
	time.now_ns() >= time.parse_rfc3339_ns(bounds.start_date)
	time.now_ns() <= time.parse_rfc3339_ns(bounds.end_date)
}
