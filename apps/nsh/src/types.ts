export const DEFAULT_KDF_ITERATIONS = 600_000;
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

export type RememberDuration = "3h" | "24h" | "7d" | "session";

export type ItemCategory =
  | "login"
  | "api_credential"
  | "secure_note"
  | "ssh_key"
  | "card"
  | "identity";

export interface VaultMetadata {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface CardDetails {
  cardholderName?: string;
  number?: string;
  expMonth?: string;
  expYear?: string;
  cvv?: string;
  brand?: string;
}

export interface IdentityDetails {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface CustomField {
  id: string;
  label: string;
  value: string;
  type: "text" | "concealed" | "url" | "totp";
}

export interface VaultItemPayload {
  id: string;
  vaultId: string;
  category: ItemCategory;
  title: string;
  favorite: boolean;
  tags: string[];
  urls: string[];
  username?: string;
  password?: string;
  totp?: string;
  emailAlias?: string;
  notes?: string;
  card?: CardDetails;
  identity?: IdentityDetails;
  customFields: CustomField[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface RootKeysetPayload {
  rootKeyB64: string;
  emailPrivateKeyPkcs8B64: string;
}

export interface SealedEnvelope {
  v: 1;
  epk: string;
  iv: string;
  ct: string;
}

export interface DecryptedEmailPayload {
  id?: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  textBody: string;
  otpCode: string | null;
  confidence: number;
  magicLink: string | null;
  senderDomain: string;
  receivedAt: string;
}

export interface EncryptedVaultRecord {
  id: string;
  encryptedKey: string;
  encryptedMeta: string;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedItemRecord {
  id: string;
  vaultId: string;
  encryptedData: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface AliasRecord {
  id: string;
  address: string;
  siteDomain: string | null;
  vaultId: string | null;
  itemId: string | null;
  enabled: boolean;
  receivedCount: number;
  createdAt: string;
}

export interface EncryptedEmailRecord {
  id: string;
  source: "imap" | "cloudflare" | "simulate";
  envelopeTo: string | null;
  hasOtp: boolean;
  sealedEnvelope: SealedEnvelope;
  receivedAt: string;
}

export interface DecryptedVault {
  id: string;
  metadata: VaultMetadata;
  keyBytes: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedEmailItem extends DecryptedEmailPayload {
  id: string;
  source: EncryptedEmailRecord["source"];
  envelopeTo: string | null;
}

export interface AccountInfo {
  email: string;
  emailPublicKey: string;
  cfWebhookSecret: string;
  aliasDomain: string;
}

export type ImapAccountStatus = "disabled" | "connecting" | "listening" | "error";

export interface ImapConfigPublic {
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  hasPassword: boolean;
  status: ImapAccountStatus;
  lastError: string | null;
}

export interface ImapAccountPublic {
  id: string;
  label: string;
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  hasPassword: boolean;
  status: ImapAccountStatus;
  lastError: string | null;
  lastSyncAt: string | null;
}

export type EmailFilterMode = "allow" | "deny";
export type EmailFilterField = "from" | "to" | "subject" | "body";

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
