resource "google_project_service" "bootstrap" {
  provider = google-beta.bootstrap
  project  = var.project_id
  for_each = toset([
    "serviceusage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firebase.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_firebase_project" "default" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.bootstrap]
}

resource "google_project_service" "deployment" {
  provider = google-beta
  project  = var.project_id
  for_each = toset([
    "firebasehosting.googleapis.com",
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "logging.googleapis.com",
    "iam.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
  depends_on         = [google_firebase_project.default]
}

resource "google_firebase_hosting_site" "app" {
  provider   = google-beta
  project    = var.project_id
  site_id    = var.hosting_site_id
  app_id     = var.hosting_app_id
  depends_on = [google_project_service.deployment]
}

resource "google_firestore_database" "default" {
  provider                = google-beta
  project                 = var.project_id
  name                    = "(default)"
  location_id             = var.firestore_location_id
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.deployment]
}

data "google_project" "runtime" {
  provider   = google-beta
  project_id = var.project_id
  depends_on = [google_project_service.bootstrap]
}

resource "google_project_iam_member" "functions_firestore_user" {
  provider   = google-beta
  project    = var.project_id
  role       = "roles/datastore.user"
  member     = "serviceAccount:${data.google_project.runtime.number}-compute@developer.gserviceaccount.com"
  depends_on = [google_project_service.deployment]
}

