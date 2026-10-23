terraform {
  required_version = ">= 1.5, < 2.0"
  required_providers {
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.0"
    }
  }
}

# ADC: gcloud auth application-default login
provider "google-beta" {
  project               = var.project_id
  region                = "us-central1"
  user_project_override = true
}

provider "google-beta" {
  alias                 = "bootstrap"
  project               = var.project_id
  user_project_override = false
}
