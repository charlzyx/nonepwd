import PostalMime from 'postal-mime';
import {
  extractEmailAddress,
  extractEmailOtp,
  randomId,
  sealJsonForPublicKey,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type SealedEnvelope,
} from '@nonepwd/core';
import type { NonePwdDb } from './db.js';
import type { WsHub } from './ws.js';

const MAX_STORED_EMAILS = 200;

function checkAliasAllowed(db: NonePwdDb, targetEmail: string | null): {
  allowed: boolean;
  aliasId: string | null;
} {
  if (!targetEmail) return { allowed: true, aliasId: null };
  const clean = extractEmailAddress(targetEmail);
  const row = db.sqlite
    .prepare('SELECT id, enabled FROM aliases WHERE LOWER(address) = ?')
    .get(clean) as { id: string; enabled: number } | undefined;
  if (!row) return { allowed: true, aliasId: null };
  if (row.enabled === 0) return { allowed: false, aliasId: row.id };
  return { allowed: true, aliasId: row.id };
}

function storeSealedEmail(
  db: NonePwdDb,
  wsHub: WsHub,
  params: {
    id?: string;
    source: 'imap' | 'cloudflare' | 'simulate';
    envelopeTo: string | null;
    hasOtp: boolean;
    sealedEnvelope: SealedEnvelope;
    receivedAt: string;
    aliasId: string | null;
  }
): EncryptedEmailRecord {
  const id = params.id ?? randomId();
  db.sqlite
    .prepare(
      `INSERT INTO encrypted_emails (id, source, envelope_to, has_otp, sealed_envelope, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      params.source,
      params.envelopeTo,
      params.hasOtp ? 1 : 0,
      JSON.stringify(params.sealedEnvelope),
      params.receivedAt
    );

  if (params.aliasId) {
    db.sqlite
      .prepare('UPDATE aliases SET received_count = received_count + 1 WHERE id = ?')
      .run(params.aliasId);
  }

  // Prune old records above MAX_STORED_EMAILS
  db.sqlite
    .prepare(
      `DELETE FROM encrypted_emails WHERE id NOT IN (
         SELECT id FROM encrypted_emails ORDER BY received_at DESC LIMIT ?
       )`
    )
    .run(MAX_STORED_EMAILS);

  const record: EncryptedEmailRecord = {
    id,
    source: params.source,
    envelopeTo: params.envelopeTo,
    hasOtp: params.hasOtp,
    sealedEnvelope: params.sealedEnvelope,
    receivedAt: params.receivedAt,
  };

  wsHub.broadcast({ type: 'email.received', email: record });
  return record;
}

export interface IngestResult {
  accepted: boolean;
  reason?: string;
  email?: EncryptedEmailRecord;
}

export async function ingestRawEmail(params: {
  db: NonePwdDb;
  wsHub: WsHub;
  rawMime: Uint8Array | string;
  source: 'imap' | 'cloudflare';
  envelopeFrom?: string;
  envelopeTo?: string;
}): Promise<IngestResult> {
  const account = params.db.sqlite
    .prepare('SELECT email_public_key FROM account WHERE id = 1')
    .get() as { email_public_key: string } | undefined;

  if (!account) {
    return { accepted: false, reason: 'account_not_initialized' };
  }

  const parsed = await PostalMime.parse(params.rawMime);
  const fromHeader =
    parsed.from?.address
      ? `${parsed.from.name ? `${parsed.from.name} ` : ''}<${parsed.from.address}>`
      : params.envelopeFrom ?? 'unknown@unknown';
  const toAddr =
    params.envelopeTo ??
    parsed.to?.[0]?.address ??
    '';

  const aliasCheck = checkAliasAllowed(params.db, toAddr || null);
  if (!aliasCheck.allowed) {
    return { accepted: false, reason: 'alias_disabled' };
  }

  const subject = parsed.subject ?? '(No Subject)';
  const extracted = extractEmailOtp({
    from: fromHeader,
    to: toAddr,
    subject,
    text: parsed.text ?? undefined,
    html: parsed.html ?? undefined,
  });

  const id = randomId();
  const receivedAt = new Date().toISOString();
  const payload: DecryptedEmailPayload = {
    id,
    from: fromHeader,
    to: toAddr ? extractEmailAddress(toAddr) : '',
    subject,
    snippet: extracted.snippet,
    textBody: extracted.cleanText.slice(0, 6000),
    otpCode: extracted.otpCode,
    confidence: extracted.confidence,
    magicLink: extracted.magicLink,
    senderDomain: extracted.senderDomain,
    receivedAt,
  };

  const sealedEnvelope = await sealJsonForPublicKey(account.email_public_key, payload);
  const record = storeSealedEmail(params.db, params.wsHub, {
    id,
    source: params.source,
    envelopeTo: payload.to || null,
    hasOtp: Boolean(payload.otpCode),
    sealedEnvelope,
    receivedAt,
    aliasId: aliasCheck.aliasId,
  });

  return { accepted: true, email: record };
}

export async function ingestPreSealedEmail(params: {
  db: NonePwdDb;
  wsHub: WsHub;
  sealedEnvelope: SealedEnvelope;
  hasOtp: boolean;
  envelopeTo?: string | null;
  source?: 'cloudflare';
}): Promise<IngestResult> {
  const account = params.db.sqlite
    .prepare('SELECT id FROM account WHERE id = 1')
    .get() as { id: number } | undefined;
  if (!account) {
    return { accepted: false, reason: 'account_not_initialized' };
  }

  const normalizedTo = params.envelopeTo ? extractEmailAddress(params.envelopeTo) : null;
  const aliasCheck = checkAliasAllowed(params.db, normalizedTo);
  if (!aliasCheck.allowed) {
    return { accepted: false, reason: 'alias_disabled' };
  }

  const record = storeSealedEmail(params.db, params.wsHub, {
    source: params.source ?? 'cloudflare',
    envelopeTo: normalizedTo,
    hasOtp: params.hasOtp,
    sealedEnvelope: params.sealedEnvelope,
    receivedAt: new Date().toISOString(),
    aliasId: aliasCheck.aliasId,
  });

  return { accepted: true, email: record };
}

export async function ingestSimulatedEmail(params: {
  db: NonePwdDb;
  wsHub: WsHub;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<IngestResult> {
  const account = params.db.sqlite
    .prepare('SELECT email_public_key FROM account WHERE id = 1')
    .get() as { email_public_key: string } | undefined;
  if (!account) {
    return { accepted: false, reason: 'account_not_initialized' };
  }

  const cleanTo = extractEmailAddress(params.to);
  const aliasCheck = checkAliasAllowed(params.db, cleanTo || null);
  if (!aliasCheck.allowed) {
    return { accepted: false, reason: 'alias_disabled' };
  }

  const extracted = extractEmailOtp({
    from: params.from,
    to: cleanTo,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });

  const id = randomId();
  const receivedAt = new Date().toISOString();
  const payload: DecryptedEmailPayload = {
    id,
    from: params.from,
    to: cleanTo,
    subject: params.subject,
    snippet: extracted.snippet,
    textBody: extracted.cleanText.slice(0, 6000),
    otpCode: extracted.otpCode,
    confidence: extracted.confidence,
    magicLink: extracted.magicLink,
    senderDomain: extracted.senderDomain,
    receivedAt,
  };

  const sealedEnvelope = await sealJsonForPublicKey(account.email_public_key, payload);
  const record = storeSealedEmail(params.db, params.wsHub, {
    id,
    source: 'simulate',
    envelopeTo: cleanTo || null,
    hasOtp: Boolean(payload.otpCode),
    sealedEnvelope,
    receivedAt,
    aliasId: aliasCheck.aliasId,
  });

  return { accepted: true, email: record };
}
