import { Storage } from "nsh";
import {
  AAD,
  DEFAULT_KDF_ITERATIONS,
  DEFAULT_SERVER_URL,
  clampKdfIterations,
  decryptBytes,
  decryptJson,
  deriveAccountKeys,
  encryptBytes,
  encryptJson,
  fromBase64Url,
  generateEmailKeyPair,
  generateRawAesKey,
  openSealedJson,
  randomBytes,
  randomId,
  toBase64Url,
  type AccountInfo,
  type AliasRecord,
  type DecryptedEmailItem,
  type DecryptedEmailPayload,
  type DecryptedVault,
  type EmailFilterConfig,
  type EncryptedEmailRecord,
  type EncryptedItemRecord,
  type EncryptedVaultRecord,
  type ImapAccountPublic,
  type ImapConfigPublic,
  type RememberDuration,
  type RootKeysetPayload,
  type VaultItemPayload,
  type VaultMetadata,
} from "./crypto";

export * from "./types";

const PREFS_STORAGE_KEY = "nonepwd.prefs.v1";
const SESSION_STORAGE_KEY = "nonepwd.session.v1";
const THEME_STORAGE_KEY = "nonepwd.theme.v1";
const COPIED_EMAIL_EXPIRATIONS_KEY = "nonepwd.copied_email_expirations.v1";
export const COPIED_EMAIL_AUTO_DELETE_MS = 5 * 60_000;

export type ThemePreference = "system" | "light" | "dark";

export interface ClientPrefs {
  serverUrl: string;
  email: string;
  secretKey: string;
  rememberDuration: RememberDuration;
}

export interface RememberedSession {
  serverUrl: string;
  token: string;
  email: string;
  rootKeyB64: string;
  emailPrivateKeyPkcs8B64: string;
  expiresAtMs: number;
}

export interface AuthParamsResponse {
  initialized: boolean;
  email?: string;
  kdfSalt?: string;
  kdfIterations?: number;
}

export interface UnlockedSession {
  serverUrl: string;
  token: string;
  email: string;
  rootKeyBytes: Uint8Array;
  emailPrivateKeyPkcs8B64: string;
  isDemo?: boolean;
}

export interface SyncStateResult {
  account: AccountInfo | null;
  vaults: DecryptedVault[];
  vaultKeys: Map<string, Uint8Array>;
  items: VaultItemPayload[];
  aliases: AliasRecord[];
  emails: DecryptedEmailItem[];
  imapConfig: ImapConfigPublic | null;
  imapAccounts: ImapAccountPublic[];
  emailFilter: EmailFilterConfig | null;
  cursor: string | null;
  epoch: number | null;
}

export interface SyncPreviousState {
  cursor: string | null;
  epoch: number | null;
  vaults: DecryptedVault[];
  vaultKeys: Map<string, Uint8Array>;
  items: VaultItemPayload[];
  emails: DecryptedEmailItem[];
}

export interface SaveImapAccountInput {
  id?: string;
  label?: string;
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password?: string;
}

export const IMAP_PROVIDER_PRESETS = [
  { key: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, tls: true },
  { key: "qq", label: "QQ 邮箱", host: "imap.qq.com", port: 993, tls: true },
  { key: "163", label: "163 邮箱", host: "imap.163.com", port: 993, tls: true },
  { key: "126", label: "126 邮箱", host: "imap.126.com", port: 993, tls: true },
  { key: "icloud", label: "iCloud", host: "imap.mail.me.com", port: 993, tls: true },
  { key: "outlook", label: "Outlook", host: "outlook.office365.com", port: 993, tls: true },
  { key: "custom", label: "自定义", host: "", port: 993, tls: true },
] as const;

export function rememberDurationMs(duration: RememberDuration): number {
  switch (duration) {
    case "3h":
      return 3 * 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "session":
    default:
      return 0;
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_SERVER_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

export async function loadClientPrefs(): Promise<ClientPrefs> {
  try {
    const raw = await Storage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        serverUrl: DEFAULT_SERVER_URL,
        email: "",
        secretKey: "",
        rememberDuration: "24h",
      };
    }
    const parsed = JSON.parse(raw) as Partial<ClientPrefs>;
    const dur =
      parsed.rememberDuration === "3h" ||
      parsed.rememberDuration === "24h" ||
      parsed.rememberDuration === "7d" ||
      parsed.rememberDuration === "session"
        ? parsed.rememberDuration
        : "24h";
    return {
      serverUrl: normalizeServerUrl(parsed.serverUrl ?? DEFAULT_SERVER_URL),
      email: typeof parsed.email === "string" ? parsed.email : "",
      secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey : "",
      rememberDuration: dur,
    };
  } catch {
    return {
      serverUrl: DEFAULT_SERVER_URL,
      email: "",
      secretKey: "",
      rememberDuration: "24h",
    };
  }
}

export async function saveClientPrefs(prefs: ClientPrefs): Promise<void> {
  await Storage.setItem(
    PREFS_STORAGE_KEY,
    JSON.stringify({
      ...prefs,
      serverUrl: normalizeServerUrl(prefs.serverUrl),
    })
  );
}

export async function loadRememberedSession(): Promise<RememberedSession | null> {
  try {
    const raw = await Storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedSession>;
    if (
      !parsed.token ||
      !parsed.rootKeyB64 ||
      !parsed.emailPrivateKeyPkcs8B64 ||
      !parsed.serverUrl ||
      typeof parsed.expiresAtMs !== "number"
    ) {
      await Storage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    if (parsed.expiresAtMs <= Date.now()) {
      await Storage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed as RememberedSession;
  } catch {
    return null;
  }
}

export async function saveRememberedSession(
  session: UnlockedSession,
  duration: RememberDuration
): Promise<void> {
  const ttl = rememberDurationMs(duration);
  if (ttl <= 0) {
    await Storage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  const payload: RememberedSession = {
    serverUrl: normalizeServerUrl(session.serverUrl),
    token: session.token,
    email: session.email,
    rootKeyB64: toBase64Url(session.rootKeyBytes),
    emailPrivateKeyPkcs8B64: session.emailPrivateKeyPkcs8B64,
    expiresAtMs: Date.now() + ttl,
  };
  await Storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
}

export async function clearRememberedSession(): Promise<void> {
  await Storage.removeItem(SESSION_STORAGE_KEY);
}

export async function loadThemePreference(): Promise<ThemePreference> {
  try {
    const raw = await Storage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
    return "system";
  } catch {
    return "system";
  }
}

export async function saveThemePreference(theme: ThemePreference): Promise<void> {
  await Storage.setItem(THEME_STORAGE_KEY, theme);
}

export async function loadCopiedEmailExpirations(): Promise<Record<string, number>> {
  try {
    const raw = await Storage.getItem(COPIED_EMAIL_EXPIRATIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string" && id && typeof ts === "number" && Number.isFinite(ts)) {
        out[id] = ts;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveCopiedEmailExpirations(
  expirations: Record<string, number>
): Promise<void> {
  const keys = Object.keys(expirations);
  if (keys.length === 0) {
    await Storage.removeItem(COPIED_EMAIL_EXPIRATIONS_KEY);
    return;
  }
  await Storage.setItem(COPIED_EMAIL_EXPIRATIONS_KEY, JSON.stringify(expirations));
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiRequest<T>(
  serverUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
  } = {}
): Promise<T> {
  const base = normalizeServerUrl(serverUrl);
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let parsed: (T & { error?: string }) | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as T & { error?: string };
    } catch {
      if (!res.ok) {
        throw new ApiError(text.slice(0, 160) || `HTTP ${res.status}`, res.status);
      }
      throw new ApiError("服务端返回了非 JSON 响应", res.status);
    }
  }
  if (!res.ok) {
    throw new ApiError(parsed?.error ?? `请求失败 (${res.status})`, res.status);
  }
  return (parsed ?? ({} as T)) as T;
}

export function normalizeImapAccounts(
  imapAccounts: ImapAccountPublic[] | undefined,
  imapStatus: ImapConfigPublic | null | undefined
): ImapAccountPublic[] {
  if (Array.isArray(imapAccounts)) {
    return imapAccounts;
  }
  if (imapStatus && (imapStatus.host || imapStatus.username || imapStatus.enabled)) {
    return [
      {
        id: "legacy-1",
        label: imapStatus.username || imapStatus.host || "默认邮箱",
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

export async function getAuthParams(serverUrl: string): Promise<AuthParamsResponse> {
  return apiRequest<AuthParamsResponse>(serverUrl, "/api/auth/params");
}

export async function setupAccount(
  serverUrl: string,
  params: {
    email: string;
    masterPassword: string;
    secretKey: string;
    aliasDomain?: string;
  }
): Promise<UnlockedSession> {
  const kdfSalt = toBase64Url(randomBytes(16));
  const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
    params.masterPassword,
    params.secretKey,
    kdfSalt,
    DEFAULT_KDF_ITERATIONS
  );

  const rootKeyBytes = generateRawAesKey();
  const emailKp = await generateEmailKeyPair();
  const keyset: RootKeysetPayload = {
    rootKeyB64: toBase64Url(rootKeyBytes),
    emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
  };
  const encryptedRootKeyset = await encryptJson(
    masterUnlockKeyBytes,
    keyset,
    AAD.ROOT_KEYSET
  );

  const initialDefs: VaultMetadata[] = [
    { name: "Personal", description: "个人网站登录、银行与日常账号" },
    { name: "DevOps", description: "API Keys、服务器、环境变量与 CLI 凭据" },
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

  const res = await apiRequest<{ token: string; account: AccountInfo }>(
    serverUrl,
    "/api/auth/setup",
    {
      method: "POST",
      body: {
        email: params.email.trim(),
        kdfSalt,
        kdfIterations: DEFAULT_KDF_ITERATIONS,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: params.aliasDomain?.trim() ?? "",
        vaults: initialVaults,
      },
    }
  );

  return {
    serverUrl: normalizeServerUrl(serverUrl),
    token: res.token,
    email: res.account.email,
    rootKeyBytes,
    emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
  };
}

export async function unlockVault(
  serverUrl: string,
  params: {
    masterPassword: string;
    secretKey: string;
  }
): Promise<UnlockedSession> {
  const authParams = await getAuthParams(serverUrl);
  if (!authParams.initialized || !authParams.kdfSalt || !authParams.kdfIterations) {
    throw new Error("服务端尚未初始化，请先创建主账号");
  }

  const safeIterations = clampKdfIterations(authParams.kdfIterations);
  const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
    params.masterPassword,
    params.secretKey,
    authParams.kdfSalt,
    safeIterations
  );

  const loginRes = await apiRequest<{
    token: string;
    account: {
      email: string;
      encryptedRootKeyset: string;
    };
  }>(serverUrl, "/api/auth/login", {
    method: "POST",
    body: { authVerifier: authVerifierB64 },
  });

  let keyset: RootKeysetPayload;
  try {
    keyset = await decryptJson<RootKeysetPayload>(
      masterUnlockKeyBytes,
      loginRes.account.encryptedRootKeyset,
      AAD.ROOT_KEYSET
    );
  } catch {
    throw new Error("主密码或 Secret Key 解密失败，请检查密钥是否完整匹配");
  }

  return {
    serverUrl: normalizeServerUrl(serverUrl),
    token: loginRes.token,
    email: loginRes.account.email,
    rootKeyBytes: fromBase64Url(keyset.rootKeyB64),
    emailPrivateKeyPkcs8B64: keyset.emailPrivateKeyPkcs8B64,
  };
}

export async function logoutSession(serverUrl: string, token: string): Promise<void> {
  try {
    await apiRequest(serverUrl, "/api/auth/logout", {
      method: "POST",
      token,
    });
  } catch {
    // Best-effort logout
  }
}

export async function syncAll(
  serverUrl: string,
  token: string,
  rootKeyBytes: Uint8Array,
  emailPrivateKeyPkcs8B64: string,
  previous?: SyncPreviousState | null
): Promise<SyncStateResult> {
  const params = new URLSearchParams();
  if (previous?.cursor) {
    params.set("since", previous.cursor);
    if (previous.epoch) params.set("epoch", String(previous.epoch));
  }
  const syncQuery = params.toString();
  const syncPath = syncQuery ? `/api/sync?${syncQuery}` : "/api/sync";
  const syncData = await apiRequest<{
    incremental?: boolean;
    cursor?: string;
    epoch?: number;
    account?: AccountInfo;
    vaults: EncryptedVaultRecord[];
    items: EncryptedItemRecord[];
    aliases?: AliasRecord[];
    emails?: EncryptedEmailRecord[];
    deleted?: { vaults?: string[]; items?: string[]; emails?: string[] };
    imapStatus?: ImapConfigPublic;
    imapAccounts?: ImapAccountPublic[];
    emailFilter?: EmailFilterConfig;
  }>(serverUrl, syncPath, { token });

  const incremental = syncData.incremental === true && Boolean(previous?.cursor);
  const vaultKeys = incremental && previous ? new Map(previous.vaultKeys) : new Map<string, Uint8Array>();
  const vaults: DecryptedVault[] = [];
  for (const v of syncData.vaults ?? []) {
    try {
      const vk = await decryptBytes(rootKeyBytes, v.encryptedKey, AAD.vaultOwnerKey(v.id));
      const meta = await decryptJson<VaultMetadata>(vk, v.encryptedMeta, AAD.vaultMeta(v.id));
      vaultKeys.set(v.id, vk);
      vaults.push({
        id: v.id,
        metadata: meta,
        keyBytes: vk,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      });
    } catch {
      // Skip unreadable vault
    }
  }

  const items: VaultItemPayload[] = [];
  for (const it of syncData.items ?? []) {
    const vk = vaultKeys.get(it.vaultId);
    if (!vk) continue;
    try {
      const payload = await decryptJson<VaultItemPayload>(
        vk,
        it.encryptedData,
        AAD.vaultItem(it.vaultId, it.id)
      );
      if (payload.id !== it.id || payload.vaultId !== it.vaultId) {
        continue;
      }
      items.push(payload);
    } catch {
      // Skip unreadable item
    }
  }

  const emails: DecryptedEmailItem[] = [];
  for (const em of syncData.emails ?? []) {
    if (!emailPrivateKeyPkcs8B64) continue;
    try {
      const opened = await openSealedJson<DecryptedEmailPayload>(
        emailPrivateKeyPkcs8B64,
        em.sealedEnvelope,
        "nonepwd-email-v1"
      );
      emails.push({
        ...opened,
        id: em.id,
        source: em.source,
        envelopeTo: em.envelopeTo,
      });
    } catch {
      // Skip unreadable email
    }
  }

  let nextVaults = vaults;
  let nextItems = items;
  let nextEmails = emails;
  if (incremental && previous) {
    const vaultMap = new Map(previous.vaults.map((v) => [v.id, v]));
    for (const v of vaults) vaultMap.set(v.id, v);
    for (const id of syncData.deleted?.vaults ?? []) {
      vaultMap.delete(id);
      vaultKeys.delete(id);
    }
    nextVaults = [...vaultMap.values()];

    const itemMap = new Map(previous.items.map((item) => [item.id, item]));
    for (const item of items) itemMap.set(item.id, item);
    for (const id of syncData.deleted?.items ?? []) itemMap.delete(id);
    for (const vaultId of syncData.deleted?.vaults ?? []) {
      for (const [id, item] of itemMap) {
        if (item.vaultId === vaultId) itemMap.delete(id);
      }
    }
    nextItems = [...itemMap.values()];

    const emailMap = new Map(previous.emails.map((email) => [email.id, email]));
    for (const email of emails) emailMap.set(email.id, email);
    for (const id of syncData.deleted?.emails ?? []) emailMap.delete(id);
    nextEmails = [...emailMap.values()];
  }

  return {
    account: syncData.account ?? null,
    vaults: nextVaults,
    vaultKeys,
    items: nextItems,
    aliases: syncData.aliases ?? [],
    emails: nextEmails,
    imapConfig: syncData.imapStatus ?? null,
    imapAccounts: normalizeImapAccounts(syncData.imapAccounts, syncData.imapStatus),
    emailFilter: syncData.emailFilter ?? null,
    cursor: syncData.cursor ?? (incremental ? previous?.cursor ?? null : null),
    epoch: typeof syncData.epoch === "number" ? syncData.epoch : previous?.epoch ?? null,
  };
}

export async function createVault(
  serverUrl: string,
  token: string,
  rootKeyBytes: Uint8Array,
  name: string,
  description?: string
): Promise<DecryptedVault> {
  const id = randomId();
  const keyBytes = generateRawAesKey();
  const metadata: VaultMetadata = {
    name: name.trim(),
    ...(description?.trim() ? { description: description.trim() } : {}),
  };
  const encryptedKey = await encryptBytes(rootKeyBytes, keyBytes, AAD.vaultOwnerKey(id));
  const encryptedMeta = await encryptJson(keyBytes, metadata, AAD.vaultMeta(id));

  const res = await apiRequest<{ vault: EncryptedVaultRecord }>(serverUrl, "/api/vaults", {
    method: "POST",
    token,
    body: { id, encryptedKey, encryptedMeta },
  });

  return {
    id,
    metadata,
    keyBytes,
    createdAt: res.vault.createdAt,
    updatedAt: res.vault.updatedAt,
  };
}

export async function saveItem(
  serverUrl: string,
  token: string,
  vaultKeyBytes: Uint8Array,
  item: VaultItemPayload,
  isNew: boolean
): Promise<VaultItemPayload> {
  const now = new Date().toISOString();
  const payload: VaultItemPayload = {
    ...item,
    createdAt: item.createdAt || now,
    updatedAt: now,
  };
  const encryptedData = await encryptJson(
    vaultKeyBytes,
    payload,
    AAD.vaultItem(payload.vaultId, payload.id)
  );

  if (isNew) {
    await apiRequest(serverUrl, `/api/vaults/${encodeURIComponent(payload.vaultId)}/items`, {
      method: "POST",
      token,
      body: { id: payload.id, encryptedData },
    });
  } else {
    await apiRequest(
      serverUrl,
      `/api/vaults/${encodeURIComponent(payload.vaultId)}/items/${encodeURIComponent(payload.id)}`,
      {
        method: "PUT",
        token,
        body: { encryptedData },
      }
    );
  }
  return payload;
}

export async function batchSaveItems(
  serverUrl: string,
  token: string,
  vaultId: string,
  vaultKeyBytes: Uint8Array,
  items: VaultItemPayload[]
): Promise<VaultItemPayload[]> {
  if (items.length === 0) return [];
  const now = new Date().toISOString();
  const normalized: VaultItemPayload[] = [];
  const encryptedBatch: Array<{ id: string; encryptedData: string }> = [];
  for (const item of items) {
    const payload: VaultItemPayload = {
      ...item,
      vaultId,
      createdAt: item.createdAt || now,
      updatedAt: now,
    };
    const encryptedData = await encryptJson(
      vaultKeyBytes,
      payload,
      AAD.vaultItem(vaultId, payload.id)
    );
    encryptedBatch.push({ id: payload.id, encryptedData });
    normalized.push(payload);
  }
  await apiRequest(serverUrl, `/api/vaults/${encodeURIComponent(vaultId)}/items/batch`, {
    method: "POST",
    token,
    body: { items: encryptedBatch },
  });
  return normalized;
}

export async function deleteItem(
  serverUrl: string,
  token: string,
  vaultId: string,
  itemId: string
): Promise<void> {
  await apiRequest(
    serverUrl,
    `/api/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE", token }
  );
}

export async function deleteEmail(
  serverUrl: string,
  token: string,
  emailId: string
): Promise<void> {
  await apiRequest(serverUrl, `/api/emails/${encodeURIComponent(emailId)}`, {
    method: "DELETE",
    token,
  });
}

export async function getImapAccounts(
  serverUrl: string,
  token: string
): Promise<{ imap: ImapConfigPublic | null; accounts: ImapAccountPublic[] }> {
  try {
    const res = await apiRequest<{
      imap?: ImapConfigPublic;
      accounts?: ImapAccountPublic[];
    }>(serverUrl, "/api/imap", { token });
    return {
      imap: res.imap ?? null,
      accounts: normalizeImapAccounts(res.accounts, res.imap),
    };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      const res = await apiRequest<{
        imap?: ImapConfigPublic;
        accounts?: ImapAccountPublic[];
      }>(serverUrl, "/api/imap/accounts", { token });
      return {
        imap: res.imap ?? null,
        accounts: normalizeImapAccounts(res.accounts, res.imap),
      };
    }
    throw err;
  }
}

export async function saveImapAccount(
  serverUrl: string,
  token: string,
  input: SaveImapAccountInput
): Promise<{ account: ImapAccountPublic | null; accounts: ImapAccountPublic[]; imap: ImapConfigPublic | null }> {
  const isEdit = Boolean(input.id);
  const path = isEdit
    ? `/api/imap/accounts/${encodeURIComponent(input.id!)}`
    : "/api/imap/accounts";
  const res = await apiRequest<{
    account?: ImapAccountPublic | null;
    accounts?: ImapAccountPublic[];
    imap?: ImapConfigPublic;
  }>(serverUrl, path, {
    method: isEdit ? "PUT" : "POST",
    token,
    body: input,
  });
  return {
    account: res.account ?? null,
    accounts: normalizeImapAccounts(res.accounts, res.imap),
    imap: res.imap ?? null,
  };
}

export async function saveImapAccounts(
  serverUrl: string,
  token: string,
  inputs: SaveImapAccountInput[]
): Promise<{ accounts: ImapAccountPublic[]; imap: ImapConfigPublic | null }> {
  let latestAccounts: ImapAccountPublic[] = [];
  let latestImap: ImapConfigPublic | null = null;
  for (const input of inputs) {
    const res = await saveImapAccount(serverUrl, token, input);
    latestAccounts = res.accounts;
    latestImap = res.imap;
  }
  return { accounts: latestAccounts, imap: latestImap };
}

export async function deleteImapAccount(
  serverUrl: string,
  token: string,
  id: string
): Promise<{ accounts: ImapAccountPublic[]; imap: ImapConfigPublic | null }> {
  const res = await apiRequest<{
    accounts?: ImapAccountPublic[];
    imap?: ImapConfigPublic;
  }>(serverUrl, `/api/imap/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
  return {
    accounts: normalizeImapAccounts(res.accounts, res.imap),
    imap: res.imap ?? null,
  };
}

export async function testImapConnection(
  serverUrl: string,
  token: string,
  input: {
    id?: string;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password?: string;
  }
): Promise<{ ok: boolean; messages?: number; error?: string }> {
  return apiRequest<{ ok: boolean; messages?: number; error?: string }>(
    serverUrl,
    "/api/imap/test",
    {
      method: "POST",
      token,
      body: input,
    }
  );
}

export async function syncImapNow(
  serverUrl: string,
  token: string,
  accountId?: string
): Promise<{
  ok: boolean;
  synced?: number;
  error?: string | null;
  accounts: ImapAccountPublic[];
  imap: ImapConfigPublic | null;
}> {
  const res = await apiRequest<{
    ok: boolean;
    synced?: number;
    error?: string | null;
    accounts?: ImapAccountPublic[];
    imap?: ImapConfigPublic;
  }>(serverUrl, "/api/imap/sync", {
    method: "POST",
    token,
    body: accountId ? { id: accountId } : {},
  });
  return {
    ok: Boolean(res.ok),
    synced: res.synced,
    error: res.error ?? null,
    accounts: normalizeImapAccounts(res.accounts, res.imap),
    imap: res.imap ?? null,
  };
}

export async function getEmailFilter(
  serverUrl: string,
  token: string
): Promise<EmailFilterConfig> {
  try {
    return await apiRequest<EmailFilterConfig>(serverUrl, "/api/email-filter", { token });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return apiRequest<EmailFilterConfig>(serverUrl, "/api/settings/email-filter", { token });
    }
    throw err;
  }
}

export async function saveEmailFilter(
  serverUrl: string,
  token: string,
  config: EmailFilterConfig
): Promise<EmailFilterConfig> {
  try {
    return await apiRequest<EmailFilterConfig>(serverUrl, "/api/email-filter", {
      method: "PUT",
      token,
      body: config,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return apiRequest<EmailFilterConfig>(serverUrl, "/api/settings/email-filter", {
        method: "PUT",
        token,
        body: config,
      });
    }
    throw err;
  }
}
