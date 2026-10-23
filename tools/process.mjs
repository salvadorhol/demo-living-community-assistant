import { spawnSync } from 'node:child_process';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error)
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.signal || result.status}).`);
}
