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

Open http://localhost:4200; use `/admin` for configuration and `/admin/review` for saved calls. The launcher starts the frontend, socket server, and Firebase emulators with the committed demo configuration. No cloud project is required. It seeds the local prompt and preserves emulator data in gitignored `firebase-emulator-data/`; stop with Ctrl-C and wait for export to finish.

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
