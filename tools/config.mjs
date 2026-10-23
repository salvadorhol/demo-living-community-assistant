import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

export const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

export async function loadConfig({
  root = workspaceRoot,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.CI),
  ask = async (question) => {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await terminal.question(question);
    } finally {
      terminal.close();
    }
  },
} = {}) {
  const envPath = resolve(root, '.env');
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const values = { ...parseEnv(original), ...env };
  let projectId = values.GCP_PROJECT_ID?.trim();
  const needsProject = !projectId;
  if (needsProject) {
    if (!interactive) {
      throw new Error(
        'Set GCP_PROJECT_ID in the root .env file (see .env.example), or run interactively to save it.',
      );
    }
    projectId = (
      await ask('GCP project ID (existing, billing-enabled project): ')
    ).trim();
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error(
      'Invalid GCP_PROJECT_ID: use 6–30 lowercase letters, digits, or hyphens, starting with a letter and ending with a letter or digit.',
    );
  }
  const siteId = values.FIREBASE_HOSTING_SITE_ID?.trim() || projectId;
  if (!/^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$/.test(siteId)) {
    throw new Error(
      'Invalid FIREBASE_HOSTING_SITE_ID: use 4–30 lowercase letters, digits, or hyphens, with no leading/trailing hyphen.',
    );
  }
  if (needsProject) {
    // Preserve comments and unrelated entries. parseEnv never executes shell code.
    const withoutProject = original
      .split('\n')
      .filter((line) => !/^\s*(?:export\s+)?GCP_PROJECT_ID\s*=/.test(line))
      .join('\n');
    writeFileSync(
      envPath,
      `${withoutProject}${withoutProject.endsWith('\n') || !withoutProject ? '' : '\n'}GCP_PROJECT_ID=${projectId}\n`,
      { mode: 0o600 },
    );
  }
  return { projectId, siteId };
}

export function assertRuntime(root = workspaceRoot) {
  const major = readFileSync(resolve(root, '.nvmrc'), 'utf8')
    .trim()
    .replace(/^v/, '')
    .split('.')[0];
  const readJson = (path) =>
    JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const firebase = readJson('firebase.json');
  const functions = readJson('functions/package.json');
  const build = readJson('functions/project.json');
  if (
    process.versions.node.split('.')[0] !== major ||
    functions.engines.node !== major ||
    firebase.functions[0].runtime !== `nodejs${major}` ||
    !build.targets.bundle.options.command.includes(`--target=node${major} `)
  ) {
    throw new Error(
      'Node runtime mismatch: run nvm use and align Functions engines, Firebase runtime, and esbuild target with .nvmrc.',
    );
  }
  return major;
}
