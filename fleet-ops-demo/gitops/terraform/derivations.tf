# How roles travel down the `parent` links: one role assignment high in the tree reaches everything below it.

locals {
  derivations = {
    # An org admin is also org admin of every sub-organization, and region manager of its regions.
    org_admin_suborg = { resource = "org", to_role = "org_admin", on_resource = "org", role = "org_admin" }
    region_manager   = { resource = "region", to_role = "region_manager", on_resource = "org", role = "org_admin" }
    # A region manager is site manager of the region's sites.
    site_manager = { resource = "site", to_role = "site_manager", on_resource = "region", role = "region_manager" }
    # Each site role carries down to the site's trucks.
    asset_site_manager = { resource = "asset", to_role = "site_manager", on_resource = "site", role = "site_manager" }
    asset_operator     = { resource = "asset", to_role = "operator", on_resource = "site", role = "operator" }
    asset_technician   = { resource = "asset", to_role = "technician", on_resource = "site", role = "technician" }
    asset_viewer       = { resource = "asset", to_role = "viewer", on_resource = "site", role = "viewer" }
  }
}

resource "permitio_role_derivation" "derived" {
  for_each    = local.derivations
  resource    = each.value.resource
  to_role     = each.value.to_role
  on_resource = each.value.on_resource
  role        = each.value.role
  linked_by   = "parent"

  depends_on = [
    permitio_role.org_admin, permitio_role.region_manager, permitio_role.site_manager,
    permitio_role.site_operator, permitio_role.site_technician, permitio_role.site_viewer,
    permitio_role.asset_site_manager, permitio_role.asset_operator, permitio_role.asset_technician,
    permitio_role.asset_viewer,
    permitio_relation.org_parent, permitio_relation.region_parent, permitio_relation.site_parent,
    permitio_relation.asset_parent,
  ]
}
