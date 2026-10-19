# State in HCP Terraform, one workspace per environment. The organization and the workspace come from
# TF_CLOUD_ORGANIZATION and TF_WORKSPACE, which the workflow sets. Delete this file to keep the state in a
# local file instead, for example to try the schema against one environment from your machine.
terraform {
  cloud {}
}
