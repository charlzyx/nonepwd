#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './commands.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const isMonorepo =
  fs.existsSync(path.join(repoRoot, 'Cargo.toml')) &&
  fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'));
const archName = process.arch === 'x64' ? 'x86_64' : process.arch;
const ext = process.platform === 'win32' ? '.exe' : '';
const nativePlatformBin = path.join(
  repoRoot,
  'dist',
  'bin',
  `np-${process.platform}-${archName}${ext}`
);
const nativeDefaultBin = path.join(repoRoot, 'dist', 'bin', `np${ext}`);
const candidate = isMonorepo
  ? fs.existsSync(nativePlatformBin)
    ? nativePlatformBin
    : fs.existsSync(nativeDefaultBin)
    ? nativeDefaultBin
    : null
  : null;

if (candidate && process.env.NONEPWD_FORCE_JS_CLI !== '1') {
  const res = spawnSync(candidate, process.argv.slice(2), { stdio: 'inherit' });
  if (res.error === undefined) {
    process.exit(res.status ?? 1);
  }
}

const code = await runCli(process.argv.slice(2));
process.exit(code);
