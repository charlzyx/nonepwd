import crypto from 'node:crypto';
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
  if (overrideDir && overrideDir.length > 0) return overrideDir;
  if (process.env.NONEPWD_CONFIG_DIR && process.env.NONEPWD_CONFIG_DIR.length > 0) {
    return process.env.NONEPWD_CONFIG_DIR;
  }
  if (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0) {
    return path.join(process.env.XDG_CONFIG_HOME, 'nonepwd');
  }
  return path.join(os.homedir(), '.config', 'nonepwd');
}

export function writePrivateFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${rand}`);
  try {
    const fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    try {
      if (process.platform !== 'win32') {
        fs.fchmodSync(fd, 0o600);
      }
      fs.writeFileSync(fd, content, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpPath, 0o600);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
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
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
  }
  const filePath = path.join(dir, 'config.json');
  writePrivateFileAtomic(filePath, JSON.stringify(config, null, 2));
  return filePath;
}
