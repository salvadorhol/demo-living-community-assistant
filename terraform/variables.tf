variable "project_id" {
  description = "Existing billing-enabled GCP project ID; supplied by deploy.sh from root .env."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a valid 6–30 character GCP project ID."
  }
}

variable "hosting_site_id" {
  description = "Hosting site ID; deploy.sh defaults this to the project ID."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$", var.hosting_site_id))
    error_message = "Use a valid 4–30 character Hosting site ID."
  }
}

variable "firestore_location_id" {
  description = "Location of the existing or new default Firestore database."
  type        = string
  default     = "us-central1"
}

variable "hosting_app_id" {
  description = "Existing Firebase web app associated with the Hosting site, when present."
  type        = string
  default     = null
}
