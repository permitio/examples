# The Fleet Ops schema as Terraform: the same resource types, roles, relations, derivations and
# attribute rules that `make setup` writes through the API (internal/schema/schema.go). State is local
# unless cloud.tf is present; in CI it lives in HCP Terraform, one workspace per environment.

terraform {
  required_version = ">= 1.5"

  required_providers {
    permitio = {
      source  = "permitio/permit-io"
      version = "0.0.26"
    }
  }
}

variable "permit_api_key" {
  description = "The API key of the environment to apply to."
  type        = string
  sensitive   = true
}

variable "permit_api_url" {
  description = "Permit's API."
  type        = string
  default     = "https://api.permit.io"
}

provider "permitio" {
  api_url = var.permit_api_url
  api_key = var.permit_api_key
}
