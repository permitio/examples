# Resource types: the organization hierarchy and the trucks.

resource "permitio_resource" "org" {
  key  = "org"
  name = "Organization"
  actions = {
    "manage_users" = { name = "Manage users" }
    "assign_roles" = { name = "Assign roles" }
  }
}

resource "permitio_resource" "region" {
  key  = "region"
  name = "Region"
  actions = {
    "view"         = { name = "View" }
    "assign_roles" = { name = "Assign roles" }
  }
}

resource "permitio_resource" "site" {
  key  = "site"
  name = "Site"
  actions = {
    "view"         = { name = "View" }
    "assign_roles" = { name = "Assign roles" }
  }
}

resource "permitio_resource" "asset" {
  key  = "asset"
  name = "Asset (truck)"
  actions = {
    "view"             = { name = "View" }
    "operate"          = { name = "Operate" }
    "service_basic"    = { name = "Service basic" }
    "service_advanced" = { name = "Service advanced" }
    "decommission"     = { name = "Decommission" }
  }
  attributes = {
    "region"          = { type = "string", description = "Operating region (South, West, East)" }
    "served_account"  = { type = "string", description = "Shipper account the truck serves" }
    "lifecycle_state" = { type = "string", description = "unassigned, active, transferring, decommissioned" }
    "owner_org"       = { type = "string", description = "Organization that owns the truck" }
    "operator_org"    = { type = "string", description = "Organization that operates the truck" }
  }
}

resource "permitio_resource" "team" {
  key  = "team"
  name = "Team"
  actions = {
    "view_activity" = { name = "View activity" }
  }
}

# Each type hangs under its parent through a `parent` relation; roles derive along it.

resource "permitio_relation" "org_parent" {
  key              = "parent"
  name             = "Parent"
  subject_resource = permitio_resource.org.key
  object_resource  = permitio_resource.org.key
}

resource "permitio_relation" "region_parent" {
  key              = "parent"
  name             = "Parent"
  subject_resource = permitio_resource.org.key
  object_resource  = permitio_resource.region.key
}

resource "permitio_relation" "site_parent" {
  key              = "parent"
  name             = "Parent"
  subject_resource = permitio_resource.region.key
  object_resource  = permitio_resource.site.key
}

resource "permitio_relation" "asset_parent" {
  key              = "parent"
  name             = "Parent"
  subject_resource = permitio_resource.site.key
  object_resource  = permitio_resource.asset.key
}

resource "permitio_relation" "team_parent" {
  key              = "parent"
  name             = "Parent"
  subject_resource = permitio_resource.site.key
  object_resource  = permitio_resource.team.key
}

# Who the person is: certifications, employer, and time-boxed break-glass grants.

resource "permitio_user_attribute" "certifications" {
  key         = "certifications"
  type        = "array"
  description = "Service certifications held: tier1, tier2, tier3"
}

resource "permitio_user_attribute" "home_tenant" {
  key         = "home_tenant"
  type        = "string"
  description = "Organization that employs the user"
}

resource "permitio_user_attribute" "breakglass" {
  key         = "breakglass"
  type        = "json"
  description = "Time-boxed grants: tenant, incident_id, expires_at"
}
