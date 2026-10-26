import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {loadConfig, assertRuntime, workspaceRoot} from './config.mjs';
import {deploy} from './deploy.mjs';
import {configureReviewInvokers, reviewCallables} from './review-invokers.mjs';
import {terraform} from './terraform.mjs';
import {selectWebEnvironment} from './web-environment.mjs';

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), {recursive: true});
  writeFileSync(join(root, path), contents);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'community-deployment-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const path of [
    '.nvmrc',
    'firebase.json',
    'functions/package.json',
    'functions/project.json',
  ]) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    copyFileSync(join(workspaceRoot, path), join(root, path));
  }
  write(
    root,
    'apps/living-community-assistant/src/environments/environment.prod.ts',
    "export default { firebase: { apiKey: 'test-key', authDomain: 'example-project.firebaseapp.com', projectId: 'example-project', appId: 'test-app' } };\n"
  );
  write(
    root,
    'apps/living-community-assistant/src/environments/environment.example.ts',
    'export default {};\n'
  );
  write(
    root,
    'apps/living-community-assistant/dist/index.html',
    '<html></html>'
  );
  write(
    root,
    'apps/living-community-assistant/dist/.firebase-target.json',
    JSON.stringify({environment: 'prod', projectId: 'example-project'})
  );
  write(root, 'dist/functions/main.cjs', '');
  write(
    root,
    'dist/functions/package.json',
    JSON.stringify({engines: {node: '24'}, main: 'main.cjs'})
  );
  write(root, 'dist/functions/package-lock.json', '{}');
  return root;
}
const config = async () => ({
  projectId: 'example-project',
  siteId: 'example-site',
});

test('configuration precedence and invalid IDs', async t => {
  const root = fixture(t);
  write(root, '.env', 'GCP_PROJECT_ID=example-file\n');
  assert.deepEqual(
    await loadConfig({
      root,
      env: {
        GCP_PROJECT_ID: 'example-shell',
        FIREBASE_HOSTING_SITE_ID: 'example-site',
      },
      interactive: false,
    }),
    {projectId: 'example-shell', siteId: 'example-site'}
  );
  for (const env of [
    {GCP_PROJECT_ID: 'invalid;id'},
    {GCP_PROJECT_ID: 'example-shell', FIREBASE_HOSTING_SITE_ID: 'bad/site'},
  ]) {
    await assert.rejects(
      loadConfig({root, env, interactive: false}),
      /Invalid/
    );
  }
});
test('missing config fails noninteractively and prompts once interactively', async t => {
  const root = fixture(t);
  await assert.rejects(
    loadConfig({root, env: {}, interactive: false}),
    /Set GCP_PROJECT_ID/
  );
  write(root, '.env', '# settings\nOTHER=keep\nGCP_PROJECT_ID=\n');
  await loadConfig({
    root,
    env: {},
    interactive: true,
    ask: async () => 'example-project',
  });
  assert.match(readFileSync(join(root, '.env'), 'utf8'), /OTHER=keep/);
  assert.deepEqual(await loadConfig({root, env: {}, interactive: false}), {
    projectId: 'example-project',
    siteId: 'example-project',
  });
});
test('runtime drift is rejected', t => {
  const root = fixture(t);
  assert.equal(assertRuntime(root), '24');
  write(root, '.nvmrc', '22\n');
  assert.throws(() => assertRuntime(root), /runtime mismatch/);
});
for (const target of ['hosting', 'functions']) {
  test(`${target} deployment explicitly scopes its project and cleans up on success/failure`, async t => {
    const root = fixture(t);
    let calls = 0;
    const options = {
      root,
      config,
      firebaseCli: '/mock/firebase.js',
      execute(command, args) {
        calls++;
        if (command === 'gcloud') {
          assert.equal(target, 'functions');
          assert.deepEqual(args, [
            'run',
            'services',
            'update',
            reviewCallables[calls - 2].toLowerCase(),
            '--no-invoker-iam-check',
            '--region=us-central1',
            '--project=example-project',
            '--quiet',
          ]);
          return;
        }
        assert.equal(command, process.execPath);
        assert.deepEqual(args.slice(0, 6), [
          '/mock/firebase.js',
          'deploy',
          '--only',
          target === 'hosting'
            ? 'hosting'
            : 'firestore:rules,firestore:indexes,storage,functions',
          '--project',
          'example-project',
        ]);
        const generated = JSON.parse(readFileSync(args[7], 'utf8'));
        assert.ok(Array.isArray(generated.storage));
        assert.equal(
          generated.storage[0].bucket,
          process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
            'example-project-call-recordings'
        );
        if (target === 'hosting')
          assert.equal(generated.hosting.site, 'example-site');
      },
    };
    await deploy(target, options);
    assert.equal(calls, target === 'functions' ? 6 : 1);
    await assert.rejects(
      deploy(target, {
        ...options,
        execute() {
          throw new Error('CLI failed');
        },
      }),
      /CLI failed/
    );
    assert.equal(
      readdirSync(root).some(path => path.startsWith('.firebase.deploy.')),
      false
    );
  });
}
test('hosting refuses a stale or local build', async t => {
  const root = fixture(t);
  for (const marker of [
    {environment: 'local', projectId: 'example-project'},
    {environment: 'prod', projectId: 'other-project'},
  ]) {
    write(
      root,
      'apps/living-community-assistant/dist/.firebase-target.json',
      JSON.stringify(marker)
    );
    await assert.rejects(
      deploy('hosting', {
        root,
        config,
        firebaseCli: '/mock',
        execute: () => assert.fail('Must not deploy'),
      }),
      /does not match/
    );
  }
});
test('hosting refuses placeholders', async t => {
  const root = fixture(t);
  write(
    root,
    'apps/living-community-assistant/src/environments/environment.prod.ts',
    "export default { firebase: { apiKey: 'replace-with-key' } };\n"
  );
  await assert.rejects(
    deploy('hosting', {
      root,
      config,
      firebaseCli: '/mock',
      execute: () => assert.fail('Must not deploy'),
    }),
    /Set firebase.apiKey/
  );
});
test('incomplete Functions artifacts are rejected', async t => {
  const root = fixture(t);
  rmSync(join(root, 'dist/functions/package-lock.json'));
  await assert.rejects(
    deploy('functions', {
      root,
      config,
      firebaseCli: '/mock',
      execute: () => assert.fail('Must not deploy'),
    }),
    /incomplete/
  );
});
test('environment selection keeps emulator mode explicit and allows unconfigured builds', t => {
  const root = fixture(t);
  assert.equal(
    selectWebEnvironment({root, command: 'serve', mode: 'development'}).kind,
    'prod'
  );
  assert.equal(
    selectWebEnvironment({root, command: 'serve', mode: 'local-emulator'}).kind,
    'local'
  );
  assert.equal(
    selectWebEnvironment({root, command: 'serve', mode: 'test'}).kind,
    'example'
  );
  rmSync(
    join(
      root,
      'apps/living-community-assistant/src/environments/environment.prod.ts'
    )
  );
  assert.equal(
    selectWebEnvironment({root, command: 'build', mode: 'production'}).kind,
    'example'
  );
});
test('Terraform selects project state without suppressing apply confirmation', async t => {
  const calls = [];
  await terraform('apply', [], {
    root: fixture(t),
    config,
    execute: (command, args, options) => calls.push({command, args, options}),
  });
  assert.deepEqual(
    calls.map(call => call.args.slice(1)),
    [
      ['init', '-input=false'],
      ['workspace', 'select', '-or-create', 'example-project'],
      ['apply'],
    ]
  );
  for (const call of calls) {
    assert.equal(call.options.env.TF_VAR_project_id, 'example-project');
    assert.equal(call.options.env.TF_WORKSPACE, undefined);
  }
});

test('Terraform import uses project state and preserves production settings', async t => {
  const root = fixture(t);
  write(
    root,
    '.env',
    [
      'FIRESTORE_LOCATION_ID=nam5',
      'FIREBASE_HOSTING_APP_ID=existing-web-app',
      'RECORDINGS_LOCATION_ID=us-central1',
      'FIRESTORE_DELETE_PROTECTION_STATE=DELETE_PROTECTION_DISABLED',
      'FUNCTIONS_FIRESTORE_ACCESS=false',
      'SOCKET_SERVICE_ACCOUNT=socket@example-project.iam.gserviceaccount.com',
    ].join('\n')
  );
  const calls = [];
  await terraform(
    'import',
    [
      'google_firestore_database.default',
      'projects/example-project/databases/(default)',
    ],
    {
      root,
      config,
      execute: (command, args, options) => calls.push({command, args, options}),
    }
  );
  assert.deepEqual(
    calls.map(call => call.args.slice(1)),
    [
      ['init', '-input=false'],
      ['workspace', 'select', '-or-create', 'example-project'],
      [
        'import',
        'google_firestore_database.default',
        'projects/example-project/databases/(default)',
      ],
    ]
  );
  const env = calls.at(-1).options.env;
  assert.equal(env.TF_VAR_firestore_location_id, 'nam5');
  assert.equal(env.TF_VAR_hosting_app_id, 'existing-web-app');
  assert.equal(env.TF_VAR_recordings_location_id, 'us-central1');
  assert.equal(
    env.TF_VAR_firestore_delete_protection_state,
    'DELETE_PROTECTION_DISABLED'
  );
  assert.equal(env.TF_VAR_functions_firestore_access, 'false');
  assert.equal(
    env.TF_VAR_socket_service_account,
    'socket@example-project.iam.gserviceaccount.com'
  );
});

test('review invoker setup targets only admin browser callables and stops on failure', () => {
  assert.deepEqual(reviewCallables, [
    'listReviewCalls',
    'getReviewCall',
    'getReviewAudio',
    'generateCallReview',
    'deleteCall',
  ]);
  let calls = 0;
  assert.throws(
    () =>
      configureReviewInvokers({
        projectId: 'example-project',
        root: '/tmp',
        execute: () => {
          calls++;
          throw new Error('IAM denied');
        },
      }),
    /IAM denied/
  );
  assert.equal(calls, 1);
});
test('Functions deployment surfaces IAM repair failures and removes temporary config', async t => {
  const root = fixture(t);
  await assert.rejects(
    deploy('functions', {
      root,
      config,
      firebaseCli: '/mock/firebase.js',
      execute(command) {
        if (command === 'gcloud') throw new Error('IAM denied');
      },
    }),
    /IAM denied/
  );
  assert.equal(
    readdirSync(root).some(path => path.startsWith('.firebase.deploy.')),
    false
  );
});
