# Living Community Assistant

Sophie is a senior-living voice sales demo built with React, Socket.IO, OpenAI, and Firebase in an Nx workspace. Visitors can talk with Sophie; admins manage instructions and appointment availability, browse saved calls, and request transcript reviews.

## Local development

Use Node from `.nvmrc`, npm, and Java 21+ for the Firebase emulators.

```sh
nvm use
npm ci
cp apps/socket-server/.env.example apps/socket-server/.env
```

Set `OPENAI_API_KEY` in `apps/socket-server/.env` for live voice. Create the gitignored `functions/.secret.local`:

```dotenv
APP_ACCESS_PASSWORD=choose-a-local-password
ADMIN_ACCESS_PASSWORD=choose-an-admin-password
```

Add `OPENAI_API_KEY` there too if you want local AI call reviews. Keep keys and passwords out of browser configuration.

```sh
npm run dev
```

Open http://localhost:4200; use `/admin` for configuration and `/admin/review` for saved calls. The launcher starts the frontend, socket server, and Firebase emulators with the committed demo configuration. No cloud project is required. It seeds the local prompt and preserves emulator data in gitignored `firebase-emulator-data/`; stop with Ctrl-C and wait for export to finish. Appointment settings are also backed up as they change to gitignored `firebase-local-config/appointments.json`. On startup, the launcher restores that backup if the imported appointment document is missing or older, preserving slots, revision, editor, and timestamp. An explicit empty schedule (`[]`) is preserved too. No appointment slots are invented on first launch.

The appointment backup works independently of shutdown exports. Restart the dev launcher once after updating these scripts to enable continuous backups. To intentionally reset local appointment configuration, stop development, remove `firebase-local-config/appointments.json`, and clear the appointment document from the imported emulator data; saving `[]` through Admin is the normal way to mark no availability. Other emulator data still relies on a clean shutdown/export.

Verify restart persistence with `node tools/test-emulator-persistence.mjs`; it uses a separate demo project and free ports, including a restart from an intentionally outdated export.

## Common commands

```sh
npm run build
npx nx run-many -t typecheck,lint,test -p living-community-assistant,socket-server,functions,shared-types
npm run test:deployment
npx nx run functions:smoke
npx playwright install chromium
npx playwright test -c apps/living-community-assistant-e2e/playwright.config.mts --project=chromium
```

Automated voice tests use a fake provider and need no OpenAI key. Browser and smoke tests use isolated emulators.

## Production setup

1. Copy `.env.example` to `.env` and set `GCP_PROJECT_ID` and the settings for your existing billing-enabled project. Provision infrastructure using the [Terraform guide](terraform/README.md).
2. Copy `apps/living-community-assistant/src/environments/environment.example.ts` to `environment.prod.ts` in the same directory. Set the project's Firebase Web SDK values, the recordings bucket, and deployed `socketUrl`.
3. Configure Firebase secrets and deploy the [Functions](functions/README.md). Disable anonymous sign-in; visitors use the shared password exchange.
4. Initialize the prompt, then deploy the [socket server](apps/socket-server/README.md) with its runtime identity, private-function invocation grants, server OpenAI key, and frontend origins.
5. Deploy the frontend. Set appointment slots through `/admin`; tour and callback writes are pending requests, not reservations or staff notifications.

```sh
node tools/seed-sophie-prompt.mjs --project <project-id>
npx nx run living-community-assistant:deploy
```

Production services use the same Firebase project. Remove emulator host variables in production. Calls and recordings are private; admin reviews require admin access.

## Workspace

- `apps/living-community-assistant`: frontend and admin pages.
- `apps/socket-server`: authenticated voice sessions and call persistence.
- `functions`: password exchange, community tools, and admin call review.
- `libs/shared/types`: shared contracts; `tools` and `terraform`: development and deployment helpers.

See [Sophie behavior and prompt publication](docs/sophie-agent.md) for the current conversation rules.

### Voice injection checks

Production socket-server calls check each nonempty final user transcription with OpenAI Decisions (`gpt-6-luna`) using `OPENAI_API_KEY`; the API project must have access to this model. Set `INJECTION_THRESHOLD` (0–1, default `0.8`) and `DECISIONS_TIMEOUT_MS` (1–30000, default `2000`). Each check includes at most six preceding user and assistant utterances, with preceding context limited to 12,000 characters. The current utterance is preserved in full.

A detected instruction attack immediately stops capture and playback and saves the call with `prompt_injection`. Decisions errors, timeouts (including queue time), and transcription failures stop it with `guardrail_unavailable`. The UI retains a warning until the next call. The socket remains connected. Checks are asynchronous: the voice assistant can respond or execute tools before the final transcript verdict. The threshold is an initial default that should be calibrated on labeled English/Spanish examples. Monitor `guardrail.verdict` latency/probability and `guardrail.failed` categories without transcript logging. Deploy the server and UI together.

### Automatic manager handoff

The same Decisions request also checks `user_frustrated` and selects English or Spanish. Set `FRUSTRATION_THRESHOLD` (0–1, default `0.8`) to tune the trigger. Clear frustration, repeated dissatisfaction, and explicit manager requests trigger a simulated transfer; mild confusion, quotations, and unrelated distress should not. Recent finalized user and assistant utterances supply context (at most six preceding utterances and 12,000 characters total). Prompt injection takes priority.

On escalation, the server stops microphone input, interrupts the current reply, aborts pending tools, and plays a fixed English/Spanish disclosure that the manager transfer is simulated. It saves the call as `demo_manager_handoff` after playback, or after a 15-second fallback timeout. A visitor end request stops playback immediately; an injection verdict can override the handoff. This does not connect to a real manager and does not change the Firebase prompt. Deploy server and UI together.

Calibrate with the synthetic labeled English/Spanish cases before rollout. This command explicitly calls the live Decisions API using the socket-server environment file (or an exported `OPENAI_API_KEY`):

```sh
node --env-file-if-exists=apps/socket-server/.env apps/socket-server/src/testing/evaluate-frustration.ts
```

The evaluator reports per-case probabilities, language, and pass/fail without printing transcript text or credentials. These examples are an initial regression set, not a guarantee of classification accuracy. Normal unit/integration tests use deterministic fake verdicts and never call OpenAI.

### Large recordings in admin review

Local admin review downloads recordings directly from the Storage emulator using the signed-in admin's Firebase credentials, then plays a browser Blob URL. This supports WAV recordings up to 200 MiB instead of embedding audio in the Functions JSON response. The full recording downloads before playback starts; Blob URLs are released on refresh, navigation, and deletion. Production continues to use expiring signed URLs.

Run the updated frontend and Functions together and restart local emulators to load the updated Storage rules. Admins can read call recordings; client uploads, deletion, and listing remain denied. Existing recordings need no migration.
