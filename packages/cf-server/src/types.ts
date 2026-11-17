export interface CfServerEnv {
  DB: D1Database;
  BUCKET?: R2Bucket;
  WS_HUB?: DurableObjectNamespace;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  FORWARD_TO_EMAIL?: string;
}

export type EmailFilterMode = 'allow' | 'deny';
export type EmailFilterField = 'from' | 'to' | 'subject' | 'body';

export interface EmailFilterRule {
  id: string;
  field: EmailFilterField;
  pattern: string;
  enabled: boolean;
}

export interface EmailFilterConfig {
  enabled: boolean;
  otpOnly: boolean;
  mode: EmailFilterMode;
  rules: EmailFilterRule[];
}

export interface EmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  forward(rcptTo: string): Promise<void>;
}

export interface R2BackupMeta {
  key: string;
  size: number;
  uploadedAt: string;
  reason: string;
  vaultCount: number | null;
  itemCount: number | null;
  emailCount: number | null;
}
