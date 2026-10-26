# Firebase Functions

Functions in `us-central1` provide health checks, shared-password authentication, private voice tools, and admin call browsing/playback/reviews. Visitors require `appAccess: true`; admin operations additionally require `admin: true`.

The seven IAM-private voice tools retrieve configured appointments, floor plans, sales-director availability, community information, and contact information, and save confirmed contact details or pending follow-up requests. `getAvailableAppointments` accepts `POST {}` and returns configured future slots. The authenticated socket backend supplies visitor identity. No function contacts staff or reserves inventory.

## Develop and verify

Run from the repository root:

```sh
npm run dev
npx nx build functions
npx nx run functions:smoke
npx nx run-many -t typecheck,lint,test -p functions
```

Local passwords belong in gitignored `functions/.secret.local`; add `OPENAI_API_KEY` there for live admin reviews. See [local setup](../README.md#local-development). Automated tests use mocked review responses. Emulators do not enforce deployed IAM.

## Deploy

Configure the root `.env`, authenticate with Firebase, and provision [infrastructure](../terraform/README.md) first. Set secrets interactively:

```sh
npx firebase login
npx firebase functions:secrets:set APP_ACCESS_PASSWORD --project <project-id>
npx firebase functions:secrets:set ADMIN_ACCESS_PASSWORD --project <project-id>
npx firebase functions:secrets:set OPENAI_API_KEY --project <project-id>
npx nx run functions:deploy
# Rules and indexes only:
npx nx run functions:deploy-rules
```

Functions deployment includes Firestore rules/indexes and Storage rules. The default runtime requires Auth administration, token signing, Firestore access, and recording-object access, provisioned by Terraform. Custom runtime identities need equivalent permissions. Wait for required Firestore indexes before using call review.

Health and password endpoints must allow unauthenticated invocation; password handlers validate secrets. Voice tool services stay private and require the [socket runtime's service-level invocation grants](../apps/socket-server/README.md#private-firebase-tools).

See [Sophie behavior and prompt publication](../docs/sophie-agent.md).
