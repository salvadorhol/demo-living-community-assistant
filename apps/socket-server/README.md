# Socket server

Express and Socket.IO backend for authenticated voice conversations. It verifies Firebase tokens with `appAccess: true`, connects to OpenAI for voice and captions, and saves call transcripts and recordings to Firebase. Each socket has its own conversation.

## Run and verify

From the repository root:

```sh
npm run dev
# Standalone server; requires Firebase services and configuration:
npm run dev:socket
npx nx build socket-server
npx nx start socket-server
npx nx run-many -t typecheck,lint,test -p socket-server
```

The default listener is http://127.0.0.1:3000; `/health` is public. Copy `.env.example` from this directory to `.env` and set the server-only `OPENAI_API_KEY`. The root development launcher supplies emulator routing automatically.

## Configuration

| Setting                     | Purpose                                           |
| --------------------------- | ------------------------------------------------- |
| `HOST`, `PORT`              | HTTP and Socket.IO listener                       |
| `CORS_ORIGINS`              | Allowed browser origins, comma-separated          |
| `FIREBASE_PROJECT_ID`       | Same project as the frontend and Functions        |
| `FIREBASE_STORAGE_BUCKET`   | Private recordings bucket from Terraform          |
| `FIREBASE_FUNCTIONS_REGION` | Tool region; default `us-central1`                |
| `OPENAI_API_KEY`            | Live voice and transcription credentials          |
| `MAX_CALL_MS`               | Call duration limit; default and maximum one hour |

For production, remove all emulator host variables, provide Application Default Credentials through the runtime service account, and set `NODE_ENV=production`. Terraform can grant the socket identity Firestore and recording-object access via `SOCKET_SERVICE_ACCOUNT`.

Build with `npx nx build socket-server`, or deploy the repository's Dockerfile to your container host. Run one process/instance because room state is in memory; configure WebSocket support and a request timeout suitable for calls. The server must be able to read the initialized Sophie prompt before accepting new calls.

## Private Firebase tools

Seven IAM-private HTTP functions provide appointments, floor plans, sales-director availability, community facts, contact reads/writes, and pending follow-up requests. The backend supplies authenticated identity; model arguments never choose a UID or endpoint.

After deploying Functions, grant the socket runtime `roles/run.invoker` on each underlying service: `getAvailableAppointments`, `getAvailableFloorPlans`, `checkSalesDirectorAvailability`, `getCommunityInformation`, `getContactInformation`, `saveContactInformation`, and `createFollowUpRequest`.

```sh
gcloud functions describe FUNCTION_NAME --gen2 --region=us-central1 \
  --project=PROJECT_ID --format='value(serviceConfig.service)'
gcloud run services add-iam-policy-binding SERVICE_NAME \
  --project=PROJECT_ID --region=us-central1 \
  --member=serviceAccount:SOCKET_SERVICE_ACCOUNT_EMAIL --role=roles/run.invoker
```

Use the final service name from the first command's output. Recheck grants after deployment. Local emulators bypass IAM; they cannot verify production invocation permissions.

## Code overview

`src/main.ts` composes the server; `src/config.ts` validates settings. `src/conversation/` owns lifecycle, `src/ai/` owns providers and tools, and `src/calls/` owns persistence. Model and voice settings live in `src/ai/assistant-profile.ts`; runtime instructions come from Firestore.

See the [root setup guide](../../README.md) and [Sophie behavior](../../docs/sophie-agent.md).
