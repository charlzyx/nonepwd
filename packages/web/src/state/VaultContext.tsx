import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AAD,
  DEFAULT_KDF_ITERATIONS,
  decryptBytes,
  decryptJson,
  deriveAccountKeys,
  encodeServiceAccountToken,
  encryptBytes,
  encryptJson,
  fromBase64Url,
  generateEmailKeyPair,
  generateRawAesKey,
  generateSecretKey,
  itemImportFingerprint,
  openSealedJson,
  parseAuthenticatorExport,
  parsePasswordCsv,
  planTotpImport,
  randomBytes,
  randomId,
  toBase64Url,
  type AliasRecord,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type EncryptedItemRecord,
  type EncryptedVaultRecord,
  type ImapConfigPublic,
  type RootKeysetPayload,
  type ServiceAccountRecord,
  type VaultItemPayload,
  type VaultMetadata,
} from '@nonepwd/core';

export interface DecryptedVault {
  id: string;
  metadata: VaultMetadata;
  keyBytes: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedEmailItem extends DecryptedEmailPayload {
  id: string;
  source: EncryptedEmailRecord['source'];
  envelopeTo: string | null;
}

export interface AccountInfo {
  email: string;
  emailPublicKey: string;
  cfWebhookSecret: string;
  aliasDomain: string;
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

export interface ImapAccountPublic {
  id: string;
  label: string;
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  hasPassword: boolean;
  status: 'disabled' | 'connecting' | 'listening' | 'error';
  lastError: string | null;
  lastSyncAt: string | null;
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

export type AuthPhase = 'loading' | 'uninitialized' | 'locked' | 'unlocked' | 'standalone';

const TRUSTED_DEVICE_KEY = 'nonepwd.trusted_device.v1';
const CUSTOM_GROUPS_KEY = 'nonepwd.custom_groups.v1';
const COPIED_EMAIL_EXPIRATIONS_KEY = 'nonepwd.copied_email_expirations.v1';
const COPIED_EMAIL_TTL_MS = 5 * 60_000;

function loadCopiedEmailExpirations(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COPIED_EMAIL_EXPIRATIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveCopiedEmailExpirations(map: Record<string, number>): void {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(COPIED_EMAIL_EXPIRATIONS_KEY);
    } else {
      localStorage.setItem(COPIED_EMAIL_EXPIRATIONS_KEY, JSON.stringify(map));
    }
  } catch {
    // ignore storage failures
  }
}

interface TrustedDevicePrefs {
  email: string;
  secretKey: string;
}

function loadTrustedDevice(): TrustedDevicePrefs | null {
  try {
    const raw = localStorage.getItem(TRUSTED_DEVICE_KEY);
    return raw ? (JSON.parse(raw) as TrustedDevicePrefs) : null;
  } catch {
    return null;
  }
}

function saveTrustedDevice(prefs: TrustedDevicePrefs | null): void {
  try {
    if (!prefs) localStorage.removeItem(TRUSTED_DEVICE_KEY);
    else localStorage.setItem(TRUSTED_DEVICE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage failures
  }
}

function loadCustomGroups(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return [];
  }
}

function saveCustomGroups(groups: string[]): void {
  try {
    localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // ignore storage failures
  }
}

function normalizeImapAccounts(
  imapAccounts: ImapAccountPublic[] | undefined,
  imapStatus: ImapConfigPublic | null | undefined
): ImapAccountPublic[] {
  if (Array.isArray(imapAccounts)) {
    return imapAccounts;
  }
  if (imapStatus && (imapStatus.host || imapStatus.username || imapStatus.enabled)) {
    return [
      {
        id: 'legacy-1',
        label: imapStatus.username || imapStatus.host || '默认邮箱',
        enabled: imapStatus.enabled,
        host: imapStatus.host,
        port: imapStatus.port,
        tls: imapStatus.tls,
        username: imapStatus.username,
        hasPassword: imapStatus.hasPassword,
        status: imapStatus.status,
        lastError: imapStatus.lastError,
        lastSyncAt: null,
      },
    ];
  }
  return [];
}

interface VaultContextValue {
  phase: AuthPhase;
  wsConnected: boolean;
  knownEmail: string | null;
  trustedSecretKey: string | null;
  account: AccountInfo | null;
  vaults: DecryptedVault[];
  items: VaultItemPayload[];
  aliases: AliasRecord[];
  emails: DecryptedEmailItem[];
  serviceAccounts: ServiceAccountRecord[];
  imapConfig: ImapConfigPublic | null;
  imapAccounts: ImapAccountPublic[];
  customGroups: string[];
  allGroups: string[];
  securityIssues: Record<string, string>;
  error: string | null;
  clearError(): void;
  setupAccount(params: {
    email: string;
    masterPassword: string;
    secretKey: string;
    aliasDomain: string;
    rememberDevice: boolean;
  }): Promise<void>;
  unlock(params: {
    masterPassword: string;
    secretKey: string;
    rememberDevice: boolean;
  }): Promise<void>;
  lock(): Promise<void>;
  forgetTrustedDevice(): void;
  refreshAll(): Promise<void>;
  createVault(name: string, description?: string): Promise<DecryptedVault>;
  saveItem(item: VaultItemPayload, isNew?: boolean): Promise<VaultItemPayload>;
  importCsvItems(params: {
    vaultId: string;
    csvText: string;
    skipDuplicates?: boolean;
  }): Promise<{ total: number; imported: number; skipped: number }>;
  importTotpItems(params: {
    vaultId: string;
    text: string;
  }): Promise<{ total: number; attached: number; created: number; skipped: number }>;
  deleteItem(vaultId: string, itemId: string): Promise<void>;
  createAlias(params: {
    siteDomain: string;
    address?: string;
    vaultId?: string;
    itemId?: string;
  }): Promise<AliasRecord>;
  toggleAlias(id: string, enabled: boolean): Promise<void>;
  deleteAlias(id: string): Promise<void>;
  deleteEmail(id: string): Promise<void>;
  scheduleEmailAutoDelete(id: string): void;
  createServiceAccount(
    name: string,
    vaultIds: string[]
  ): Promise<{ serviceAccount: ServiceAccountRecord; token: string }>;
  revokeServiceAccount(id: string): Promise<void>;
  updateSettings(params: { aliasDomain?: string; rotateWebhookSecret?: boolean }): Promise<void>;
  saveImapConfig(params: {
    enabled: boolean;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password?: string;
  }): Promise<void>;
  saveImapAccount(params: {
    id?: string;
    label?: string;
    enabled: boolean;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password?: string;
  }): Promise<ImapAccountPublic>;
  deleteImapAccount(id: string): Promise<void>;
  testImapConfig(params: {
    id?: string;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password?: string;
  }): Promise<{ ok: boolean; messages?: number; error?: string }>;
  syncImapNow(accountId?: string): Promise<{ ok: boolean; synced?: number; error?: string | null }>;
  addGroup(name: string): void;
  removeGroup(name: string): Promise<void>;
  toggleItemGroup(item: VaultItemPayload, group: string): Promise<void>;
  getEmailFilter(): Promise<EmailFilterConfig>;
  saveEmailFilter(config: EmailFilterConfig): Promise<EmailFilterConfig>;
  listBackups(): Promise<{ enabled: boolean; backups: R2BackupMeta[] }>;
  createBackup(): Promise<R2BackupMeta>;
  restoreBackup(key?: string): Promise<{ restored: boolean; key: string; vaultCount: number; itemCount: number; emailCount: number }>;
  deleteBackup(key: string): Promise<void>;
  generateNewSecretKey(): string;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error('useVault must be used within VaultProvider');
  return ctx;
}

export const VaultProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [wsConnected, setWsConnected] = useState(false);
  const [knownEmail, setKnownEmail] = useState<string | null>(null);
  const [trustedSecretKey, setTrustedSecretKey] = useState<string | null>(
    () => loadTrustedDevice()?.secretKey ?? null
  );
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [vaults, setVaults] = useState<DecryptedVault[]>([]);
  const [items, setItems] = useState<VaultItemPayload[]>([]);
  const [aliases, setAliases] = useState<AliasRecord[]>([]);
  const [emails, setEmails] = useState<DecryptedEmailItem[]>([]);
  const [serviceAccounts, setServiceAccounts] = useState<ServiceAccountRecord[]>([]);
  const [imapConfig, setImapConfig] = useState<ImapConfigPublic | null>(null);
  const [imapAccounts, setImapAccounts] = useState<ImapAccountPublic[]>([]);
  const [customGroups, setCustomGroups] = useState<string[]>(() => loadCustomGroups());
  const [error, setError] = useState<string | null>(null);

  const sessionTokenRef = useRef<string | null>(null);
  const rootKeyRef = useRef<Uint8Array | null>(null);
  const emailPrivKeyRef = useRef<string | null>(null);
  const vaultKeysRef = useRef<Map<string, Uint8Array>>(new Map());
  const syncCursorRef = useRef<string | null>(null);
  const syncEpochRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const copiedEmailExpirationsRef = useRef<Record<string, number>>(loadCopiedEmailExpirations());
  const deletingExpiredEmailsRef = useRef<Set<string>>(new Set());

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (sessionTokenRef.current) {
      headers.Authorization = `Bearer ${sessionTokenRef.current}`;
    }
    if (init?.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, { ...init, headers });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
    if (!res.ok) {
      throw new Error(json.error ?? `Request failed (${res.status})`);
    }
    return json;
  }, []);

  const decryptEmailRecord = useCallback(
    async (rec: EncryptedEmailRecord): Promise<DecryptedEmailItem | null> => {
      const priv = emailPrivKeyRef.current;
      if (!priv) return null;
      try {
        const opened = await openSealedJson<DecryptedEmailPayload>(priv, rec.sealedEnvelope);
        return {
          ...opened,
          id: rec.id,
          source: rec.source,
          envelopeTo: rec.envelopeTo,
        };
      } catch {
        return null;
      }
    },
    []
  );

  const refreshAll = useCallback(async () => {
    const rootKey = rootKeyRef.current;
    if (!rootKey || !sessionTokenRef.current) return;

    const params = new URLSearchParams();
    if (syncCursorRef.current) {
      params.set('since', syncCursorRef.current);
      if (syncEpochRef.current) params.set('epoch', String(syncEpochRef.current));
    }
    const syncQuery = params.toString();
    const syncPath = syncQuery ? `/api/sync?${syncQuery}` : '/api/sync';

    const [syncData, saData] = await Promise.all([
      apiFetch<{
        incremental?: boolean;
        cursor?: string;
        epoch?: number;
        account: AccountInfo;
        vaults: EncryptedVaultRecord[];
        items: EncryptedItemRecord[];
        aliases: AliasRecord[];
        emails: EncryptedEmailRecord[];
        deleted?: {
          vaults?: string[];
          items?: string[];
          aliases?: string[];
          emails?: string[];
        };
        imapStatus: ImapConfigPublic;
        imapAccounts?: ImapAccountPublic[];
      }>(syncPath),
      apiFetch<{ serviceAccounts: ServiceAccountRecord[] }>('/api/service-accounts'),
    ]);

    const incremental = syncData.incremental === true;
    const keyMap = incremental ? new Map(vaultKeysRef.current) : new Map<string, Uint8Array>();
    const decryptedVaults: DecryptedVault[] = [];
    for (const v of syncData.vaults ?? []) {
      const vk = await decryptBytes(rootKey, v.encryptedKey, AAD.vaultOwnerKey(v.id));
      const meta = await decryptJson<VaultMetadata>(vk, v.encryptedMeta, AAD.vaultMeta(v.id));
      keyMap.set(v.id, vk);
      decryptedVaults.push({
        id: v.id,
        metadata: meta,
        keyBytes: vk,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      });
    }
    const deletedVaults = syncData.deleted?.vaults ?? [];
    for (const id of deletedVaults) keyMap.delete(id);
    vaultKeysRef.current = keyMap;

    const decryptedItems: VaultItemPayload[] = [];
    for (const it of syncData.items ?? []) {
      const vk = keyMap.get(it.vaultId);
      if (!vk) continue;
      try {
        const payload = await decryptJson<VaultItemPayload>(
          vk,
          it.encryptedData,
          AAD.vaultItem(it.vaultId, it.id)
        );
        decryptedItems.push(payload);
      } catch {
        // skip unreadable item
      }
    }

    const decryptedEmails: DecryptedEmailItem[] = [];
    for (const em of syncData.emails ?? []) {
      const opened = await decryptEmailRecord(em);
      if (opened) decryptedEmails.push(opened);
    }

    const deletedItems = new Set(syncData.deleted?.items ?? []);
    const deletedEmails = new Set(syncData.deleted?.emails ?? []);

    if (!incremental) {
      setVaults(decryptedVaults);
      setItems(decryptedItems);
      setEmails(decryptedEmails);
    } else {
      setVaults((prev) => {
        const map = new Map(prev.map((v) => [v.id, v]));
        for (const v of decryptedVaults) map.set(v.id, v);
        for (const id of deletedVaults) map.delete(id);
        return [...map.values()];
      });
      setItems((prev) => {
        const map = new Map(prev.map((item) => [item.id, item]));
        for (const item of decryptedItems) map.set(item.id, item);
        for (const id of deletedItems) map.delete(id);
        if (deletedVaults.length > 0) {
          for (const [id, item] of map) {
            if (deletedVaults.includes(item.vaultId)) map.delete(id);
          }
        }
        return [...map.values()];
      });
      setEmails((prev) => {
        const map = new Map(prev.map((email) => [email.id, email]));
        for (const email of decryptedEmails) map.set(email.id, email);
        for (const id of deletedEmails) map.delete(id);
        return [...map.values()]
          .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
          .slice(0, 100);
      });
    }

    if (syncData.cursor) syncCursorRef.current = syncData.cursor;
    if (typeof syncData.epoch === 'number') syncEpochRef.current = syncData.epoch;
    setAccount(syncData.account);
    setAliases(syncData.aliases ?? []);
    setImapConfig(syncData.imapStatus);
    setImapAccounts(normalizeImapAccounts(syncData.imapAccounts, syncData.imapStatus));
    setServiceAccounts(saData.serviceAccounts);
  }, [apiFetch, decryptEmailRecord]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const token = sessionTokenRef.current;
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => {
      setWsConnected(false);
    };
    ws.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as {
          type: string;
          email?: EncryptedEmailRecord;
          alias?: AliasRecord;
          id?: string;
          status?: ImapConfigPublic['status'];
          lastError?: string | null;
        };
        if (msg.type === 'email.received' && msg.email) {
          const opened = await decryptEmailRecord(msg.email);
          if (opened) {
            setEmails((prev) => [opened, ...prev.filter((e) => e.id !== opened.id)].slice(0, 100));
          }
          // Also refresh alias counts silently
          const aliasRes = await apiFetch<{ aliases: AliasRecord[] }>('/api/aliases');
          setAliases(aliasRes.aliases);
        } else if (msg.type === 'email.deleted' && msg.id) {
          const deletedId = msg.id;
          setEmails((prev) => prev.filter((e) => e.id !== deletedId));
          if (deletedId in copiedEmailExpirationsRef.current) {
            delete copiedEmailExpirationsRef.current[deletedId];
            saveCopiedEmailExpirations(copiedEmailExpirationsRef.current);
          }
        } else if (msg.type === 'alias.upserted' && msg.alias) {
          const upserted = msg.alias;
          setAliases((prev) => [upserted, ...prev.filter((a) => a.id !== upserted.id)]);
        } else if (msg.type === 'alias.deleted' && msg.id) {
          setAliases((prev) => prev.filter((a) => a.id !== msg.id));
        } else if (msg.type === 'imap.status' && msg.status) {
          const accountId = (msg as { accountId?: string }).accountId;
          setImapConfig((prev) =>
            prev ? { ...prev, status: msg.status!, lastError: msg.lastError ?? null } : prev
          );
          setImapAccounts((prev) =>
            prev.map((acc) => {
              if (accountId ? acc.id === accountId : prev.length === 1 && acc.id === 'legacy-1') {
                return { ...acc, status: msg.status!, lastError: msg.lastError ?? null };
              }
              return acc;
            })
          );
        } else if (
          msg.type === 'item.upserted' ||
          msg.type === 'item.deleted' ||
          msg.type === 'vault.upserted' ||
          msg.type === 'vault.deleted'
        ) {
          void refreshAll();
        }
      } catch {
        // ignore ws message parse error
      }
    };
  }, [apiFetch, decryptEmailRecord, refreshAll]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const res = await fetch('/api/auth/params');
        const contentType = res.headers.get('content-type') ?? '';
        if (!res.ok || !contentType.includes('application/json')) {
          if (!cancelled) setPhase('standalone');
          return;
        }
        const data = (await res.json()) as {
          initialized?: boolean;
          email?: string;
          staticSite?: boolean;
        };
        if (cancelled) return;
        if (data.staticSite) {
          setPhase('standalone');
        } else if (!data.initialized) {
          setPhase('uninitialized');
        } else {
          setKnownEmail(data.email ?? loadTrustedDevice()?.email ?? null);
          setPhase('locked');
        }
      } catch (err) {
        if (!cancelled) {
          const host = typeof window !== 'undefined' ? window.location.hostname : '';
          if (host.endsWith('.workers.dev') || host.endsWith('.pages.dev')) {
            setPhase('standalone');
          } else {
            setError(err instanceof Error ? err.message : 'Unable to reach nonepwd server');
            setPhase('locked');
          }
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  const setupAccount = useCallback<VaultContextValue['setupAccount']>(
    async ({ email, masterPassword, secretKey, aliasDomain, rememberDevice }) => {
      setError(null);
      const kdfSalt = toBase64Url(randomBytes(16));
      const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
        masterPassword,
        secretKey,
        kdfSalt,
        DEFAULT_KDF_ITERATIONS
      );

      const rootKeyBytes = generateRawAesKey();
      const emailKp = await generateEmailKeyPair();
      const keyset: RootKeysetPayload = {
        rootKeyB64: toBase64Url(rootKeyBytes),
        emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
      };
      const encryptedRootKeyset = await encryptJson(masterUnlockKeyBytes, keyset, AAD.ROOT_KEYSET);

      const initialDefs: VaultMetadata[] = [
        { name: 'Personal', description: '个人网站登录、银行与日常账号' },
        { name: 'DevOps', description: 'API Keys、服务器、环境变量与 CLI 凭据' },
      ];
      const initialVaults = await Promise.all(
        initialDefs.map(async (meta) => {
          const id = randomId();
          const vk = generateRawAesKey();
          return {
            id,
            encryptedKey: await encryptBytes(rootKeyBytes, vk, AAD.vaultOwnerKey(id)),
            encryptedMeta: await encryptJson(vk, meta, AAD.vaultMeta(id)),
          };
        })
      );

      const res = await apiFetch<{ token: string; account: AccountInfo }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({
          email,
          kdfSalt,
          kdfIterations: DEFAULT_KDF_ITERATIONS,
          authVerifier: authVerifierB64,
          encryptedRootKeyset,
          emailPublicKey: emailKp.publicKeyB64,
          aliasDomain,
          vaults: initialVaults,
        }),
      });

      sessionTokenRef.current = res.token;
      rootKeyRef.current = rootKeyBytes;
      emailPrivKeyRef.current = emailKp.privateKeyPkcs8B64;

      if (rememberDevice) {
        saveTrustedDevice({ email: res.account.email, secretKey });
        setTrustedSecretKey(secretKey);
      }
      setKnownEmail(res.account.email);
      await refreshAll();
      connectWebSocket();
      setPhase('unlocked');
    },
    [apiFetch, connectWebSocket, refreshAll]
  );

  const unlock = useCallback<VaultContextValue['unlock']>(
    async ({ masterPassword, secretKey, rememberDevice }) => {
      setError(null);
      const params = await apiFetch<{
        initialized: boolean;
        email?: string;
        kdfSalt?: string;
        kdfIterations?: number;
      }>('/api/auth/params');

      if (!params.initialized || !params.kdfSalt || !params.kdfIterations) {
        setPhase('uninitialized');
        throw new Error('Server is not initialized yet');
      }

      const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
        masterPassword,
        secretKey,
        params.kdfSalt,
        params.kdfIterations
      );

      const loginRes = await apiFetch<{
        token: string;
        account: {
          email: string;
          encryptedRootKeyset: string;
        };
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ authVerifier: authVerifierB64 }),
      });

      const keyset = await decryptJson<RootKeysetPayload>(
        masterUnlockKeyBytes,
        loginRes.account.encryptedRootKeyset,
        AAD.ROOT_KEYSET
      );

      sessionTokenRef.current = loginRes.token;
      rootKeyRef.current = fromBase64Url(keyset.rootKeyB64);
      emailPrivKeyRef.current = keyset.emailPrivateKeyPkcs8B64;

      if (rememberDevice) {
        saveTrustedDevice({ email: loginRes.account.email, secretKey });
        setTrustedSecretKey(secretKey);
      }
      setKnownEmail(loginRes.account.email);
      await refreshAll();
      connectWebSocket();
      setPhase('unlocked');
    },
    [apiFetch, connectWebSocket, refreshAll]
  );

  const lock = useCallback(async () => {
    try {
      if (sessionTokenRef.current) {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      }
    } catch {
      // ignore
    }
    wsRef.current?.close();
    wsRef.current = null;
    sessionTokenRef.current = null;
    rootKeyRef.current = null;
    emailPrivKeyRef.current = null;
    vaultKeysRef.current = new Map();
    syncCursorRef.current = null;
    syncEpochRef.current = null;
    setWsConnected(false);
    setVaults([]);
    setItems([]);
    setAliases([]);
    setEmails([]);
    setServiceAccounts([]);
    setImapConfig(null);
    setImapAccounts([]);
    setPhase('locked');
  }, [apiFetch]);

  const forgetTrustedDevice = useCallback(() => {
    saveTrustedDevice(null);
    setTrustedSecretKey(null);
  }, []);

  const createVault = useCallback<VaultContextValue['createVault']>(
    async (name, description) => {
      const rootKey = rootKeyRef.current;
      if (!rootKey) throw new Error('Vault is locked');
      const id = randomId();
      const keyBytes = generateRawAesKey();
      const metadata: VaultMetadata = { name: name.trim(), description };
      const encryptedKey = await encryptBytes(rootKey, keyBytes, AAD.vaultOwnerKey(id));
      const encryptedMeta = await encryptJson(keyBytes, metadata, AAD.vaultMeta(id));

      const res = await apiFetch<{ vault: EncryptedVaultRecord }>('/api/vaults', {
        method: 'POST',
        body: JSON.stringify({ id, encryptedKey, encryptedMeta }),
      });
      vaultKeysRef.current.set(id, keyBytes);
      const created: DecryptedVault = {
        id,
        metadata,
        keyBytes,
        createdAt: res.vault.createdAt,
        updatedAt: res.vault.updatedAt,
      };
      setVaults((prev) => [...prev, created]);
      return created;
    },
    [apiFetch]
  );

  const saveItem = useCallback<VaultContextValue['saveItem']>(
    async (item, isNew) => {
      const vk = vaultKeysRef.current.get(item.vaultId);
      if (!vk) throw new Error('Missing vault key');
      const now = new Date().toISOString();
      const payload: VaultItemPayload = {
        ...item,
        createdAt: item.createdAt || now,
        updatedAt: now,
      };
      const encryptedData = await encryptJson(vk, payload, AAD.vaultItem(payload.vaultId, payload.id));

      if (isNew) {
        await apiFetch(`/api/vaults/${payload.vaultId}/items`, {
          method: 'POST',
          body: JSON.stringify({ id: payload.id, encryptedData }),
        });
      } else {
        await apiFetch(`/api/vaults/${payload.vaultId}/items/${payload.id}`, {
          method: 'PUT',
          body: JSON.stringify({ encryptedData }),
        });
      }

      setItems((prev) => [payload, ...prev.filter((i) => i.id !== payload.id)]);
      return payload;
    },
    [apiFetch]
  );

  const importCsvItems = useCallback<VaultContextValue['importCsvItems']>(
    async ({ vaultId, csvText, skipDuplicates = true }) => {
      const vk = vaultKeysRef.current.get(vaultId);
      if (!vk) throw new Error('密码库已锁定或未找到密钥');

      const entries = parsePasswordCsv(csvText);
      const seen = new Set<string>();
      if (skipDuplicates) {
        for (const existing of items) {
          if (existing.vaultId === vaultId) {
            seen.add(itemImportFingerprint(existing));
          }
        }
      }

      const now = new Date().toISOString();
      const batch: Array<{ id: string; encryptedData: string }> = [];
      const createdPayloads: VaultItemPayload[] = [];
      let skipped = 0;

      for (const entry of entries) {
        const fp = itemImportFingerprint(entry);
        if (skipDuplicates && seen.has(fp)) {
          skipped++;
          continue;
        }
        seen.add(fp);

        const id = randomId();
        const payload: VaultItemPayload = {
          id,
          vaultId,
          category: entry.category,
          title: entry.title,
          favorite: false,
          tags: [],
          urls: entry.urls,
          username: entry.username,
          password: entry.password,
          totp: entry.totp,
          notes: entry.notes,
          customFields: [],
          createdAt: now,
          updatedAt: now,
        };
        const encryptedData = await encryptJson(vk, payload, AAD.vaultItem(vaultId, id));
        batch.push({ id, encryptedData });
        createdPayloads.push(payload);
      }

      if (batch.length > 0) {
        await apiFetch(`/api/vaults/${vaultId}/items/batch`, {
          method: 'POST',
          body: JSON.stringify({ items: batch }),
        });
        setItems((prev) => [...createdPayloads, ...prev]);
      }

      return {
        total: entries.length,
        imported: batch.length,
        skipped,
      };
    },
    [apiFetch, items]
  );

  const importTotpItems = useCallback<VaultContextValue['importTotpItems']>(
    async ({ vaultId, text }) => {
      const vk = vaultKeysRef.current.get(vaultId);
      if (!vk) throw new Error('密码库已锁定或未找到密钥');

      const entries = parseAuthenticatorExport(text);
      const vaultItems = items.filter((i) => i.vaultId === vaultId);
      const plan = planTotpImport(vaultItems, entries);

      const now = new Date().toISOString();
      const updatedMap = new Map<string, VaultItemPayload>();
      const batch: Array<{ id: string; encryptedData: string }> = [];
      const createdPayloads: VaultItemPayload[] = [];
      let attached = 0;
      let skipped = 0;

      for (const step of plan) {
        if (step.action === 'skip_duplicate') {
          skipped++;
          continue;
        }
        if (step.action === 'attach') {
          const existing =
            updatedMap.get(step.itemId) ?? vaultItems.find((i) => i.id === step.itemId);
          if (!existing) {
            skipped++;
            continue;
          }
          const updated: VaultItemPayload = {
            ...existing,
            totp: step.otpauthUri,
            updatedAt: now,
          };
          const encryptedData = await encryptJson(
            vk,
            updated,
            AAD.vaultItem(vaultId, updated.id)
          );
          await apiFetch(`/api/vaults/${vaultId}/items/${updated.id}`, {
            method: 'PUT',
            body: JSON.stringify({ encryptedData }),
          });
          updatedMap.set(updated.id, updated);
          attached++;
          continue;
        }
        if (step.action === 'create') {
          const id = randomId();
          const payload: VaultItemPayload = {
            id,
            vaultId,
            category: 'login',
            title: step.title,
            favorite: false,
            tags: [],
            urls: [],
            username: step.username,
            totp: step.totp,
            customFields: [],
            createdAt: now,
            updatedAt: now,
          };
          const encryptedData = await encryptJson(vk, payload, AAD.vaultItem(vaultId, id));
          batch.push({ id, encryptedData });
          createdPayloads.push(payload);
        }
      }

      if (batch.length > 0) {
        await apiFetch(`/api/vaults/${vaultId}/items/batch`, {
          method: 'POST',
          body: JSON.stringify({ items: batch }),
        });
      }

      if (updatedMap.size > 0 || createdPayloads.length > 0) {
        setItems((prev) => [
          ...createdPayloads,
          ...prev.map((it) => updatedMap.get(it.id) ?? it),
        ]);
      }

      return {
        total: entries.length,
        attached,
        created: createdPayloads.length,
        skipped,
      };
    },
    [apiFetch, items]
  );

  const deleteItem = useCallback<VaultContextValue['deleteItem']>(
    async (vaultId, itemId) => {
      await apiFetch(`/api/vaults/${vaultId}/items/${itemId}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((i) => i.id !== itemId));
    },
    [apiFetch]
  );

  const createAlias = useCallback<VaultContextValue['createAlias']>(
    async (params) => {
      const res = await apiFetch<{ alias: AliasRecord }>('/api/aliases', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      setAliases((prev) => [res.alias, ...prev.filter((a) => a.id !== res.alias.id)]);
      return res.alias;
    },
    [apiFetch]
  );

  const toggleAlias = useCallback<VaultContextValue['toggleAlias']>(
    async (id, enabled) => {
      const res = await apiFetch<{ alias: AliasRecord }>(`/api/aliases/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      setAliases((prev) => prev.map((a) => (a.id === id ? res.alias : a)));
    },
    [apiFetch]
  );

  const deleteAlias = useCallback<VaultContextValue['deleteAlias']>(
    async (id) => {
      await apiFetch(`/api/aliases/${id}`, { method: 'DELETE' });
      setAliases((prev) => prev.filter((a) => a.id !== id));
    },
    [apiFetch]
  );

  const deleteEmail = useCallback<VaultContextValue['deleteEmail']>(
    async (id) => {
      try {
        await apiFetch(`/api/emails/${id}`, { method: 'DELETE' });
      } finally {
        setEmails((prev) => prev.filter((e) => e.id !== id));
        if (id in copiedEmailExpirationsRef.current) {
          delete copiedEmailExpirationsRef.current[id];
          saveCopiedEmailExpirations(copiedEmailExpirationsRef.current);
        }
      }
    },
    [apiFetch]
  );

  const scheduleEmailAutoDelete = useCallback<VaultContextValue['scheduleEmailAutoDelete']>(
    (id) => {
      const cleanId = id.trim();
      if (!cleanId) return;
      const existing = copiedEmailExpirationsRef.current[cleanId];
      if (typeof existing === 'number' && existing > Date.now()) {
        return;
      }
      copiedEmailExpirationsRef.current[cleanId] = Date.now() + COPIED_EMAIL_TTL_MS;
      saveCopiedEmailExpirations(copiedEmailExpirationsRef.current);
    },
    []
  );

  const purgeExpiredCopiedEmails = useCallback(() => {
    if (phase !== 'unlocked' || !sessionTokenRef.current) return;
    const map = copiedEmailExpirationsRef.current;
    const now = Date.now();
    const expiredIds = Object.entries(map)
      .filter(([, exp]) => typeof exp === 'number' && exp <= now)
      .map(([id]) => id);
    if (expiredIds.length === 0) return;

    let mapChanged = false;
    for (const id of expiredIds) {
      if (deletingExpiredEmailsRef.current.has(id)) continue;
      const stillPresent = emails.some((em) => em.id === id);
      if (stillPresent) {
        deletingExpiredEmailsRef.current.add(id);
        void deleteEmail(id)
          .catch(() => {
            // ignore 404 or transient errors
          })
          .finally(() => {
            deletingExpiredEmailsRef.current.delete(id);
          });
      } else {
        delete map[id];
        mapChanged = true;
      }
    }
    if (mapChanged) {
      saveCopiedEmailExpirations(map);
    }
  }, [deleteEmail, emails, phase]);

  useEffect(() => {
    if (phase !== 'unlocked') return;
    purgeExpiredCopiedEmails();
    const timer = window.setInterval(purgeExpiredCopiedEmails, 10_000);
    return () => window.clearInterval(timer);
  }, [phase, purgeExpiredCopiedEmails]);

  const createServiceAccount = useCallback<VaultContextValue['createServiceAccount']>(
    async (name, vaultIds) => {
      const saId = `sa_${randomId().replace(/-/g, '').slice(0, 16)}`;
      const authSecret = toBase64Url(randomBytes(24));
      const wrapKey = generateRawAesKey();

      const vaultKeys = await Promise.all(
        vaultIds.map(async (vid) => {
          const vk = vaultKeysRef.current.get(vid);
          if (!vk) throw new Error(`Missing key for vault ${vid}`);
          return {
            vaultId: vid,
            encryptedVaultKey: await encryptBytes(wrapKey, vk, AAD.vaultSaKey(vid, saId)),
          };
        })
      );

      const res = await apiFetch<{ serviceAccount: ServiceAccountRecord }>('/api/service-accounts', {
        method: 'POST',
        body: JSON.stringify({ id: saId, name, authSecret, vaultKeys }),
      });

      setServiceAccounts((prev) => [res.serviceAccount, ...prev]);

      const token = encodeServiceAccountToken({
        v: 1,
        serverUrl: window.location.origin,
        tokenId: saId,
        authSecret,
        wrapKeyB64: toBase64Url(wrapKey),
      });

      return { serviceAccount: res.serviceAccount, token };
    },
    [apiFetch]
  );

  const revokeServiceAccount = useCallback<VaultContextValue['revokeServiceAccount']>(
    async (id) => {
      await apiFetch(`/api/service-accounts/${id}`, { method: 'DELETE' });
      setServiceAccounts((prev) => prev.filter((s) => s.id !== id));
    },
    [apiFetch]
  );

  const updateSettings = useCallback<VaultContextValue['updateSettings']>(
    async (params) => {
      const res = await apiFetch<{ settings: AccountInfo }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(params),
      });
      setAccount(res.settings);
    },
    [apiFetch]
  );

  const saveImapConfig = useCallback<VaultContextValue['saveImapConfig']>(
    async (params) => {
      const res = await apiFetch<{
        imap: ImapConfigPublic;
        accounts?: ImapAccountPublic[];
      }>('/api/imap', {
        method: 'PUT',
        body: JSON.stringify(params),
      });
      setImapConfig(res.imap);
      if (Array.isArray(res.accounts)) {
        setImapAccounts(res.accounts);
      }
      await refreshAll();
    },
    [apiFetch, refreshAll]
  );

  const saveImapAccount = useCallback<VaultContextValue['saveImapAccount']>(
    async (params) => {
      const isEdit = Boolean(params.id);
      const path = isEdit
        ? `/api/imap/accounts/${encodeURIComponent(params.id!)}`
        : '/api/imap/accounts';
      const res = await apiFetch<{
        account: ImapAccountPublic;
        accounts?: ImapAccountPublic[];
        imap?: ImapConfigPublic;
      }>(path, {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(params),
      });
      if (Array.isArray(res.accounts)) {
        setImapAccounts(res.accounts);
      } else if (res.account) {
        setImapAccounts((prev) => {
          const exists = prev.some((a) => a.id === res.account.id);
          return exists
            ? prev.map((a) => (a.id === res.account.id ? res.account : a))
            : [...prev, res.account];
        });
      }
      if (res.imap) {
        setImapConfig(res.imap);
      }
      await refreshAll();
      return res.account;
    },
    [apiFetch, refreshAll]
  );

  const deleteImapAccount = useCallback<VaultContextValue['deleteImapAccount']>(
    async (id) => {
      const res = await apiFetch<{
        ok: boolean;
        accounts?: ImapAccountPublic[];
        imap?: ImapConfigPublic;
      }>(`/api/imap/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (Array.isArray(res.accounts)) {
        setImapAccounts(res.accounts);
      } else {
        setImapAccounts((prev) => prev.filter((a) => a.id !== id));
      }
      if (res.imap) {
        setImapConfig(res.imap);
      }
      await refreshAll();
    },
    [apiFetch, refreshAll]
  );

  const testImapConfig = useCallback<VaultContextValue['testImapConfig']>(
    async (params) => {
      return apiFetch<{ ok: boolean; messages?: number; error?: string }>('/api/imap/test', {
        method: 'POST',
        body: JSON.stringify(params),
      });
    },
    [apiFetch]
  );

  const syncImapNow = useCallback<VaultContextValue['syncImapNow']>(
    async (accountId) => {
      try {
        const res = await apiFetch<{
          ok: boolean;
          synced?: number;
          error?: string | null;
          accounts?: ImapAccountPublic[];
          imap?: ImapConfigPublic;
        }>('/api/imap/sync', {
          method: 'POST',
          body: accountId ? JSON.stringify({ id: accountId }) : undefined,
        });
        if (Array.isArray(res.accounts)) {
          setImapAccounts(res.accounts);
        }
        if (res.imap) {
          setImapConfig(res.imap);
        }
        await refreshAll();
        return {
          ok: Boolean(res.ok),
          synced: res.synced,
          error: res.error ?? null,
        };
      } catch (err) {
        try {
          await refreshAll();
        } catch {
          // ignore refresh errors when surfacing sync failure
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'IMAP 同步失败',
        };
      }
    },
    [apiFetch, refreshAll]
  );

  const addGroup = useCallback<VaultContextValue['addGroup']>((name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCustomGroups((prev) => {
      if (prev.some((g) => g.trim().toLowerCase() === trimmed.toLowerCase())) {
        return prev;
      }
      const next = [...prev, trimmed];
      saveCustomGroups(next);
      return next;
    });
  }, []);

  const removeGroup = useCallback<VaultContextValue['removeGroup']>(
    async (name) => {
      const target = name.trim().toLowerCase();
      if (!target) return;
      setCustomGroups((prev) => {
        const next = prev.filter((g) => g.trim().toLowerCase() !== target);
        saveCustomGroups(next);
        return next;
      });
      const affected = items.filter((item) =>
        item.tags.some((t) => t.trim().toLowerCase() === target)
      );
      for (const item of affected) {
        const nextTags = item.tags.filter((t) => t.trim().toLowerCase() !== target);
        try {
          await saveItem({ ...item, tags: nextTags }, false);
        } catch {
          // continue removing group from remaining items
        }
      }
    },
    [items, saveItem]
  );

  const toggleItemGroup = useCallback<VaultContextValue['toggleItemGroup']>(
    async (item, group) => {
      const trimmed = group.trim();
      if (!trimmed) return;
      addGroup(trimmed);
      const target = trimmed.toLowerCase();
      const exists = item.tags.some((t) => t.trim().toLowerCase() === target);
      const nextTags = exists
        ? item.tags.filter((t) => t.trim().toLowerCase() !== target)
        : [...item.tags, trimmed];
      await saveItem({ ...item, tags: nextTags }, false);
    },
    [addGroup, saveItem]
  );

  const allGroups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const raw of [...customGroups, ...items.flatMap((i) => i.tags)]) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, trimmed);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [customGroups, items]);

  const securityIssues = useMemo<Record<string, string>>(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.category === 'login' && item.password) {
        counts.set(item.password, (counts.get(item.password) ?? 0) + 1);
      }
    }
    const issues: Record<string, string> = {};
    for (const item of items) {
      if (item.category !== 'login' || !item.password) continue;
      if ((counts.get(item.password) ?? 0) > 1) {
        issues[item.id] = '重复使用密码';
      } else if (item.password.length < 10) {
        issues[item.id] = '弱密码（少于 10 位）';
      }
    }
    return issues;
  }, [items]);

  const getEmailFilter = useCallback<VaultContextValue['getEmailFilter']>(async () => {
    return apiFetch<EmailFilterConfig>('/api/email-filter');
  }, [apiFetch]);

  const saveEmailFilter = useCallback<VaultContextValue['saveEmailFilter']>(
    async (config) => {
      return apiFetch<EmailFilterConfig>('/api/email-filter', {
        method: 'PUT',
        body: JSON.stringify(config),
      });
    },
    [apiFetch]
  );

  const listBackups = useCallback<VaultContextValue['listBackups']>(async () => {
    return apiFetch<{ enabled: boolean; backups: R2BackupMeta[] }>('/api/backups');
  }, [apiFetch]);

  const createBackup = useCallback<VaultContextValue['createBackup']>(async () => {
    const res = await apiFetch<{ backup: R2BackupMeta }>('/api/backups', {
      method: 'POST',
    });
    return res.backup;
  }, [apiFetch]);

  const restoreBackup = useCallback<VaultContextValue['restoreBackup']>(
    async (key) => {
      const res = await apiFetch<{
        restored: boolean;
        key: string;
        vaultCount: number;
        itemCount: number;
        emailCount: number;
      }>('/api/backups/restore', {
        method: 'POST',
        body: JSON.stringify(key ? { key } : {}),
      });
      await refreshAll();
      return res;
    },
    [apiFetch, refreshAll]
  );

  const deleteBackup = useCallback<VaultContextValue['deleteBackup']>(
    async (key) => {
      await apiFetch<{ ok: boolean }>(`/api/backups/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
    },
    [apiFetch]
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      phase,
      wsConnected,
      knownEmail,
      trustedSecretKey,
      account,
      vaults,
      items,
      aliases,
      emails,
      serviceAccounts,
      imapConfig,
      imapAccounts,
      customGroups,
      allGroups,
      securityIssues,
      error,
      clearError: () => setError(null),
      setupAccount,
      unlock,
      lock,
      forgetTrustedDevice,
      refreshAll,
      createVault,
      saveItem,
      importCsvItems,
      importTotpItems,
      deleteItem,
      createAlias,
      toggleAlias,
      deleteAlias,
      deleteEmail,
      scheduleEmailAutoDelete,
      createServiceAccount,
      revokeServiceAccount,
      updateSettings,
      saveImapConfig,
      saveImapAccount,
      deleteImapAccount,
      testImapConfig,
      syncImapNow,
      addGroup,
      removeGroup,
      toggleItemGroup,
      getEmailFilter,
      saveEmailFilter,
      listBackups,
      createBackup,
      restoreBackup,
      deleteBackup,
      generateNewSecretKey: generateSecretKey,
    }),
    [
      phase,
      wsConnected,
      knownEmail,
      trustedSecretKey,
      account,
      vaults,
      items,
      aliases,
      emails,
      serviceAccounts,
      imapConfig,
      imapAccounts,
      customGroups,
      allGroups,
      securityIssues,
      error,
      setupAccount,
      unlock,
      lock,
      forgetTrustedDevice,
      refreshAll,
      createVault,
      saveItem,
      importCsvItems,
      importTotpItems,
      deleteItem,
      createAlias,
      toggleAlias,
      deleteAlias,
      deleteEmail,
      scheduleEmailAutoDelete,
      createServiceAccount,
      revokeServiceAccount,
      updateSettings,
      saveImapConfig,
      saveImapAccount,
      deleteImapAccount,
      testImapConfig,
      syncImapNow,
      addGroup,
      removeGroup,
      toggleItemGroup,
      getEmailFilter,
      saveEmailFilter,
      listBackups,
      createBackup,
      restoreBackup,
      deleteBackup,
    ]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
};
