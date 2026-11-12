# Groups of trucks by attribute (scenario 11), and the org-level roles they're granted to.

resource "permitio_resource_set" "south_assets" {
  key      = "south_assets"
  name     = "Assets where region = South"
  resource = permitio_resource.asset.key
  conditions = jsonencode({
    allOf = [{ "resource.region" = { equals = "South" } }]
  })
}

resource "permitio_resource_set" "acct1_assets" {
  key      = "acct1_assets"
  name     = "Assets where served_account = Acct1"
  resource = permitio_resource.asset.key
  conditions = jsonencode({
    allOf = [{ "resource.served_account" = { equals = "Acct1" } }]
  })
}

# Permit makes a user set for each org-level role (`__autogen_<role>`): everyone holding it in the acting
# organization.

resource "permitio_condition_set_rule" "operator_views_south" {
  user_set     = "__autogen_operator"
  permission   = "asset:view"
  resource_set = permitio_resource_set.south_assets.key
  depends_on   = [permitio_role.operator]
}

resource "permitio_condition_set_rule" "operator_operates_south" {
  user_set     = "__autogen_operator"
  permission   = "asset:operate"
  resource_set = permitio_resource_set.south_assets.key
  depends_on   = [permitio_role.operator]
}

resource "permitio_condition_set_rule" "viewer_views_acct1" {
  user_set     = "__autogen_viewer"
  permission   = "asset:view"
  resource_set = permitio_resource_set.acct1_assets.key
  depends_on   = [permitio_role.viewer]
}
