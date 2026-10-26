import { pathToFileURL } from 'node:url';
import { seedSophiePrompt } from '../apps/socket-server/src/ai/seed-prompt.ts';
export { seedSophiePrompt };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--project')
    throw new Error(
      'Usage: node tools/seed-sophie-prompt.mjs --project <project-id>',
    );
  await seedSophiePrompt({ projectId: args[1] });
}
