import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { loadConfig, workspaceRoot } from './config.mjs';
import { run } from './process.mjs';

export async function terraform(
  command,
  args = [],
  { root = workspaceRoot, execute = run, config = loadConfig } = {},
) {
  if (!['init', 'validate', 'plan', 'apply', 'output'].includes(command)) {
    throw new Error(
      'Usage: terraform/deploy.sh <init|validate|plan|apply|output> [terraform arguments]',
    );
  }
  const directory = resolve(root, 'terraform');
  const env = { ...process.env };
  const rootEnvPath = resolve(root, '.env');
  const localEnv = existsSync(rootEnvPath)
    ? parseEnv(readFileSync(rootEnvPath, 'utf8'))
    : {};
  const invoke = (operation, extra = []) =>
    execute('terraform', [`-chdir=${directory}`, operation, ...extra], {
      cwd: root,
      env,
    });
  if (['plan', 'apply', 'output'].includes(command)) {
    const { projectId, siteId } = await config({ root });
    env.TF_VAR_project_id = projectId;
    env.TF_VAR_hosting_site_id = siteId;
    const firestoreLocationId =
      env.TF_VAR_firestore_location_id ||
      env.FIRESTORE_LOCATION_ID ||
      localEnv.FIRESTORE_LOCATION_ID;
    const hostingAppId =
      env.TF_VAR_hosting_app_id ||
      env.FIREBASE_HOSTING_APP_ID ||
      localEnv.FIREBASE_HOSTING_APP_ID;
    if (firestoreLocationId)
      env.TF_VAR_firestore_location_id = firestoreLocationId;
    if (hostingAppId) env.TF_VAR_hosting_app_id = hostingAppId;
    // Do not let a caller's workspace setting bypass project-specific state.
    delete env.TF_WORKSPACE;
    console.log(`Terraform ${command}: project ${projectId}, site ${siteId}`);
    invoke('init', ['-input=false']);
    invoke('workspace', ['select', '-or-create', projectId]);
  }
  invoke(command, args);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  terraform(process.argv[2], process.argv.slice(3)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
