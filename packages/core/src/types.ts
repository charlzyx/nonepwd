export const DEFAULT_KDF_ITERATIONS = 600_000;

export interface VaultMetadata {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
}

export type ItemCategory =
  | 'login'
  | 'api_credential'
  | 'secure_note'
  | 'ssh_key'
  | 'card'
  | 'identity';

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
  type: 'text' | 'concealed' | 'url' | 'totp';
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

export interface ServiceAccountTokenPayload {
  v: 1;
  serverUrl: string;
  tokenId: string;
  authSecret: string;
  wrapKeyB64: string;
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
  source: 'imap' | 'cloudflare' | 'simulate';
  envelopeTo: string | null;
  hasOtp: boolean;
  sealedEnvelope: SealedEnvelope;
  receivedAt: string;
}

export interface ServiceAccountRecord {
  id: string;
  name: string;
  vaultIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export type ImapAccountStatus = 'disabled' | 'connecting' | 'listening' | 'error';

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
