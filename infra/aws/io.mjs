import { existsSync, mkdirSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

export function publicExample(root, path) {
  const input = realpathSync(resolve(path));
  if (!input.startsWith(`${root}/infra/aws/examples/`) || !lstatSync(input).isFile() || lstatSync(input).size > 16_384) throw new Error('bounded-public-example-required');
  return JSON.parse(readFileSync(input, 'utf8'));
}
export function newPrivateOutput(root, path) {
  const parent = join(root, 'infra/aws/.private'), output = resolve(path);
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || realpathSync(parent) !== parent || dirname(output) !== parent || existsSync(output)) throw new Error('new-private-output-required');
  return output;
}
