import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CliSessionData {
  token: string;
  rootKeyB64: string;
  emailPrivateKeyPkcs8B64: string;
  savedAt: string;
}

export interface CliConfig {
  serverUrl?: string;
  email?: string;
  secretKey?: string;
  session?: CliSessionData;
}

export function resolveConfigDir(overrideDir?: string): string {
  return (
    overrideDir ??
    process.env.NONEPWD_CONFIG_DIR ??
    path.join(os.homedir(), '.config', 'nonepwd')
  );
}

export function loadCliConfig(configDir?: string): CliConfig {
  const dir = resolveConfigDir(configDir);
  const filePath = path.join(dir, 'config.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

export function saveCliConfig(config: CliConfig, configDir?: string): string {
  const dir = resolveConfigDir(configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return filePath;
}
