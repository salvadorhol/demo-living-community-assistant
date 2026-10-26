import { initializeApp, deleteApp } from 'firebase-admin/app';
import { publishReviewedPrompt } from '../apps/socket-server/src/ai/publish-prompt.ts';
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--project' ||
  args[2] !== '--expected-revision' ||
  !/^[a-z][a-z0-9-]+$/.test(args[1]) ||
  !/^[1-9]\d*$/.test(args[3])
)
  throw new Error(
    'Usage: node tools/publish-sophie-prompt.mjs --project <project-id> --expected-revision <current-revision>',
  );
const projectId = args[1];
if (projectId.startsWith('demo-') && !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Set FIRESTORE_EMULATOR_HOST for an explicit demo project.');
const app = initializeApp({ projectId });
try {
  const revision = await publishReviewedPrompt(app, Number(args[3]));
  console.log(
    `Reviewed Sophie prompt is current at revision ${revision}. Start a new call to use it.`,
  );
} finally {
  await deleteApp(app);
}
