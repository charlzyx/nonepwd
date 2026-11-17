import PostalMime from 'postal-mime';
import {
  extractEmailAddress,
  extractEmailOtp,
  randomId,
  sealJsonForPublicKey,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type SealedEnvelope,
} from '@nonepwd/core/worker';
import { ensureSchema } from './schema.js';
import type {
  CfServerEnv,
  EmailFilterConfig,
  EmailFilterField,
  EmailFilterMode,
  EmailMessageLike,
} from './types.js';
import { broadcastEvent } from './ws-hub.js';

const MAX_STORED_EMAILS = 200;

export const DEFAULT_EMAIL_FILTER: EmailFilterConfig = {
  enabled: false,
  otpOnly: false,
  mode: 'allow',
  rules: [],
};

export function validateAndNormalizeEmailFilter(raw: Partial<EmailFilterConfig>): EmailFilterConfig {
  const mode: EmailFilterMode = raw.mode === 'deny' ? 'deny' : 'allow';
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map((r) => {
        const pattern = typeof r?.pattern === 'string' ? r.pattern : '';
        if (!pattern.trim()) {
          throw new Error('Email filter rule pattern must not be empty');
        }
        try {
          // Validate RegExp syntax eagerly before storing
          void new RegExp(pattern);
        } catch (err) {
          throw new Error(
            `Invalid regex pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
        const field: EmailFilterField =
          r?.field === 'to' || r?.field === 'subject' || r?.field === 'body' ? r.field : 'from';
        return {
          id: typeof r?.id === 'string' && r.id.trim() ? r.id.trim() : randomId(),
          field,
          pattern,
          enabled: r?.enabled !== undefined ? Boolean(r.enabled) : true,
        };
      })
    : [];

  return {
    enabled: Boolean(raw.enabled),
    otpOnly: Boolean(raw.otpOnly),
    mode,
    rules,
  };
}

export async function getEmailFilter(db: D1Database): Promise<EmailFilterConfig> {
  const row = await db
    .prepare('SELECT config_json FROM email_filter WHERE id = 1')
    .first<{ config_json: string }>();

  if (!row?.config_json) {
    return { ...DEFAULT_EMAIL_FILTER, rules: [] };
  }
  try {
    const parsed = JSON.parse(row.config_json) as Partial<EmailFilterConfig>;
    return {
      enabled: Boolean(parsed.enabled),
      otpOnly: Boolean(parsed.otpOnly),
      mode: parsed.mode === 'deny' ? 'deny' : 'allow',
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    };
  } catch {
    return { ...DEFAULT_EMAIL_FILTER, rules: [] };
  }
}

export async function saveEmailFilter(
  db: D1Database,
  cfg: Partial<EmailFilterConfig>
): Promise<EmailFilterConfig> {
  const validated = validateAndNormalizeEmailFilter(cfg);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO email_filter (id, config_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify(validated), now)
    .run();
  return validated;
}

interface FilterEvalContext {
  from: string;
  to: string;
  subject: string;
  body: string;
  rawText?: string;
  hasOtp: boolean;
  edgeSealed: boolean;
}

function ruleMatchesField(pattern: string, field: EmailFilterField, ctx: FilterEvalContext): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return false;
  }

  switch (field) {
    case 'from': {
      if (re.test(ctx.from)) return true;
      const bare = extractEmailAddress(ctx.from);
      return Boolean(bare && re.test(bare));
    }
    case 'to': {
      if (re.test(ctx.to)) return true;
      const bare = extractEmailAddress(ctx.to);
      return Boolean(bare && re.test(bare));
    }
    case 'subject':
      return re.test(ctx.subject);
    case 'body':
      return re.test(ctx.body) || Boolean(ctx.rawText && re.test(ctx.rawText));
  }
}

export function evaluateEmailFilter(filter: EmailFilterConfig, ctx: FilterEvalContext): boolean {
  if (!filter.enabled) return true;
  if (filter.otpOnly && !ctx.hasOtp) return false;

  const enabledRules = filter.rules.filter((r) => r.enabled);
  if (enabledRules.length === 0) {
    if (filter.otpOnly) return true;
    return filter.mode === 'deny';
  }

  if (ctx.edgeSealed) {
    const toRules = enabledRules.filter((r) => r.field === 'to');
    if (toRules.length === 0) return true;
    const anyMatch = toRules.some((r) => ruleMatchesField(r.pattern, r.field, ctx));
    return filter.mode === 'allow' ? anyMatch : !anyMatch;
  }

  const anyMatch = enabledRules.some((r) => ruleMatchesField(r.pattern, r.field, ctx));
  return filter.mode === 'allow' ? anyMatch : !anyMatch;
}

async function checkAliasAllowed(
  db: D1Database,
  targetEmail: string | null
): Promise<{ allowed: boolean; aliasId: string | null }> {
  if (!targetEmail || !targetEmail.trim()) return { allowed: true, aliasId: null };
  const clean = extractEmailAddress(targetEmail);
  if (!clean) return { allowed: true, aliasId: null };

  const row = await db
    .prepare('SELECT id, enabled FROM aliases WHERE LOWER(address) = ?')
    .bind(clean)
    .first<{ id: string; enabled: number }>();

  if (!row) return { allowed: true, aliasId: null };
  if (row.enabled === 0) return { allowed: false, aliasId: row.id };
  return { allowed: true, aliasId: row.id };
}

async function storeSealedEmail(
  env: CfServerEnv,
  params: {
    id?: string;
    source: 'imap' | 'cloudflare' | 'simulate';
    envelopeTo: string | null;
    hasOtp: boolean;
    sealedEnvelope: SealedEnvelope;
    receivedAt: string;
    aliasId: string | null;
  }
): Promise<EncryptedEmailRecord> {
  const id = params.id ?? randomId();
  const sealedJson = JSON.stringify(params.sealedEnvelope);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO encrypted_emails (id, source, envelope_to, has_otp, sealed_envelope, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      params.source,
      params.envelopeTo,
      params.hasOtp ? 1 : 0,
      sealedJson,
      params.receivedAt
    ),
  ];

  if (params.aliasId) {
    stmts.push(
      env.DB.prepare('UPDATE aliases SET received_count = received_count + 1 WHERE id = ?').bind(
        params.aliasId
      )
    );
  }

  await env.DB.batch(stmts);

  // Archive encrypted sealed envelope into R2 when configured
  if (env.BUCKET) {
    await env.BUCKET.put(
      `emails/${id}.json`,
      JSON.stringify({
        id,
        source: params.source,
        envelopeTo: params.envelopeTo,
        hasOtp: params.hasOtp,
        sealedEnvelope: params.sealedEnvelope,
        receivedAt: params.receivedAt,
      }),
      {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          source: params.source,
          hasOtp: params.hasOtp ? '1' : '0',
          receivedAt: params.receivedAt,
        },
      }
    );
  }

  // Prune overflow records beyond MAX_STORED_EMAILS from both D1 and R2
  const overflow = await env.DB.prepare(
    `SELECT id FROM encrypted_emails
     WHERE id NOT IN (
       SELECT id FROM encrypted_emails ORDER BY received_at DESC LIMIT ?
     )`
  )
    .bind(MAX_STORED_EMAILS)
    .all<{ id: string }>();

  const overflowIds = (overflow.results ?? []).map((r) => r.id);
  if (overflowIds.length > 0) {
    await env.DB.batch(
      overflowIds.map((oldId) =>
        env.DB.prepare('DELETE FROM encrypted_emails WHERE id = ?').bind(oldId)
      )
    );
    if (env.BUCKET) {
      await Promise.all(overflowIds.map((oldId) => env.BUCKET!.delete(`emails/${oldId}.json`)));
    }
  }

  const record: EncryptedEmailRecord = {
    id,
    source: params.source,
    envelopeTo: params.envelopeTo,
    hasOtp: params.hasOtp,
    sealedEnvelope: params.sealedEnvelope,
    receivedAt: params.receivedAt,
  };

  await broadcastEvent(env, { type: 'email.received', email: record });
  return record;
}

export async function deleteStoredEmail(env: CfServerEnv, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM encrypted_emails WHERE id = ?').bind(id).run();
  const changes = Number(res.meta?.changes ?? 0);
  if (changes > 0 && env.BUCKET) {
    await env.BUCKET.delete(`emails/${id}.json`);
  }
  return changes > 0;
}

export async function queryEmails(
  env: CfServerEnv,
  limit: number = 100
): Promise<EncryptedEmailRecord[]> {
  const res = await env.DB.prepare(
    `SELECT id, source, envelope_to, has_otp, sealed_envelope, received_at
     FROM encrypted_emails ORDER BY received_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{
      id: string;
      source: 'imap' | 'cloudflare' | 'simulate';
      envelope_to: string | null;
      has_otp: number;
      sealed_envelope: string;
      received_at: string;
    }>();

  const rows = res.results ?? [];
  return Promise.all(
    rows.map(async (r) => {
      let sealedEnvelope: SealedEnvelope | null = null;
      if (r.sealed_envelope && r.sealed_envelope !== 'r2') {
        try {
          sealedEnvelope = JSON.parse(r.sealed_envelope) as SealedEnvelope;
        } catch {
          sealedEnvelope = null;
        }
      }
      if (!sealedEnvelope && env.BUCKET) {
        const obj = await env.BUCKET.get(`emails/${r.id}.json`);
        if (obj) {
          const parsed = (await obj.json()) as { sealedEnvelope?: SealedEnvelope };
          sealedEnvelope = parsed.sealedEnvelope ?? null;
        }
      }
      return {
        id: r.id,
        source: r.source,
        envelopeTo: r.envelope_to,
        hasOtp: r.has_otp !== 0,
        sealedEnvelope: sealedEnvelope ?? { v: 1, epk: '', iv: '', ct: '' },
        receivedAt: r.received_at,
      };
    })
  );
}

export interface IngestResult {
  accepted: boolean;
  reason?: string;
  email?: EncryptedEmailRecord;
}

export async function ingestRawEmail(params: {
  env: CfServerEnv;
  rawMime: Uint8Array | string;
  source: 'imap' | 'cloudflare';
  envelopeFrom?: string;
  envelopeTo?: string;
}): Promise<IngestResult> {
  const account = await params.env.DB.prepare('SELECT email_public_key FROM account WHERE id = 1')
    .first<{ email_public_key: string }>();

  if (!account) {
    return { accepted: false, reason: 'account_not_initialized' };
  }

  const parsed = await PostalMime.parse(params.rawMime);
  const fromHeader = parsed.from?.address
    ? `${parsed.from.name ? `${parsed.from.name} ` : ''}<${parsed.from.address}>`
    : params.envelopeFrom?.trim() || 'unknown@unknown';
  const toAddr = params.envelopeTo?.trim() || parsed.to?.[0]?.address || '';

  const aliasCheck = await checkAliasAllowed(params.env.DB, toAddr || null);
  if (!aliasCheck.allowed) {
    return { accepted: false, reason: 'alias_disabled' };
  }

  const subject = parsed.subject || '(No Subject)';
  const extracted = extractEmailOtp({
    from: fromHeader,
    to: toAddr,
    subject,
    text: parsed.text ?? undefined,
    html: parsed.html ?? undefined,
  });

  const hasOtp = Boolean(extracted.otpCode);
  const cleanTo = toAddr ? extractEmailAddress(toAddr) : '';

  const filter = await getEmailFilter(params.env.DB);
  if (
    !evaluateEmailFilter(filter, {
      from: fromHeader,
      to: cleanTo || toAddr,
      subject,
      body: extracted.cleanText,
      rawText: parsed.text ?? undefined,
      hasOtp,
      edgeSealed: false,
    })
  ) {
    return { accepted: false, reason: 'filtered' };
  }

  const id = randomId();
  const receivedAt = new Date().toISOString();
  const payload: DecryptedEmailPayload = {
    id,
    from: fromHeader,
    to: cleanTo,
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
  const record = await storeSealedEmail(params.env, {
    id,
    source: params.source,
    envelopeTo: cleanTo || null,
    hasOtp,
    sealedEnvelope,
    receivedAt,
    aliasId: aliasCheck.aliasId,
  });

  return { accepted: true, email: record };
}

export async function ingestPreSealedEmail(params: {
  env: CfServerEnv;
  sealedEnvelope: SealedEnvelope;
  hasOtp: boolean;
  envelopeTo?: string | null;
  source?: 'cloudflare';
}): Promise<IngestResult> {
  const account = await params.env.DB.prepare('SELECT id FROM account WHERE id = 1')
    .first<{ id: number }>();

  if (!account) {
    return { accepted: false, reason: 'account_not_initialized' };
  }

  const normalizedTo = params.envelopeTo ? extractEmailAddress(params.envelopeTo) : null;
  const aliasCheck = await checkAliasAllowed(params.env.DB, normalizedTo);
  if (!aliasCheck.allowed) {
    return { accepted: false, reason: 'alias_disabled' };
  }

  const filter = await getEmailFilter(params.env.DB);
  if (
    !evaluateEmailFilter(filter, {
      from: '',
      to: normalizedTo ?? '',
      subject: '',
      body: '',
      hasOtp: params.hasOtp,
      edgeSealed: true,
    })
  ) {
    return { accepted: false, reason: 'filtered' };
  }

  const record = await storeSealedEmail(params.env, {
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
  env: CfServerEnv;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<IngestResult> {
  const account = await params.env.DB.prepare('SELECT email_public_key FROM account WHERE id = 1')
    .first<{ email_public_key: string }>();

  if (!account) {
    return { accepted: false, reason: 'account_not_initialized' };
  }

  const cleanTo = extractEmailAddress(params.to);
  const aliasCheck = await checkAliasAllowed(params.env.DB, cleanTo || null);
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

  const hasOtp = Boolean(extracted.otpCode);
  const filter = await getEmailFilter(params.env.DB);
  if (
    !evaluateEmailFilter(filter, {
      from: params.from,
      to: cleanTo || params.to,
      subject: params.subject,
      body: extracted.cleanText,
      rawText: params.text,
      hasOtp,
      edgeSealed: false,
    })
  ) {
    return { accepted: false, reason: 'filtered' };
  }

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
  const record = await storeSealedEmail(params.env, {
    id,
    source: 'simulate',
    envelopeTo: cleanTo || null,
    hasOtp,
    sealedEnvelope,
    receivedAt,
    aliasId: aliasCheck.aliasId,
  });

  return { accepted: true, email: record };
}

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Direct Cloudflare Email Routing entrypoint when `nonepwd-cf-server` itself
 * receives Catch-All / domain alias mail. Parses MIME, runs filter rules, seals
 * via X25519 directly into D1+R2, and notifies active WebSocket clients via DO.
 */
export async function handleIncomingCfEmail(
  message: EmailMessageLike,
  env: CfServerEnv
): Promise<IngestResult> {
  await ensureSchema(env.DB);
  const rawBytes = await readStreamToBytes(message.raw);
  const result = await ingestRawEmail({
    env,
    rawMime: rawBytes,
    source: 'cloudflare',
    envelopeFrom: message.from,
    envelopeTo: message.to,
  });

  const forwardTarget = env.FORWARD_TO_EMAIL?.trim();
  if (result.accepted && forwardTarget) {
    await message.forward(forwardTarget);
  }

  return result;
}
