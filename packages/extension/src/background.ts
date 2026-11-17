import {
  AAD,
  decryptBytes,
  decryptJson,
  deriveAccountKeys,
  domainsMatch,
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
}

let memoryFallbackSession: SessionCache | null = null;
let activeWs: WebSocket | null = null;

async function getPrefs(): Promise<LocalPrefs> {
  const res = await chrome.storage.local.get(['serverUrl', 'email', 'secretKey']);
  return res as LocalPrefs;
}

async function setPrefs(prefs: LocalPrefs): Promise<void> {
  await chrome.storage.local.set(prefs);
}

async function getSession(): Promise<SessionCache | null> {
  try {
    if (chrome.storage.session) {
      const res = await chrome.storage.session.get('session');
      if (res.session) return res.session as SessionCache;
    }
  } catch {
    // ignore
  }
  return memoryFallbackSession;
}

async function saveSession(session: SessionCache | null): Promise<void> {
  memoryFallbackSession = session;
  try {
    if (chrome.storage.session) {
      if (session) await chrome.storage.session.set({ session });
      else await chrome.storage.session.remove('session');
    }
  } catch {
    // ignore
  }
}

function urlsMatchWithLocalhost(urlA: string, urlB: string): boolean {
  const hostA = extractHost(urlA);
  const hostB = extractHost(urlB);
  if (!hostA || !hostB) return false;
  if (
    (hostA === 'localhost' || hostA === '127.0.0.1') &&
    (hostB === 'localhost' || hostB === '127.0.0.1')
  ) {
    return true;
  }
  return domainsMatch(urlA, urlB);
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
  prevPending: Record<number, PendingLoginRelay> = {}
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
            await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
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
            if (matchesPending || matchesUrl || matchesAnyLogin || tabUrl.includes('/demo-login')) {
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
            current.pendingByTab
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
  const session = await getSession();
  if (!session) {
    return { unlocked: false, logins: [], pendingItem: null, latestOtpEmail: null };
  }

  const now = Date.now();
  const pending = tabId ? session.pendingByTab[tabId] : undefined;
  const activePending = pending && pending.expiresAt > now ? pending : undefined;

  const matchedItems = session.items.filter(
    (item) =>
      item.category === 'login' &&
      (item.urls.some((u) => urlsMatchWithLocalhost(tabUrl, u)) ||
        (activePending && item.id === activePending.itemId))
  );

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
    pendingItem: pendingEntry,
    latestOtpEmail,
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
          sendResponse({
            ok: true,
            unlocked: Boolean(session),
            prefs,
            vaults: session?.vaults ?? [],
            items: session?.items ?? [],
            emails: session?.decryptedEmails ?? [],
            aliasDomain: session?.aliasDomain ?? '',
          });
          return;
        }

        case 'NONEPWD_UNLOCK': {
          const serverUrl = String(message.serverUrl || '').replace(/\/+$/, '');
          const secretKey = String(message.secretKey || '');
          const masterPassword = String(message.masterPassword || '');

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
            keyset.emailPrivateKeyPkcs8B64
          );
          await saveSession(session);
          connectWs(session);
          await chrome.action.setBadgeText({ text: '' });
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
            session.pendingByTab
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
void initNonePwdCore().then(() =>
  getSession().then((s) => {
    if (s) connectWs(s);
  })
);
