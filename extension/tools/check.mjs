#!/usr/bin/env node
// Static checks that do not need Chrome:
//  1. every file referenced by manifest.json exists;
//  2. `node --check` passes for every .js/.mjs file;
//  3. every relative ES import specifier resolves to an existing file;
//  4. files injected with chrome.scripting / offscreen / popup exist.
// Usage: node tools/check.mjs   (from the extension folder or the project root)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const ok = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// 1. manifest references
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const refs = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);
for (const ref of refs) {
  if (!existsSync(join(root, ref))) problems.push(`manifest: missing ${ref}`);
}
ok.push(`manifest: ${refs.length} references checked`);

// 2 + 3. syntax and relative imports
const files = walk(root).filter((f) => /\.(m?js)$/.test(f));
for (const file of files) {
  const rel = relative(root, file);
  const isClassic = rel.replaceAll('\\', '/').startsWith('src/page/');
  const args = isClassic ? ['--check', file] : ['--input-type=module', '--check'];
  const result = isClassic
    ? spawnSync(process.execPath, args, { encoding: 'utf8' })
    : spawnSync(process.execPath, args, { encoding: 'utf8', input: readFileSync(file, 'utf8') });
  if (result.status !== 0) problems.push(`syntax: ${rel}\n${result.stderr.trim()}`);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:import|export)\s[^'"`]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) problems.push(`import: ${rel} -> ${match[1]} (missing)`);
  }
}
ok.push(`syntax + imports: ${files.length} files`);

// 4. runtime-loaded files (string paths in the code)
const runtimePaths = new Set();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/['"](src\/(?:page|offscreen|popup)\/[\w.-]+\.(?:js|html))['"]/g)) runtimePaths.add(match[1]);
}
for (const p of runtimePaths) {
  if (!existsSync(join(root, p))) problems.push(`runtime file missing: ${p}`);
}
ok.push(`runtime files: ${runtimePaths.size} checked`);

for (const line of ok) console.log(`ok   ${line}`);
for (const line of problems) console.log(`FAIL ${line}`);
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall checks passed');
process.exit(problems.length ? 1 : 0);
