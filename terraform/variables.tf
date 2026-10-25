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

variable "recordings_location_id" {
  description = "Recordings bucket location, independent of the Firestore database location."
  type        = string
  default     = "us-central1"
}

variable "firestore_delete_protection_state" {
  description = "Match the existing database protection setting when importing."
  type        = string
  default     = "DELETE_PROTECTION_ENABLED"
  validation {
    condition     = contains(["DELETE_PROTECTION_ENABLED", "DELETE_PROTECTION_DISABLED"], var.firestore_delete_protection_state)
    error_message = "Use DELETE_PROTECTION_ENABLED or DELETE_PROTECTION_DISABLED."
  }
}

variable "functions_firestore_access" {
  description = "Grant the default Functions runtime Firestore access only when its functions require it."
  type        = bool
  default     = true
}

variable "socket_service_account" {
  description = "Optional service account email for the standalone socket server."
  type        = string
  default     = null
}
