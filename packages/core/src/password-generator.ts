import { invokeRust } from './wasm-bridge.js';

export interface PasswordOptions {
  length?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

export function generatePassword(options: PasswordOptions = {}): string {
  return invokeRust<string>('generate_password', options);
}

export interface PassphraseOptions {
  words?: number;
  separator?: string;
  capitalize?: boolean;
  includeNumber?: boolean;
}

export function generatePassphrase(options: PassphraseOptions = {}): string {
  return invokeRust<string>('generate_passphrase', options);
}

export function generateEmailAlias(siteOrDomain: string, aliasDomain: string): string {
  return invokeRust<string>('generate_email_alias', { siteOrDomain, aliasDomain });
}
