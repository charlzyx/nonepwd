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
  parsePasswordCsv,
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

export type AuthPhase = 'loading' | 'uninitialized' | 'locked' | 'unlocked' | 'standalone';

const TRUSTED_DEVICE_KEY = 'nonepwd.trusted_device.v1';

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
  testImapConfig(params: {
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password?: string;
  }): Promise<{ ok: boolean; messages?: number; error?: string }>;
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
  const [error, setError] = useState<string | null>(null);

  const sessionTokenRef = useRef<string | null>(null);
  const rootKeyRef = useRef<Uint8Array | null>(null);
  const emailPrivKeyRef = useRef<string | null>(null);
  const vaultKeysRef = useRef<Map<string, Uint8Array>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);

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

    const [syncData, saData] = await Promise.all([
      apiFetch<{
        account: AccountInfo;
        vaults: EncryptedVaultRecord[];
        items: EncryptedItemRecord[];
        aliases: AliasRecord[];
        emails: EncryptedEmailRecord[];
        imapStatus: ImapConfigPublic;
      }>('/api/sync'),
      apiFetch<{ serviceAccounts: ServiceAccountRecord[] }>('/api/service-accounts'),
    ]);

    const keyMap = new Map<string, Uint8Array>();
    const decryptedVaults: DecryptedVault[] = [];
    for (const v of syncData.vaults) {
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
    vaultKeysRef.current = keyMap;

    const decryptedItems: VaultItemPayload[] = [];
    for (const it of syncData.items) {
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
    for (const em of syncData.emails) {
      const opened = await decryptEmailRecord(em);
      if (opened) decryptedEmails.push(opened);
    }

    setAccount(syncData.account);
    setVaults(decryptedVaults);
    setItems(decryptedItems);
    setAliases(syncData.aliases);
    setEmails(decryptedEmails);
    setImapConfig(syncData.imapStatus);
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
        } else if (msg.type === 'alias.upserted' && msg.alias) {
          const upserted = msg.alias;
          setAliases((prev) => [upserted, ...prev.filter((a) => a.id !== upserted.id)]);
        } else if (msg.type === 'alias.deleted' && msg.id) {
          setAliases((prev) => prev.filter((a) => a.id !== msg.id));
        } else if (msg.type === 'imap.status' && msg.status) {
          setImapConfig((prev) =>
            prev ? { ...prev, status: msg.status!, lastError: msg.lastError ?? null } : prev
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
    setWsConnected(false);
    setVaults([]);
    setItems([]);
    setAliases([]);
    setEmails([]);
    setServiceAccounts([]);
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
      await apiFetch(`/api/emails/${id}`, { method: 'DELETE' });
      setEmails((prev) => prev.filter((e) => e.id !== id));
    },
    [apiFetch]
  );

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
      const res = await apiFetch<{ imap: ImapConfigPublic }>('/api/imap', {
        method: 'PUT',
        body: JSON.stringify(params),
      });
      setImapConfig(res.imap);
    },
    [apiFetch]
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
      deleteItem,
      createAlias,
      toggleAlias,
      deleteAlias,
      deleteEmail,
      createServiceAccount,
      revokeServiceAccount,
      updateSettings,
      saveImapConfig,
      testImapConfig,
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
      error,
      setupAccount,
      unlock,
      lock,
      forgetTrustedDevice,
      refreshAll,
      createVault,
      saveItem,
      importCsvItems,
      deleteItem,
      createAlias,
      toggleAlias,
      deleteAlias,
      deleteEmail,
      createServiceAccount,
      revokeServiceAccount,
      updateSettings,
      saveImapConfig,
      testImapConfig,
    ]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
};
