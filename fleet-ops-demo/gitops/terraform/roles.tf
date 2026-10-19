# Roles and what each one may do. A role on a site also exists on the site's trucks, derived from it
# (derivations.tf), so each truck role lists the actions it gives on the truck.

resource "permitio_role" "org_admin" {
  key         = "org_admin"
  name        = "Org admin"
  resource    = permitio_resource.org.key
  permissions = ["manage_users", "assign_roles"]
}

resource "permitio_role" "region_manager" {
  key         = "region_manager"
  name        = "Region manager"
  resource    = permitio_resource.region.key
  permissions = ["view", "assign_roles"]
}

resource "permitio_role" "site_manager" {
  key         = "site_manager"
  name        = "Site manager"
  resource    = permitio_resource.site.key
  permissions = ["view", "assign_roles"]
}

resource "permitio_role" "site_operator" {
  key         = "operator"
  name        = "Operator"
  resource    = permitio_resource.site.key
  permissions = ["view"]
}

resource "permitio_role" "site_technician" {
  key         = "technician"
  name        = "Technician"
  resource    = permitio_resource.site.key
  permissions = ["view"]
}

resource "permitio_role" "site_viewer" {
  key         = "viewer"
  name        = "Viewer"
  resource    = permitio_resource.site.key
  permissions = ["view"]
}

# Trucks

resource "permitio_role" "asset_site_manager" {
  key         = "site_manager"
  name        = "Site manager"
  resource    = permitio_resource.asset.key
  permissions = ["view", "decommission"]
}

resource "permitio_role" "asset_operator" {
  key         = "operator"
  name        = "Operator"
  resource    = permitio_resource.asset.key
  permissions = ["view", "operate"]
}

resource "permitio_role" "asset_technician" {
  key      = "technician"
  name     = "Technician"
  resource = permitio_resource.asset.key
  permissions = [
    "view",
    "service_basic",
    "service_advanced",
  ]
}

resource "permitio_role" "asset_viewer" {
  key         = "viewer"
  name        = "Viewer"
  resource    = permitio_resource.asset.key
  permissions = ["view"]
}

# A technician from another company, given on named trucks only: never derived.
resource "permitio_role" "asset_partner_technician" {
  key         = "partner_technician"
  name        = "Partner technician"
  resource    = permitio_resource.asset.key
  permissions = ["view", "service_basic", "service_advanced"]
}

resource "permitio_role" "team_supervisor" {
  key         = "team_supervisor"
  name        = "Team supervisor"
  resource    = permitio_resource.team.key
  permissions = ["view_activity"]
}

# Org-level roles: no permissions of their own. The rules in attribute_groups.tf give them sets of trucks.

resource "permitio_role" "operator" {
  key         = "operator"
  name        = "Operator (org-level)"
  description = "Views and operates the organization's assets in region South"
}

resource "permitio_role" "viewer" {
  key         = "viewer"
  name        = "Viewer (org-level)"
  description = "Views the organization's assets that serve account Acct1"
}
