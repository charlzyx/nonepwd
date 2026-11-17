import { invokeRust } from './wasm-runtime.js';

export function extractEmailAddress(rawHeader: string): string {
  return invokeRust<string>('extract_email_address', { rawHeader });
}

export function extractHost(input: string): string {
  return invokeRust<string>('extract_host', { input });
}

export function extractRegistrableDomain(hostOrEmailOrUrl: string): string {
  return invokeRust<string>('extract_registrable_domain', { input: hostOrEmailOrUrl });
}

export function domainsMatch(urlOrHostA: string, urlOrHostB: string): boolean {
  return invokeRust<boolean>('domains_match', { a: urlOrHostA, b: urlOrHostB });
}

export function stripHtmlToCleanText(html: string): string {
  return invokeRust<string>('strip_html_to_clean_text', { html });
}

export interface EmailOtpExtractionInput {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface EmailOtpExtractionResult {
  otpCode: string | null;
  confidence: number;
  magicLink: string | null;
  senderAddress: string;
  senderDomain: string;
  snippet: string;
  cleanText: string;
}

export function extractEmailOtp(input: EmailOtpExtractionInput): EmailOtpExtractionResult {
  return invokeRust<EmailOtpExtractionResult>('extract_email_otp', input);
}
