import {
  AAD,
  decryptBytes,
  decryptJson,
  deriveAccountKeys,
  encryptJson,
  extractHost,
  fromBase64Url,
  generatePassword,
  generateTotp,
  initNonePwdCore,
  openSealedJson,
  randomId,
  type AliasRecord,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type EncryptedItemRecord,
  type EncryptedVaultRecord,
  type RootKeysetPayload,
  type VaultItemPayload,
  type VaultMetadata,
} from '@nonepwd/core';

import {
  classifyCapturedCredential,
  urlsMatchWithLocalhost,
  type PendingCredentialCapture,
} from './capture.js';
import { unlockDurationToMs, type UnlockDuration } from './theme.js';
import type { ExtendedVaultItem } from './types.js';

const PERSISTED_SESSION_KEY = 'nonepwd_persisted_session';

interface LocalPrefs {
  serverUrl?: string;
  email?: string;
  secretKey?: string;
}

interface PendingLoginRelay {
  itemId: string;
  title: string;
  domain: string;
  emailAlias?: string;
  expiresAt: number;
}

interface SessionCache {
  serverUrl: string;
  token: string;
  rootKeyB64: string;
  emailPrivateKeyPkcs8B64: string;
  aliasDomain: string;
  vaults: Array<{ id: string; name: string; keyB64: string }>;
  items: VaultItemPayload[];
  decryptedEmails: Array<DecryptedEmailPayload & { id: string }>;
  pendingByTab: Record<number, PendingLoginRelay>;
  expiresAt?: number;
}

let memoryFallbackSession: SessionCache | null = null;
let memoryPendingCaptures: Record<string, PendingCredentialCapture> = {};
let activeWs: WebSocket | null = null;

async function getPrefs(): Promise<LocalPrefs> {
  const res = await chrome.storage.local.get(['serverUrl', 'email', 'secretKey']);
  return res as LocalPrefs;
}

async function setPrefs(prefs: LocalPrefs): Promise<void> {
  await chrome.storage.local.set(prefs);
}

async function getNeverSaveDomains(): Promise<string[]> {
  const res = await chrome.storage.local.get('neverSaveDomains');
  return Array.isArray(res.neverSaveDomains) ? (res.neverSaveDomains as string[]) : [];
}

async function addNeverSaveDomain(host: string): Promise<void> {
  const clean = host.trim().toLowerCase();
  if (!clean) return;
  const existing = await getNeverSaveDomains();
  if (existing.some((d) => d.toLowerCase() === clean)) return;
  await chrome.storage.local.set({ neverSaveDomains: [...existing, clean] });
}

async function getPendingCaptures(): Promise<Record<string, PendingCredentialCapture>> {
  let raw: Record<string, PendingCredentialCapture> = memoryPendingCaptures;
  try {
    if (chrome.storage.session) {
      const res = await chrome.storage.session.get('pendingCaptures');
      if (res.pendingCaptures && typeof res.pendingCaptures === 'object') {
        raw = res.pendingCaptures as Record<string, PendingCredentialCapture>;
      }
    }
  } catch {
    // ignore
  }
  const now = Date.now();
  const pruned: Record<string, PendingCredentialCapture> = {};
  let changed = false;
  for (const [k, v] of Object.entries(raw)) {
    if (v && v.expiresAt > now) {
      pruned[k] = v;
    } else {
      changed = true;
    }
  }
  if (changed) {
    await savePendingCaptures(pruned);
  }
  return pruned;
}

async function savePendingCaptures(captures: Record<string, PendingCredentialCapture>): Promise<void> {
  memoryPendingCaptures = captures;
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ pendingCaptures: captures });
    }
  } catch {
    // ignore
  }
}

async function getPendingCaptureForTab(tabId?: number): Promise<PendingCredentialCapture | null> {
  const captures = await getPendingCaptures();
  if (tabId !== undefined) {
    return captures[String(tabId)] ?? null;
  }
  const sorted = Object.values(captures).sort((a, b) => b.capturedAt - a.capturedAt);
  return sorted[0] ?? null;
}

async function clearSession(): Promise<void> {
  memoryFallbackSession = null;
  try {
    await chrome.storage.session?.remove('session');
  } catch {
    // ignore
  }
  try {
    await chrome.storage.local?.remove(PERSISTED_SESSION_KEY);
  } catch {
    // ignore
  }
}

async function getSession(): Promise<SessionCache | null> {
  let candidate: SessionCache | null = null;
  try {
    if (chrome.storage.session) {
      const res = await chrome.storage.session.get('session');
      if (res.session) candidate = res.session as SessionCache;
    }
  } catch {
    // ignore
  }
  if (!candidate) {
    candidate = memoryFallbackSession;
  }
  if (!candidate) {
    try {
      const localRes = await chrome.storage.local?.get(PERSISTED_SESSION_KEY);
      const persisted = localRes?.[PERSISTED_SESSION_KEY] as SessionCache | undefined;
      if (persisted?.token && persisted?.rootKeyB64) {
        candidate = persisted;
        memoryFallbackSession = persisted;
        await chrome.storage.session?.set({ session: persisted }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }
  if (candidate?.expiresAt && Date.now() >= candidate.expiresAt) {
    await clearSession();
    return null;
  }
  return candidate;
}

async function saveSession(session: SessionCache | null): Promise<void> {
  if (!session) {
    await clearSession();
    return;
  }
  memoryFallbackSession = session;
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ session });
    }
  } catch {
    // ignore
  }
  try {
    if (session.expiresAt && session.expiresAt > Date.now()) {
      await chrome.storage.local?.set({ [PERSISTED_SESSION_KEY]: session });
    } else {
      await chrome.storage.local?.remove(PERSISTED_SESSION_KEY);
    }
  } catch {
    // ignore
  }
}

async function apiJson<T>(serverUrl: string, path: string, token?: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}${path}`, { ...init, headers });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function decryptSessionSync(
  serverUrl: string,
  token: string,
  rootKeyB64: string,
  emailPrivateKeyPkcs8B64: string,
  prevPending: Record<number, PendingLoginRelay> = {},
  expiresAt?: number
): Promise<SessionCache> {
  const rootKeyBytes = fromBase64Url(rootKeyB64);
  const syncData = await apiJson<{
    account: { aliasDomain: string };
    vaults: EncryptedVaultRecord[];
    items: EncryptedItemRecord[];
    emails: EncryptedEmailRecord[];
  }>(serverUrl, '/api/sync', token);

  const vaults: SessionCache['vaults'] = [];
  const keyMap = new Map<string, Uint8Array>();

  for (const v of syncData.vaults) {
    const vk = await decryptBytes(rootKeyBytes, v.encryptedKey, AAD.vaultOwnerKey(v.id));
    const meta = await decryptJson<VaultMetadata>(vk, v.encryptedMeta, AAD.vaultMeta(v.id));
    keyMap.set(v.id, vk);
    vaults.push({
      id: v.id,
      name: meta.name,
      keyB64: btoa(String.fromCharCode(...vk)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    });
  }

  const items: VaultItemPayload[] = [];
  for (const it of syncData.items) {
    const vk = keyMap.get(it.vaultId);
    if (!vk) continue;
    try {
      const payload = await decryptJson<VaultItemPayload>(
        vk,
        it.encryptedData,
        AAD.vaultItem(it.vaultId, it.id)
      );
      items.push(payload);
    } catch {
      // skip
    }
  }

  const decryptedEmails: SessionCache['decryptedEmails'] = [];
  for (const em of syncData.emails) {
    try {
      const opened = await openSealedJson<DecryptedEmailPayload>(
        emailPrivateKeyPkcs8B64,
        em.sealedEnvelope
      );
      decryptedEmails.push({ ...opened, id: em.id });
    } catch {
      // skip
    }
  }

  return {
    serverUrl,
    token,
    rootKeyB64,
    emailPrivateKeyPkcs8B64,
    aliasDomain: syncData.account.aliasDomain ?? '',
    vaults,
    items,
    decryptedEmails,
    pendingByTab: prevPending,
    expiresAt,
  };
}

function connectWs(session: SessionCache): void {
  if (activeWs) {
    try {
      activeWs.close();
    } catch {
      // ignore
    }
    activeWs = null;
  }

  const wsUrl =
    session.serverUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://') +
    `/api/ws?token=${encodeURIComponent(session.token)}`;

  try {
    const ws = new WebSocket(wsUrl);
    activeWs = ws;

    ws.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as {
          type: string;
          email?: EncryptedEmailRecord;
        };
        const current = await getSession();
        if (!current) return;

        if (msg.type === 'email.received' && msg.email) {
          const opened = await openSealedJson<DecryptedEmailPayload>(
            current.emailPrivateKeyPkcs8B64,
            msg.email.sealedEnvelope
          );
          const emailItem = { ...opened, id: msg.email.id };
          current.decryptedEmails = [
            emailItem,
            ...current.decryptedEmails.filter((e) => e.id !== emailItem.id),
          ].slice(0, 100);
          await saveSession(current);

          if (emailItem.otpCode) {
            await chrome.action.setBadgeText({ text: 'OTP' });
            await chrome.action.setBadgeBackgroundColor({ color: '#171717' });
          }

          // Broadcast live OTP to open tabs
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (!tab.id) continue;
            const tabUrl = tab.url ?? '';
            const pending = current.pendingByTab[tab.id];
            const matchesPending =
              pending &&
              pending.expiresAt > Date.now() &&
              ((pending.emailAlias && emailItem.to.toLowerCase() === pending.emailAlias.toLowerCase()) ||
                urlsMatchWithLocalhost(pending.domain, emailItem.senderDomain));
            const matchesUrl = tabUrl && urlsMatchWithLocalhost(tabUrl, emailItem.senderDomain);
            const matchesAnyLogin = current.items.some(
              (it) =>
                it.urls.some((u) => tabUrl && urlsMatchWithLocalhost(tabUrl, u)) &&
                ((it.emailAlias && emailItem.to.toLowerCase() === it.emailAlias.toLowerCase()) ||
                  urlsMatchWithLocalhost(tabUrl, emailItem.senderDomain))
            );
            if (matchesPending || matchesUrl || matchesAnyLogin) {
              try {
                await chrome.tabs.sendMessage(tab.id, {
                  type: 'NONEPWD_LIVE_OTP',
                  email: emailItem,
                });
              } catch {
                // tab might not have content script loaded
              }
            }
          }
        } else if (
          msg.type === 'item.upserted' ||
          msg.type === 'item.deleted' ||
          msg.type === 'vault.upserted'
        ) {
          const refreshed = await decryptSessionSync(
            current.serverUrl,
            current.token,
            current.rootKeyB64,
            current.emailPrivateKeyPkcs8B64,
            current.pendingByTab,
            current.expiresAt
          );
          await saveSession(refreshed);
        }
      } catch {
        // ignore
      }
    };
  } catch {
    // ignore ws failure
  }
}

async function queryForTabUrl(tabUrl: string, tabId?: number) {
  const pendingCapture = await getPendingCaptureForTab(tabId);
  const session = await getSession();
  if (!session) {
    return {
      unlocked: false,
      logins: [],
      cards: [],
      identities: [],
      pendingItem: null,
      latestOtpEmail: null,
      pendingCapture,
    };
  }

  const now = Date.now();
  const pending = tabId ? session.pendingByTab[tabId] : undefined;
  const activePending = pending && pending.expiresAt > now ? pending : undefined;

  const allItems = session.items as ExtendedVaultItem[];

  const matchedItems = allItems.filter(
    (item) =>
      item.category === 'login' &&
      (item.urls.some((u) => urlsMatchWithLocalhost(tabUrl, u)) ||
        (activePending && item.id === activePending.itemId))
  );

  const sortByRelevance = (a: ExtendedVaultItem, b: ExtendedVaultItem) => {
    const aMatch = a.urls.some((u) => urlsMatchWithLocalhost(tabUrl, u)) ? 1 : 0;
    const bMatch = b.urls.some((u) => urlsMatchWithLocalhost(tabUrl, u)) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return 0;
  };

  const cards = allItems.filter((item) => item.category === 'card' && item.card).sort(sortByRelevance);
  const identities = allItems
    .filter((item) => item.category === 'identity' && item.identity)
    .sort(sortByRelevance);

  const loginsWithTotp = await Promise.all(
    matchedItems.map(async (item) => {
      let totpCode: string | null = null;
      let totpRemaining = 0;
      if (item.totp) {
        try {
          const res = await generateTotp(item.totp);
          totpCode = res.code;
          totpRemaining = res.remainingSeconds;
        } catch {
          // ignore invalid secret
        }
      }
      return { item, totpCode, totpRemaining };
    })
  );

  const pendingEntry = activePending
    ? loginsWithTotp.find((x) => x.item.id === activePending.itemId) ?? null
    : null;

  const recentCutoff = now - 15 * 60 * 1000;
  const latestOtpEmail =
    session.decryptedEmails.find((em) => {
      if (!em.otpCode) return false;
      if (new Date(em.receivedAt).getTime() < recentCutoff) return false;
      if (activePending?.emailAlias && em.to.toLowerCase() === activePending.emailAlias.toLowerCase()) {
        return true;
      }
      if (urlsMatchWithLocalhost(tabUrl, em.senderDomain)) return true;
      return matchedItems.some(
        (it) => it.emailAlias && em.to.toLowerCase() === it.emailAlias.toLowerCase()
      );
    }) ?? null;

  return {
    unlocked: true,
    aliasDomain: session.aliasDomain,
    logins: loginsWithTotp,
    cards,
    identities,
    pendingItem: pendingEntry,
    latestOtpEmail,
    pendingCapture,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      await initNonePwdCore();
      switch (message?.type) {
        case 'NONEPWD_GET_STATE': {
          const prefs = await getPrefs();
          const session = await getSession();
          const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
          const pendingCapture = await getPendingCaptureForTab(tabId);
          sendResponse({
            ok: true,
            unlocked: Boolean(session),
            expiresAt: session?.expiresAt ?? null,
            prefs,
            vaults: session?.vaults ?? [],
            items: session?.items ?? [],
            emails: session?.decryptedEmails ?? [],
            aliasDomain: session?.aliasDomain ?? '',
            pendingCapture,
          });
          return;
        }

        case 'NONEPWD_UNLOCK': {
          const serverUrl = String(message.serverUrl || '').replace(/\/+$/, '');
          const secretKey = String(message.secretKey || '');
          const masterPassword = String(message.masterPassword || '');
          const rememberDuration = (message.rememberDuration as UnlockDuration | undefined) ?? '24h';
          const durationMs = unlockDurationToMs(rememberDuration);
          const expiresAt = durationMs ? Date.now() + durationMs : undefined;

          const params = await apiJson<{
            initialized: boolean;
            email?: string;
            kdfSalt?: string;
            kdfIterations?: number;
          }>(serverUrl, '/api/auth/params');

          if (!params.initialized || !params.kdfSalt || !params.kdfIterations) {
            throw new Error('nonepwd server is not initialized yet');
          }

          const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
            masterPassword,
            secretKey,
            params.kdfSalt,
            params.kdfIterations
          );

          const loginRes = await apiJson<{
            token: string;
            account: { email: string; encryptedRootKeyset: string };
          }>(serverUrl, '/api/auth/login', undefined, {
            method: 'POST',
            body: JSON.stringify({ authVerifier: authVerifierB64 }),
          });

          const keyset = await decryptJson<RootKeysetPayload>(
            masterUnlockKeyBytes,
            loginRes.account.encryptedRootKeyset,
            AAD.ROOT_KEYSET
          );

          await setPrefs({
            serverUrl,
            email: loginRes.account.email,
            secretKey,
          });

          const session = await decryptSessionSync(
            serverUrl,
            loginRes.token,
            keyset.rootKeyB64,
            keyset.emailPrivateKeyPkcs8B64,
            {},
            expiresAt
          );
          await saveSession(session);
          connectWs(session);

          const neverSaveDomains = await getNeverSaveDomains();
          const existingCaptures = await getPendingCaptures();
          const nextCaptures: Record<string, PendingCredentialCapture> = {};
          for (const [k, cap] of Object.entries(existingCaptures)) {
            const recheck = classifyCapturedCredential({
              url: cap.url,
              username: cap.username,
              password: cap.password,
              items: session.items,
              neverSaveDomains,
            });
            if (recheck.action === 'skip') continue;
            nextCaptures[k] = {
              ...cap,
              mode: recheck.action,
              title: recheck.title,
              existingItemId: recheck.action === 'update' ? recheck.existingItem.id : undefined,
              existingVaultId:
                recheck.action === 'update' ? recheck.existingItem.vaultId : undefined,
            };
          }
          await savePendingCaptures(nextCaptures);
          await chrome.action.setBadgeText({
            text: Object.keys(nextCaptures).length > 0 ? 'SAVE' : '',
          });
          if (Object.keys(nextCaptures).length > 0) {
            await chrome.action.setBadgeBackgroundColor({ color: '#3555f5' });
          }
          sendResponse({ ok: true });
          return;
        }

        case 'NONEPWD_LOCK': {
          const session = await getSession();
          if (session) {
            try {
              await apiJson(session.serverUrl, '/api/auth/logout', session.token, {
                method: 'POST',
              });
            } catch {
              // ignore
            }
          }
          activeWs?.close();
          activeWs = null;
          await saveSession(null);
          await savePendingCaptures({});
          await chrome.action.setBadgeText({ text: '' });
          sendResponse({ ok: true });
          return;
        }

        case 'NONEPWD_SYNC': {
          const session = await getSession();
          if (!session) throw new Error('Locked');
          const refreshed = await decryptSessionSync(
            session.serverUrl,
            session.token,
            session.rootKeyB64,
            session.emailPrivateKeyPkcs8B64,
            session.pendingByTab,
            session.expiresAt
          );
          await saveSession(refreshed);
          sendResponse({ ok: true });
          return;
        }

        case 'NONEPWD_QUERY_TAB': {
          const tabUrl = String(message.url || sender.tab?.url || '');
          const tabId = message.tabId ?? sender.tab?.id;
          const res = await queryForTabUrl(tabUrl, tabId);
          sendResponse({ ok: true, ...res });
          return;
        }

        case 'NONEPWD_RECORD_FILL': {
          const session = await getSession();
          const tabId = sender.tab?.id ?? message.tabId;
          if (session && tabId) {
            session.pendingByTab[tabId] = {
              itemId: message.itemId,
              title: message.title,
              domain: message.url || sender.tab?.url || '',
              emailAlias: message.emailAlias,
              expiresAt: Date.now() + 120_000,
            };
            await saveSession(session);
          }
          sendResponse({ ok: true });
          return;
        }

        case 'NONEPWD_CREATE_SIGNUP_LOGIN': {
          const session = await getSession();
          if (!session) throw new Error('Vault is locked');
          const vault = session.vaults[0];
          if (!vault) throw new Error('No vault found');

          const pageUrl = String(message.url || sender.tab?.url || '');
          const host = extractHost(pageUrl) || 'site';
          const password = generatePassword({ length: 20 });
          let emailAlias: string | undefined;

          if (message.withAlias && session.aliasDomain) {
            const aliasRes = await apiJson<{ alias: AliasRecord }>(
              session.serverUrl,
              '/api/aliases',
              session.token,
              {
                method: 'POST',
                body: JSON.stringify({ siteDomain: host, vaultId: vault.id }),
              }
            );
            emailAlias = aliasRes.alias.address;
          }

          const id = randomId();
          const now = new Date().toISOString();
          const payload: VaultItemPayload = {
            id,
            vaultId: vault.id,
            category: 'login',
            title: host,
            favorite: false,
            tags: ['autofill-signup'],
            urls: pageUrl ? [pageUrl] : [],
            username: emailAlias,
            password,
            emailAlias,
            customFields: [],
            createdAt: now,
            updatedAt: now,
          };

          const vkBytes = fromBase64Url(vault.keyB64);
          const encryptedData = await encryptJson(
            vkBytes,
            payload,
            AAD.vaultItem(vault.id, id)
          );

          await apiJson(session.serverUrl, `/api/vaults/${vault.id}/items`, session.token, {
            method: 'POST',
            body: JSON.stringify({ id, encryptedData }),
          });

          session.items = [payload, ...session.items];
          await saveSession(session);
          sendResponse({ ok: true, item: payload });
          return;
        }

        case 'NONEPWD_CAPTURE_CREDENTIAL': {
          const pageUrl = String(message.url || sender.tab?.url || '');
          const username = String(message.username || '').trim();
          const password = String(message.password || '');
          const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

          const neverSaveDomains = await getNeverSaveDomains();
          const session = await getSession();

          const classification = classifyCapturedCredential({
            url: pageUrl,
            username,
            password,
            items: session?.items ?? [],
            neverSaveDomains,
          });

          if (classification.action === 'skip') {
            sendResponse({ ok: true, prompt: null, unlocked: Boolean(session) });
            return;
          }

          const now = Date.now();
          const capture: PendingCredentialCapture = {
            id: randomId(),
            tabId,
            url: pageUrl,
            originUrl: classification.originUrl,
            host: classification.host,
            title: classification.title,
            username,
            password,
            mode: classification.action,
            existingItemId:
              classification.action === 'update' ? classification.existingItem.id : undefined,
            existingVaultId:
              classification.action === 'update' ? classification.existingItem.vaultId : undefined,
            capturedAt: now,
            expiresAt: now + 10 * 60_000,
          };

          const captures = await getPendingCaptures();
          captures[String(tabId ?? 'latest')] = capture;
          await savePendingCaptures(captures);

          await chrome.action.setBadgeText({ text: 'SAVE' });
          await chrome.action.setBadgeBackgroundColor({ color: '#3555f5' });

          if (tabId !== undefined) {
            setTimeout(() => {
              void chrome.tabs
                .sendMessage(tabId, {
                  type: 'NONEPWD_PROMPT_SAVE',
                  capture,
                  unlocked: Boolean(session),
                })
                .catch(() => {});
            }, 450);
          }

          sendResponse({ ok: true, prompt: capture, unlocked: Boolean(session) });
          return;
        }

        case 'NONEPWD_CONFIRM_SAVE_CREDENTIAL': {
          const session = await getSession();
          if (!session) throw new Error('请先解锁 NonePwd 密码库');

          const captures = await getPendingCaptures();
          const captureId = typeof message.captureId === 'string' ? message.captureId : undefined;
          const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

          let matchedKey: string | undefined;
          let capture: PendingCredentialCapture | undefined;
          for (const [k, v] of Object.entries(captures)) {
            if (captureId && v.id === captureId) {
              matchedKey = k;
              capture = v;
              break;
            }
          }
          if (!capture && tabId !== undefined && captures[String(tabId)]) {
            matchedKey = String(tabId);
            capture = captures[matchedKey];
          }
          if (!capture) {
            const latestEntry = Object.entries(captures).sort(
              (a, b) => b[1].capturedAt - a[1].capturedAt
            )[0];
            if (latestEntry) {
              matchedKey = latestEntry[0];
              capture = latestEntry[1];
            }
          }
          if (!capture) throw new Error('待保存凭据已过期，请重新登录捕获');

          const finalUsername = String(message.username ?? capture.username).trim();
          const finalPassword = String(message.password ?? capture.password);
          const finalTitle = String(message.title ?? capture.title).trim() || capture.host;
          if (!finalPassword) throw new Error('密码不能为空');

          const nowIso = new Date().toISOString();
          let savedItem: VaultItemPayload;
          let savedMode: 'create' | 'update' = 'create';

          const existing =
            capture.mode === 'update' && capture.existingItemId
              ? session.items.find((it) => it.id === capture!.existingItemId)
              : undefined;

          if (existing) {
            const targetVault =
              session.vaults.find((v) => v.id === (capture!.existingVaultId ?? existing.vaultId)) ??
              session.vaults[0];
            if (!targetVault) throw new Error('No vault found');

            const nextUrls = [...existing.urls];
            if (!nextUrls.some((u) => urlsMatchWithLocalhost(capture!.originUrl, u))) {
              nextUrls.push(capture!.originUrl);
            }

            savedItem = {
              ...existing,
              title: finalTitle || existing.title,
              username: finalUsername || existing.username,
              password: finalPassword,
              urls: nextUrls,
              updatedAt: nowIso,
            };
            savedMode = 'update';

            const vkBytes = fromBase64Url(targetVault.keyB64);
            const encryptedData = await encryptJson(
              vkBytes,
              savedItem,
              AAD.vaultItem(targetVault.id, savedItem.id)
            );
            await apiJson(
              session.serverUrl,
              `/api/vaults/${targetVault.id}/items/${savedItem.id}`,
              session.token,
              {
                method: 'PUT',
                body: JSON.stringify({ encryptedData }),
              }
            );
            session.items = session.items.map((it) => (it.id === savedItem.id ? savedItem : it));
          } else {
            const vault = session.vaults[0];
            if (!vault) throw new Error('No vault found');

            const id = randomId();
            savedItem = {
              id,
              vaultId: vault.id,
              category: 'login',
              title: finalTitle,
              favorite: false,
              tags: ['browser-captured'],
              urls: capture.originUrl ? [capture.originUrl] : [],
              username: finalUsername || undefined,
              password: finalPassword,
              customFields: [],
              createdAt: nowIso,
              updatedAt: nowIso,
            };

            const vkBytes = fromBase64Url(vault.keyB64);
            const encryptedData = await encryptJson(
              vkBytes,
              savedItem,
              AAD.vaultItem(vault.id, id)
            );
            await apiJson(session.serverUrl, `/api/vaults/${vault.id}/items`, session.token, {
              method: 'POST',
              body: JSON.stringify({ id, encryptedData }),
            });
            session.items = [savedItem, ...session.items];
          }

          if (matchedKey) {
            delete captures[matchedKey];
          }
          await savePendingCaptures(captures);
          await saveSession(session);
          await chrome.action.setBadgeText({
            text: Object.keys(captures).length > 0 ? 'SAVE' : '',
          });

          sendResponse({ ok: true, item: savedItem, mode: savedMode });
          return;
        }

        case 'NONEPWD_DISMISS_SAVE_CREDENTIAL': {
          const captures = await getPendingCaptures();
          const captureId = typeof message.captureId === 'string' ? message.captureId : undefined;
          const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

          for (const [k, v] of Object.entries(captures)) {
            if ((captureId && v.id === captureId) || (tabId !== undefined && k === String(tabId))) {
              delete captures[k];
            }
          }
          await savePendingCaptures(captures);

          if (message.neverForSite && message.host) {
            await addNeverSaveDomain(String(message.host));
          }

          await chrome.action.setBadgeText({
            text: Object.keys(captures).length > 0 ? 'SAVE' : '',
          });
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return true;
});

// Wake up WebSocket when worker restarts if session is still alive in chrome.storage.session
function refreshActionIcon() {
  if (typeof chrome !== 'undefined' && chrome.action?.setIcon) {
    void chrome.action
      .setIcon({
        path: {
          16: 'icons/icon16.png',
          32: 'icons/icon32.png',
          48: 'icons/icon48.png',
          128: 'icons/icon128.png',
        },
      })
      .catch(() => {});
  }
}

refreshActionIcon();
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    refreshActionIcon();
  });
}

void initNonePwdCore().then(() =>
  getSession().then((s) => {
    if (s) connectWs(s);
  })
);
