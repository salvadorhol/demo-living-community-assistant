import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { assertRuntime, loadConfig, workspaceRoot } from './config.mjs';
import { run } from './process.mjs';
import { configureReviewInvokers } from './review-invokers.mjs';
import { readProductionWebEnvironment } from './web-environment.mjs';

const require = createRequire(import.meta.url);

export async function deploy(
  target,
  {
    root = workspaceRoot,
    execute = run,
    config = loadConfig,
    firebaseCli = require.resolve('firebase-tools/lib/bin/firebase.js'),
  } = {},
) {
  if (!['hosting', 'functions', 'rules'].includes(target)) {
    throw new Error('Usage: node tools/deploy.mjs <hosting|functions|rules>');
  }
  const major = assertRuntime(root);
  const { projectId, siteId } = await config({ root });
  const firebase = JSON.parse(
    readFileSync(resolve(root, 'firebase.json'), 'utf8'),
  );
  // The CLI resolves object-form Storage configuration through the default
  // bucket, even when it includes a bucket name. Array form preserves it.
  firebase.storage = [
    {
      ...firebase.storage,
      bucket:
        process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
        `${projectId}-call-recordings`,
    },
  ];
  if (target === 'hosting') {
    const output = resolve(root, firebase.hosting.public);
    if (
      !existsSync(resolve(output, 'index.html')) ||
      !existsSync(resolve(output, '.firebase-target.json'))
    ) {
      throw new Error(
        'Hosting artifact is incomplete. Run nx build living-community-assistant.',
      );
    }
    const marker = JSON.parse(
      readFileSync(resolve(output, '.firebase-target.json'), 'utf8'),
    );
    const environment = await readProductionWebEnvironment(root);
    for (const key of ['apiKey', 'authDomain', 'projectId', 'appId']) {
      const value = environment.firebase?.[key];
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.startsWith('replace-with') ||
        value.startsWith('demo-')
      ) {
        throw new Error(
          `Set firebase.${key} in environment.prod.ts before deploying Hosting.`,
        );
      }
    }
    if (
      marker.environment !== 'prod' ||
      marker.projectId !== projectId ||
      environment.firebase.projectId !== projectId
    ) {
      throw new Error(
        'Hosting Firebase project does not match GCP_PROJECT_ID. Configure environment.prod.ts and rebuild.',
      );
    }
    firebase.hosting.site = siteId;
  } else if (target === 'functions') {
    const output = resolve(root, firebase.functions[0].source);
    if (!existsSync(resolve(output, 'package.json'))) {
      throw new Error('Functions artifact is missing. Run nx build functions.');
    }
    const manifest = JSON.parse(
      readFileSync(resolve(output, 'package.json'), 'utf8'),
    );
    if (
      manifest.engines?.node !== major ||
      !existsSync(resolve(output, manifest.main || 'main.js')) ||
      !existsSync(resolve(output, 'package-lock.json'))
    ) {
      throw new Error(
        'Functions artifact is incomplete or has the wrong runtime. Run nx build functions.',
      );
    }
  }
  const configPath = resolve(
    root,
    `.firebase.deploy.${target}.${process.pid}.json`,
  );
  try {
    writeFileSync(configPath, JSON.stringify(firebase, null, 2));
    console.log(`Deploying ${target} to ${projectId}`);
    execute(
      process.execPath,
      [
        firebaseCli,
        'deploy',
        '--only',
        target === 'rules'
          ? 'firestore:rules,firestore:indexes,storage'
          : target === 'functions'
            ? 'firestore:rules,firestore:indexes,storage,functions'
            : 'hosting',
        '--project',
        projectId,
        '--config',
        configPath,
      ],
      { cwd: root },
    );
    // Callable updates can preserve an enabled Cloud Run Invoker IAM check. Repair
    // the browser transport explicitly; the handlers still require admin claims.
    if (target === 'functions')
      configureReviewInvokers({ projectId, root, execute });
  } finally {
    rmSync(configPath, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  deploy(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
