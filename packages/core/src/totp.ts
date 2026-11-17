import { invokeRust, invokeRustAsync } from './wasm-runtime.js';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface ParsedTotpConfig {
  secret: string;
  issuer?: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

export interface TotpResult {
  code: string;
  period: number;
  remainingSeconds: number;
  progress: number;
}

export function parseOtpInput(input: string): ParsedTotpConfig {
  return invokeRust<ParsedTotpConfig>('parse_otp_input', { input });
}

export async function generateTotp(
  input: string,
  timestampMs: number = Date.now()
): Promise<TotpResult> {
  return invokeRustAsync<TotpResult>('generate_totp', { input, timestampMs });
}

export function buildOtpAuthUri(params: {
  secret: string;
  account?: string;
  issuer?: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}): string {
  return invokeRust<string>('build_otp_auth_uri', params);
}
