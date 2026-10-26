# Firebase infrastructure

Terraform configures an existing billing-enabled GCP project: required APIs, Firebase, Hosting metadata, Firestore, a private recordings bucket, and runtime IAM permissions. Application code, container services, secrets, and private-function invocation grants are deployed separately.

## Configure and provision

Install Terraform and the Google Cloud CLI. From the repository root, copy `.env.example` to `.env` and set `GCP_PROJECT_ID`. Match an existing database's immutable `FIRESTORE_LOCATION_ID`, protection setting, and Hosting app association before applying.

```sh
gcloud auth application-default login
./terraform/deploy.sh init
./terraform/deploy.sh validate
./terraform/deploy.sh plan
./terraform/deploy.sh apply
./terraform/deploy.sh output
```

The wrapper reads root `.env`; shell settings override it. `plan`, `apply`, `output`, and `import` select a workspace named after the project. Apply retains Terraform's confirmation prompt.

| Setting                             | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `FIREBASE_HOSTING_SITE_ID`          | Hosting site; defaults to project ID           |
| `FIREBASE_HOSTING_APP_ID`           | Preserve an existing linked Web app            |
| `FIRESTORE_LOCATION_ID`             | Database location; default `us-central1`       |
| `RECORDINGS_LOCATION_ID`            | Bucket location; default `us-central1`         |
| `FIRESTORE_DELETE_PROTECTION_STATE` | Match existing protection; default enabled     |
| `FUNCTIONS_FIRESTORE_ACCESS`        | Runtime database access; default `true`        |
| `SOCKET_SERVICE_ACCOUNT`            | Socket identity for database and bucket grants |

Use `recordings_bucket` output for backend and frontend bucket configuration. Functions IAM targets the default second-generation runtime account; custom identities require equivalent grants.

## Existing resources and state

Import existing resources before applying, then inspect a refreshed plan:

```sh
./terraform/deploy.sh import RESOURCE_ADDRESS RESOURCE_ID
./terraform/deploy.sh plan
```

State is local and gitignored at `terraform/terraform.tfstate.d/PROJECT_ID/terraform.tfstate`. Preserve backups; a clean clone has no infrastructure state. Use a shared backend before multiple people manage infrastructure, and do not run state operations concurrently. Commit `.terraform.lock.hcl`.

Firestore uses the `ABANDON` deletion policy; the recordings bucket disallows forced deletion. Review plans before accepting changes. See [application deployment](../README.md#production-setup).
