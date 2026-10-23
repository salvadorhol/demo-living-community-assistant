output "project_id" {
  value = var.project_id
}

output "hosting_site_id" {
  value = google_firebase_hosting_site.app.site_id
}

output "hosting_url" {
  value = google_firebase_hosting_site.app.default_url
}

output "health_url" {
  description = "Available after nx run functions:deploy succeeds."
  value       = "https://us-central1-${var.project_id}.cloudfunctions.net/health"
}
