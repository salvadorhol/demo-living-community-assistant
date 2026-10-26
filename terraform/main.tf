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
    "iamcredentials.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
    "firebasestorage.googleapis.com",
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
  delete_protection_state = var.firestore_delete_protection_state
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.deployment]
}

data "google_project" "runtime" {
  provider   = google-beta
  project_id = var.project_id
  depends_on = [google_project_service.bootstrap]
}

resource "google_project_iam_member" "functions_firestore_user" {
  count      = var.functions_firestore_access ? 1 : 0
  provider   = google-beta
  project    = var.project_id
  role       = "roles/datastore.user"
  member     = "serviceAccount:${data.google_project.runtime.number}-compute@developer.gserviceaccount.com"
  depends_on = [google_project_service.deployment]
}

moved {
  from = google_project_iam_member.functions_firestore_user
  to   = google_project_iam_member.functions_firestore_user[0]
}


resource "google_storage_bucket" "recordings" {
  provider                    = google-beta
  project                     = var.project_id
  name                        = "${var.project_id}-call-recordings"
  location                    = var.recordings_location_id
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.deployment]
}

resource "google_firebase_storage_bucket" "recordings" {
  provider  = google-beta
  project   = var.project_id
  bucket_id = google_storage_bucket.recordings.name
}

# Set to the separately deployed socket server's service account to grant only
# database and recording-object access. Never grant public bucket access.
resource "google_storage_bucket_iam_member" "socket_recordings" {
  provider = google-beta
  count    = var.socket_service_account == null ? 0 : 1
  bucket   = google_storage_bucket.recordings.name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${var.socket_service_account}"
}

resource "google_project_iam_member" "socket_firestore" {
  provider = google-beta
  count    = var.socket_service_account == null ? 0 : 1
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${var.socket_service_account}"
}

# The password exchange creates visitor identities and signs custom tokens using
# the default 2nd-gen Functions runtime account, without service-account keys.
resource "google_project_iam_member" "functions_auth_admin" {
  provider   = google-beta
  project    = var.project_id
  role       = "roles/firebaseauth.admin"
  member     = "serviceAccount:${data.google_project.runtime.number}-compute@developer.gserviceaccount.com"
  depends_on = [google_project_service.deployment]
}

resource "google_service_account_iam_member" "functions_token_signer" {
  provider           = google-beta
  service_account_id = "projects/${var.project_id}/serviceAccounts/${data.google_project.runtime.number}-compute@developer.gserviceaccount.com"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${data.google_project.runtime.number}-compute@developer.gserviceaccount.com"
  depends_on         = [google_project_service.deployment]
}
