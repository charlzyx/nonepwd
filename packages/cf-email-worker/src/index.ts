import PostalMime from 'postal-mime';
import {
  asBuffer,
  extractEmailAddress,
  extractEmailOtp,
  sealJsonForPublicKey,
  utf8Encode,
  type DecryptedEmailPayload,
} from '@nonepwd/core';

export interface NonePwdEmailWorkerEnv {
  NONEPWD_SERVER_URL: string;
  WEBHOOK_SECRET: string;
  RECIPIENT_X25519_PUBLIC_KEY?: string;
  FORWARD_TO_EMAIL?: string;
}

export interface EmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  forward(rcptTo: string): Promise<void>;
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

export async function signWebhookPayload(
  secret: string,
  timestamp: string,
  rawBody: Uint8Array
): Promise<string> {
  const prefix = utf8Encode(`${timestamp}.`);
  const signedData = new Uint8Array(prefix.length + rawBody.length);
  signedData.set(prefix, 0);
  signedData.set(rawBody, prefix.length);

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    asBuffer(utf8Encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, asBuffer(signedData))
  );

  const hex = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v1=${hex}`;
}

export async function processIncomingEmail(
  message: EmailMessageLike,
  env: NonePwdEmailWorkerEnv
): Promise<Response> {
  const rawBytes = await readStreamToBytes(message.raw);
  const serverBase = env.NONEPWD_SERVER_URL.replace(/\/+$/, '');
  const endpoint = `${serverBase}/api/webhooks/email/cf`;
  const timestamp = String(Math.floor(Date.now() / 1000));

  let bodyBytes: Uint8Array;
  const headers: Record<string, string> = {
    'X-NonePwd-Timestamp': timestamp,
    'X-NonePwd-Envelope-From': message.from,
    'X-NonePwd-Envelope-To': message.to,
  };

  if (env.RECIPIENT_X25519_PUBLIC_KEY && env.RECIPIENT_X25519_PUBLIC_KEY.trim()) {
    // Edge Zero-Knowledge Mode: parse MIME & seal on Cloudflare Edge before POSTing
    const parsed = await PostalMime.parse(rawBytes);
    const fromHeader =
      parsed.from?.address
        ? `${parsed.from.name ? `${parsed.from.name} ` : ''}<${parsed.from.address}>`
        : message.from;
    const toAddr = extractEmailAddress(message.to || parsed.to?.[0]?.address || '');
    const subject = parsed.subject ?? '(No Subject)';

    const extracted = extractEmailOtp({
      from: fromHeader,
      to: toAddr,
      subject,
      text: parsed.text ?? undefined,
      html: parsed.html ?? undefined,
    });

    const payload: DecryptedEmailPayload = {
      from: fromHeader,
      to: toAddr,
      subject,
      snippet: extracted.snippet,
      textBody: extracted.cleanText.slice(0, 6000),
      otpCode: extracted.otpCode,
      confidence: extracted.confidence,
      magicLink: extracted.magicLink,
      senderDomain: extracted.senderDomain,
      receivedAt: new Date().toISOString(),
    };

    const sealedEnvelope = await sealJsonForPublicKey(
      env.RECIPIENT_X25519_PUBLIC_KEY.trim(),
      payload
    );

    const jsonPayload = JSON.stringify({
      mode: 'edge_sealed',
      envelopeFrom: message.from,
      envelopeTo: toAddr,
      hasOtp: Boolean(extracted.otpCode),
      sealedEnvelope,
    });
    bodyBytes = utf8Encode(jsonPayload);
    headers['Content-Type'] = 'application/json';
  } else {
    bodyBytes = rawBytes;
    headers['Content-Type'] = 'message/rfc822';
  }

  headers['X-NonePwd-Signature'] = await signWebhookPayload(
    env.WEBHOOK_SECRET,
    timestamp,
    bodyBytes
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: asBuffer(bodyBytes),
  });

  if (env.FORWARD_TO_EMAIL && env.FORWARD_TO_EMAIL.trim()) {
    await message.forward(env.FORWARD_TO_EMAIL.trim());
  }

  return response;
}

export default {
  async email(
    message: EmailMessageLike,
    env: NonePwdEmailWorkerEnv,
    _ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<void> {
    const res = await processIncomingEmail(message, env);
    if (!res.ok) {
      throw new Error(`nonepwd webhook failed with status ${res.status}`);
    }
  },
};
