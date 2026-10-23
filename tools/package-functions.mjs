import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRuntime, workspaceRoot } from './config.mjs';
import { run } from './process.mjs';

assertRuntime();
const output = resolve(workspaceRoot, 'dist/functions');
const path = resolve(output, 'package.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
// Shared contracts are erased by TypeScript; only runtime dependencies ship.
delete manifest.devDependencies;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(resolve(output, 'workspace_modules'), { recursive: true, force: true });
// Nx's pruned npm lock can omit nested dependencies. Let npm normalize it for
// this standalone package before Cloud Build runs npm ci.
run(
  'npm',
  [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
  ],
  { cwd: output },
);
