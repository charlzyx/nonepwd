import WebSocket from 'ws';
import {
  AAD,
  DEFAULT_KDF_ITERATIONS,
  decodeServiceAccountToken,
  decryptBytes,
  decryptJson,
  deriveAccountKeys,
  domainsMatch,
  encodeServiceAccountToken,
  encryptBytes,
  encryptJson,
  fromBase64Url,
  generateEmailKeyPair,
  generatePassword,
  generateRawAesKey,
  generateSecretKey,
  generateTotp,
  openSealedJson,
  parseSecretRef,
  randomBytes,
  randomId,
  resolveItemField,
  toBase64Url,
  type AliasRecord,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type EncryptedItemRecord,
  type EncryptedVaultRecord,
  type ItemCategory,
  type RootKeysetPayload,
  type ServiceAccountRecord,
  type VaultItemPayload,
  type VaultMetadata,
} from '@nonepwd/core';
import { loadCliConfig, saveCliConfig } from './config.js';

export interface DecryptedVault {
  id: string;
  metadata: VaultMetadata;
  keyBytes: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedItem {
  id: string;
  vaultId: string;
  vaultName: string;
  payload: VaultItemPayload;
}

export interface DecryptedEmailWithMeta extends DecryptedEmailPayload {
  id: string;
  source: EncryptedEmailRecord['source'];
  envelopeTo: string | null;
}

export class NonePwdCliClient {
  private readonly configDir?: string;
  private readonly env: Record<string, string | undefined>;
  private serverUrlOverride?: string;
  private serviceAccountToken?: string;

  private activeMode: 'owner' | 'service_account' = 'owner';
  private sessionToken: string | null = null;
  private rootKeyBytes: Uint8Array | null = null;
  private emailPrivateKeyPkcs8B64: string | null = null;

  public vaults: DecryptedVault[] = [];
  public items: DecryptedItem[] = [];
  public aliases: AliasRecord[] = [];
  public emails: DecryptedEmailWithMeta[] = [];

  constructor(options?: {
    configDir?: string;
    serverUrl?: string;
    serviceAccountToken?: string;
    env?: Record<string, string | undefined>;
  }) {
    this.configDir = options?.configDir;
    this.env = options?.env ?? process.env;
    this.serverUrlOverride = options?.serverUrl;
    this.serviceAccountToken = options?.serviceAccountToken ?? this.env.NONEPWD_TOKEN;
  }

  private getServerUrl(): string {
    if (this.serverUrlOverride) return this.serverUrlOverride.replace(/\/+$/, '');
    if (this.serviceAccountToken) {
      return decodeServiceAccountToken(this.serviceAccountToken).serverUrl.replace(/\/+$/, '');
    }
    const cfg = loadCliConfig(this.configDir);
    const url = this.env.NONEPWD_SERVER ?? cfg.serverUrl;
    if (!url) {
      throw new Error('No nonepwd server configured. Run `np setup` or `np signin --server <url>`.');
    }
    return url.replace(/\/+$/, '');
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit & { skipAuth?: boolean }
  ): Promise<T> {
    const base = this.getServerUrl();
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (!init?.skipAuth && this.sessionToken) {
      headers.Authorization = `Bearer ${this.sessionToken}`;
    }
    if (init?.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
    if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status} on ${path}`);
    }
    return data;
  }

  async setup(params: {
    serverUrl: string;
    email: string;
    password: string;
    aliasDomain?: string;
    kdfIterations?: number;
  }): Promise<{ email: string; secretKey: string; serverUrl: string; vaults: string[] }> {
    this.serverUrlOverride = params.serverUrl.replace(/\/+$/, '');
    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const kdfIterations = params.kdfIterations ?? DEFAULT_KDF_ITERATIONS;

    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      params.password,
      secretKey,
      kdfSalt,
      kdfIterations
    );

    const rootKeyBytes = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const rootKeyset: RootKeysetPayload = {
      rootKeyB64: toBase64Url(rootKeyBytes),
      emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
    };
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      rootKeyset,
      AAD.ROOT_KEYSET
    );

    const vaultNames = ['Personal', 'DevOps'];
    const initialVaults = await Promise.all(
      vaultNames.map(async (name) => {
        const id = randomId();
        const vk = generateRawAesKey();
        return {
          id,
          encryptedKey: await encryptBytes(rootKeyBytes, vk, AAD.vaultOwnerKey(id)),
          encryptedMeta: await encryptJson<VaultMetadata>(vk, { name }, AAD.vaultMeta(id)),
        };
      })
    );

    const res = await this.requestJson<{ token: string }>('/api/auth/setup', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({
        email: params.email,
        kdfSalt,
        kdfIterations,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: params.aliasDomain ?? '',
        vaults: initialVaults,
      }),
    });

    this.activeMode = 'owner';
    this.sessionToken = res.token;
    this.rootKeyBytes = rootKeyBytes;
    this.emailPrivateKeyPkcs8B64 = emailKp.privateKeyPkcs8B64;

    saveCliConfig(
      {
        serverUrl: this.serverUrlOverride,
        email: params.email.trim().toLowerCase(),
        secretKey,
        session: {
          token: res.token,
          rootKeyB64: rootKeyset.rootKeyB64,
          emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
          savedAt: new Date().toISOString(),
        },
      },
      this.configDir
    );

    await this.sync();
    return {
      email: params.email.trim().toLowerCase(),
      secretKey,
      serverUrl: this.serverUrlOverride,
      vaults: vaultNames,
    };
  }

  async signin(params: {
    serverUrl?: string;
    email?: string;
    secretKey?: string;
    password: string;
  }): Promise<{ email: string; serverUrl: string }> {
    const cfg = loadCliConfig(this.configDir);
    const serverUrl = (params.serverUrl ?? cfg.serverUrl ?? this.env.NONEPWD_SERVER ?? '').replace(
      /\/+$/,
      ''
    );
    if (!serverUrl) throw new Error('Server URL is required for signin');
    this.serverUrlOverride = serverUrl;

    const secretKey = params.secretKey ?? cfg.secretKey ?? this.env.NONEPWD_SECRET_KEY;
    if (!secretKey) throw new Error('Secret Key (NP3-...) is required for signin');

    const authParams = await this.requestJson<{
      initialized: boolean;
      email?: string;
      kdfSalt?: string;
      kdfIterations?: number;
    }>('/api/auth/params', { skipAuth: true });

    if (!authParams.initialized || !authParams.kdfSalt || !authParams.kdfIterations) {
      throw new Error('Server is not initialized. Run `np setup` first.');
    }

    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      params.password,
      secretKey,
      authParams.kdfSalt,
      authParams.kdfIterations
    );

    const loginRes = await this.requestJson<{
      token: string;
      account: {
        email: string;
        encryptedRootKeyset: string;
      };
    }>('/api/auth/login', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ authVerifier: authVerifierB64 }),
    });

    const keyset = await decryptJson<RootKeysetPayload>(
      masterUnlockKeyBytes,
      loginRes.account.encryptedRootKeyset,
      AAD.ROOT_KEYSET
    );

    this.activeMode = 'owner';
    this.sessionToken = loginRes.token;
    this.rootKeyBytes = fromBase64Url(keyset.rootKeyB64);
    this.emailPrivateKeyPkcs8B64 = keyset.emailPrivateKeyPkcs8B64;

    saveCliConfig(
      {
        serverUrl,
        email: params.email ?? loginRes.account.email,
        secretKey,
        session: {
          token: loginRes.token,
          rootKeyB64: keyset.rootKeyB64,
          emailPrivateKeyPkcs8B64: keyset.emailPrivateKeyPkcs8B64,
          savedAt: new Date().toISOString(),
        },
      },
      this.configDir
    );

    await this.sync();
    return { email: loginRes.account.email, serverUrl };
  }

  async lock(): Promise<void> {
    const cfg = loadCliConfig(this.configDir);
    if (cfg.session?.token) {
      this.sessionToken = cfg.session.token;
      try {
        await this.requestJson('/api/auth/logout', { method: 'POST' });
      } catch {
        // ignore network errors during lock
      }
      delete cfg.session;
      saveCliConfig(cfg, this.configDir);
    }
    this.sessionToken = null;
    this.rootKeyBytes = null;
    this.emailPrivateKeyPkcs8B64 = null;
  }

  async ensureAuthenticated(): Promise<void> {
    if (this.sessionToken) return;

    if (this.serviceAccountToken) {
      const parsed = decodeServiceAccountToken(this.serviceAccountToken);
      this.serverUrlOverride = parsed.serverUrl.replace(/\/+$/, '');
      const res = await this.requestJson<{ token: string }>('/api/auth/service-account', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({ tokenId: parsed.tokenId, authSecret: parsed.authSecret }),
      });
      this.activeMode = 'service_account';
      this.sessionToken = res.token;
      return;
    }

    const cfg = loadCliConfig(this.configDir);
    if (cfg.session?.token && cfg.session.rootKeyB64) {
      this.activeMode = 'owner';
      this.sessionToken = cfg.session.token;
      this.rootKeyBytes = fromBase64Url(cfg.session.rootKeyB64);
      this.emailPrivateKeyPkcs8B64 = cfg.session.emailPrivateKeyPkcs8B64;
      return;
    }

    const envPass = this.env.NONEPWD_MASTER_PASSWORD;
    if (envPass && cfg.secretKey) {
      await this.signin({ password: envPass });
      return;
    }

    throw new Error('nonepwd CLI is locked. Run `np signin` or set NONEPWD_TOKEN.');
  }

  async sync(): Promise<void> {
    await this.ensureAuthenticated();
    const data = await this.requestJson<{
      kind: 'owner' | 'service_account';
      vaults: EncryptedVaultRecord[];
      items: EncryptedItemRecord[];
      aliases?: AliasRecord[];
      emails?: EncryptedEmailRecord[];
    }>('/api/sync');

    const vaultMap = new Map<string, DecryptedVault>();
    const decryptedVaults: DecryptedVault[] = [];

    if (data.kind === 'service_account') {
      const sa = decodeServiceAccountToken(this.serviceAccountToken!);
      const wrapKey = fromBase64Url(sa.wrapKeyB64);
      for (const v of data.vaults) {
        const keyBytes = await decryptBytes(wrapKey, v.encryptedKey, AAD.vaultSaKey(v.id, sa.tokenId));
        const metadata = await decryptJson<VaultMetadata>(
          keyBytes,
          v.encryptedMeta,
          AAD.vaultMeta(v.id)
        );
        const dv: DecryptedVault = {
          id: v.id,
          metadata,
          keyBytes,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        };
        vaultMap.set(v.id, dv);
        decryptedVaults.push(dv);
      }
    } else {
      if (!this.rootKeyBytes) {
        throw new Error('Missing owner root key in session');
      }
      for (const v of data.vaults) {
        const keyBytes = await decryptBytes(
          this.rootKeyBytes,
          v.encryptedKey,
          AAD.vaultOwnerKey(v.id)
        );
        const metadata = await decryptJson<VaultMetadata>(
          keyBytes,
          v.encryptedMeta,
          AAD.vaultMeta(v.id)
        );
        const dv: DecryptedVault = {
          id: v.id,
          metadata,
          keyBytes,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        };
        vaultMap.set(v.id, dv);
        decryptedVaults.push(dv);
      }
    }

    const decryptedItems: DecryptedItem[] = [];
    for (const item of data.items) {
      const vault = vaultMap.get(item.vaultId);
      if (!vault) continue;
      const payload = await decryptJson<VaultItemPayload>(
        vault.keyBytes,
        item.encryptedData,
        AAD.vaultItem(item.vaultId, item.id)
      );
      decryptedItems.push({
        id: item.id,
        vaultId: item.vaultId,
        vaultName: vault.metadata.name,
        payload,
      });
    }

    const decryptedEmails: DecryptedEmailWithMeta[] = [];
    if (data.emails && this.emailPrivateKeyPkcs8B64) {
      for (const em of data.emails) {
        try {
          const opened = await openSealedJson<DecryptedEmailPayload>(
            this.emailPrivateKeyPkcs8B64,
            em.sealedEnvelope
          );
          decryptedEmails.push({
            ...opened,
            id: em.id,
            source: em.source,
            envelopeTo: em.envelopeTo,
          });
        } catch {
          // ignore unreadable envelope
        }
      }
    }

    this.vaults = decryptedVaults;
    this.items = decryptedItems;
    this.aliases = data.aliases ?? [];
    this.emails = decryptedEmails;
  }

  findVault(nameOrId: string): DecryptedVault {
    const q = nameOrId.trim();
    const byId = this.vaults.find((v) => v.id === q);
    if (byId) return byId;
    const byName = this.vaults.find((v) => v.metadata.name.toLowerCase() === q.toLowerCase());
    if (byName) return byName;
    throw new Error(`Vault not found: "${nameOrId}"`);
  }

  findItem(itemNameOrId: string, vaultNameOrId?: string): DecryptedItem {
    let pool = this.items;
    if (vaultNameOrId) {
      const v = this.findVault(vaultNameOrId);
      pool = pool.filter((i) => i.vaultId === v.id);
    }
    const q = itemNameOrId.trim();
    const byId = pool.find((i) => i.id === q);
    if (byId) return byId;
    const byTitle = pool.find((i) => i.payload.title.toLowerCase() === q.toLowerCase());
    if (byTitle) return byTitle;
    throw new Error(`Item not found: "${itemNameOrId}"`);
  }

  async createVault(name: string, description?: string): Promise<DecryptedVault> {
    await this.ensureAuthenticated();
    if (this.activeMode !== 'owner' || !this.rootKeyBytes) {
      throw new Error('Only owner session can create vaults');
    }
    const id = randomId();
    const keyBytes = generateRawAesKey();
    const meta: VaultMetadata = { name: name.trim(), description };
    const encryptedKey = await encryptBytes(this.rootKeyBytes, keyBytes, AAD.vaultOwnerKey(id));
    const encryptedMeta = await encryptJson(keyBytes, meta, AAD.vaultMeta(id));

    const res = await this.requestJson<{ vault: EncryptedVaultRecord }>('/api/vaults', {
      method: 'POST',
      body: JSON.stringify({ id, encryptedKey, encryptedMeta }),
    });

    const dv: DecryptedVault = {
      id,
      metadata: meta,
      keyBytes,
      createdAt: res.vault.createdAt,
      updatedAt: res.vault.updatedAt,
    };
    this.vaults.push(dv);
    return dv;
  }

  async createItem(params: {
    vaultNameOrId: string;
    title: string;
    category?: ItemCategory;
    urls?: string[];
    username?: string;
    password?: string;
    generatePass?: boolean;
    totp?: string;
    emailAlias?: string;
    autoAlias?: boolean;
    notes?: string;
    customFields?: Array<{ label: string; value: string; type?: 'text' | 'concealed' }>;
  }): Promise<DecryptedItem> {
    await this.sync();
    if (this.activeMode !== 'owner') {
      throw new Error('Only owner session can create items');
    }
    const vault = this.findVault(params.vaultNameOrId);
    const id = randomId();
    const now = new Date().toISOString();

    let emailAlias = params.emailAlias;
    if (params.autoAlias && !emailAlias) {
      const alias = await this.createAlias(params.urls?.[0] ?? params.title, undefined, vault.id, id);
      emailAlias = alias.address;
    }

    const password = params.generatePass ? generatePassword({ length: 20 }) : params.password;
    const payload: VaultItemPayload = {
      id,
      vaultId: vault.id,
      category: params.category ?? 'login',
      title: params.title.trim(),
      favorite: false,
      tags: [],
      urls: params.urls ?? [],
      username: params.username ?? emailAlias,
      password,
      totp: params.totp,
      emailAlias,
      notes: params.notes,
      customFields: (params.customFields ?? []).map((cf) => ({
        id: randomId(),
        label: cf.label,
        value: cf.value,
        type: cf.type ?? 'concealed',
      })),
      createdAt: now,
      updatedAt: now,
    };

    const encryptedData = await encryptJson(vault.keyBytes, payload, AAD.vaultItem(vault.id, id));
    await this.requestJson(`/api/vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id, encryptedData }),
    });

    const created: DecryptedItem = {
      id,
      vaultId: vault.id,
      vaultName: vault.metadata.name,
      payload,
    };
    this.items.unshift(created);
    return created;
  }

  async deleteItem(itemNameOrId: string, vaultNameOrId?: string): Promise<void> {
    await this.sync();
    const item = this.findItem(itemNameOrId, vaultNameOrId);
    await this.requestJson(`/api/vaults/${item.vaultId}/items/${item.id}`, {
      method: 'DELETE',
    });
    this.items = this.items.filter((i) => i.id !== item.id);
  }

  async getTotp(itemNameOrId: string, vaultNameOrId?: string) {
    await this.sync();
    const item = this.findItem(itemNameOrId, vaultNameOrId);
    if (!item.payload.totp) {
      throw new Error(`Item "${item.payload.title}" has no TOTP secret configured`);
    }
    return generateTotp(item.payload.totp);
  }

  async resolveSecretRef(uri: string): Promise<string> {
    await this.sync();
    const parsed = parseSecretRef(uri);
    const item = this.findItem(parsed.item, parsed.vault);
    const fieldLower = parsed.field.toLowerCase();

    if (fieldLower === 'totp' || fieldLower === 'otp') {
      if (!item.payload.totp) {
        throw new Error(`No TOTP secret configured for ${uri}`);
      }
      const res = await generateTotp(item.payload.totp);
      return res.code;
    }

    if (fieldLower === 'email_otp' || fieldLower === 'email-otp') {
      const waitSec = Number.parseFloat(parsed.params.wait ?? '0');
      const email = await this.waitForEmailOtp({
        alias: item.payload.emailAlias,
        domain: item.payload.urls[0],
        waitSeconds: Number.isFinite(waitSec) ? waitSec : 0,
      });
      if (!email.otpCode) {
        throw new Error(`No email OTP code found for ${uri}`);
      }
      return email.otpCode;
    }

    const val = resolveItemField(item.payload, parsed.field);
    if (val === undefined) {
      throw new Error(`Field "${parsed.field}" not found on item "${item.payload.title}"`);
    }
    return val;
  }

  private matchesEmailFilter(
    em: DecryptedEmailPayload,
    opts: { domain?: string; alias?: string; minTimestampMs: number }
  ): boolean {
    if (!em.otpCode) return false;
    if (new Date(em.receivedAt).getTime() < opts.minTimestampMs) return false;
    if (opts.alias && em.to.toLowerCase() !== opts.alias.toLowerCase()) {
      return false;
    }
    if (opts.domain && !domainsMatch(em.senderDomain || em.from, opts.domain)) {
      return false;
    }
    return true;
  }

  async waitForEmailOtp(opts: {
    domain?: string;
    alias?: string;
    waitSeconds?: number;
  }): Promise<DecryptedEmailWithMeta> {
    await this.sync();
    if (!this.emailPrivateKeyPkcs8B64) {
      throw new Error('Email OTP decryption requires an owner session (not Service Account)');
    }

    const lookbackMs = Date.now() - 5 * 60 * 1000;
    const existing = this.emails.find((em) =>
      this.matchesEmailFilter(em, {
        domain: opts.domain,
        alias: opts.alias,
        minTimestampMs: lookbackMs,
      })
    );
    if (existing) return existing;

    const waitSeconds = opts.waitSeconds ?? 0;
    if (waitSeconds <= 0) {
      throw new Error('No matching email OTP code found');
    }

    const base = this.getServerUrl();
    const wsBase = base.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
    const wsUrl = `${wsBase}/api/ws?token=${encodeURIComponent(this.sessionToken!)}`;
    const privKey = this.emailPrivateKeyPkcs8B64;

    return new Promise<DecryptedEmailWithMeta>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`Timed out after ${waitSeconds}s waiting for email OTP`));
      }, waitSeconds * 1000);

      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      ws.on('message', async (raw) => {
        if (settled) return;
        try {
          const msg = JSON.parse(String(raw)) as {
            type: string;
            email?: EncryptedEmailRecord;
          };
          if (msg.type !== 'email.received' || !msg.email) return;
          const opened = await openSealedJson<DecryptedEmailPayload>(
            privKey,
            msg.email.sealedEnvelope
          );
          const candidate: DecryptedEmailWithMeta = {
            ...opened,
            id: msg.email.id,
            source: msg.email.source,
            envelopeTo: msg.email.envelopeTo,
          };
          if (
            this.matchesEmailFilter(candidate, {
              domain: opts.domain,
              alias: opts.alias,
              minTimestampMs: lookbackMs,
            })
          ) {
            settled = true;
            clearTimeout(timer);
            ws.close();
            resolve(candidate);
          }
        } catch {
          // ignore unparseable event
        }
      });
    });
  }

  async createAlias(
    siteDomain: string,
    address?: string,
    vaultId?: string,
    itemId?: string
  ): Promise<AliasRecord> {
    await this.ensureAuthenticated();
    const res = await this.requestJson<{ alias: AliasRecord }>('/api/aliases', {
      method: 'POST',
      body: JSON.stringify({ siteDomain, address, vaultId, itemId }),
    });
    return res.alias;
  }

  async toggleAlias(idOrAddress: string, enabled?: boolean): Promise<AliasRecord> {
    await this.sync();
    const found = this.aliases.find(
      (a) => a.id === idOrAddress || a.address.toLowerCase() === idOrAddress.toLowerCase()
    );
    if (!found) throw new Error(`Alias not found: ${idOrAddress}`);
    const nextEnabled = enabled !== undefined ? enabled : !found.enabled;
    const res = await this.requestJson<{ alias: AliasRecord }>(`/api/aliases/${found.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    return res.alias;
  }

  async listServiceAccounts(): Promise<ServiceAccountRecord[]> {
    await this.ensureAuthenticated();
    const res = await this.requestJson<{ serviceAccounts: ServiceAccountRecord[] }>(
      '/api/service-accounts'
    );
    return res.serviceAccounts;
  }

  async createServiceAccount(
    name: string,
    vaultNamesOrIds: string[]
  ): Promise<{ serviceAccount: ServiceAccountRecord; token: string }> {
    await this.sync();
    if (this.activeMode !== 'owner') {
      throw new Error('Only owner session can create Service Accounts');
    }

    const saId = `sa_${randomId().replace(/-/g, '').slice(0, 16)}`;
    const authSecret = toBase64Url(randomBytes(24));
    const wrapKey = generateRawAesKey();

    const targetVaults = vaultNamesOrIds.map((v) => this.findVault(v));
    const vaultKeys = await Promise.all(
      targetVaults.map(async (v) => ({
        vaultId: v.id,
        encryptedVaultKey: await encryptBytes(wrapKey, v.keyBytes, AAD.vaultSaKey(v.id, saId)),
      }))
    );

    const res = await this.requestJson<{ serviceAccount: ServiceAccountRecord }>(
      '/api/service-accounts',
      {
        method: 'POST',
        body: JSON.stringify({ id: saId, name, authSecret, vaultKeys }),
      }
    );

    const token = encodeServiceAccountToken({
      v: 1,
      serverUrl: this.getServerUrl(),
      tokenId: saId,
      authSecret,
      wrapKeyB64: toBase64Url(wrapKey),
    });

    return { serviceAccount: res.serviceAccount, token };
  }

  async revokeServiceAccount(id: string): Promise<void> {
    await this.ensureAuthenticated();
    await this.requestJson(`/api/service-accounts/${id}`, { method: 'DELETE' });
  }
}
