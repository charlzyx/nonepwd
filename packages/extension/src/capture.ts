import { domainsMatch, extractHost, type VaultItemPayload } from '@nonepwd/core';

export interface PendingCredentialCapture {
  id: string;
  tabId?: number;
  url: string;
  originUrl: string;
  host: string;
  title: string;
  username: string;
  password: string;
  mode: 'create' | 'update';
  existingItemId?: string;
  existingVaultId?: string;
  capturedAt: number;
  expiresAt: number;
}

export type CaptureClassification =
  | { action: 'skip' }
  | { action: 'create'; host: string; originUrl: string; title: string }
  | {
      action: 'update';
      host: string;
      originUrl: string;
      title: string;
      existingItem: VaultItemPayload;
    };

function parseUrlParts(raw: string): { protocol: string | null; host: string; port: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  try {
    const parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    return {
      protocol: hasScheme ? parsed.protocol.toLowerCase() : null,
      host: parsed.hostname.toLowerCase(),
      port: parsed.port,
    };
  } catch {
    return null;
  }
}

export function urlsMatchWithLocalhost(pageUrl: string, storedUrl: string): boolean {
  const hostA = extractHost(pageUrl);
  const hostB = extractHost(storedUrl);
  if (!hostA || !hostB) return false;

  const partsA = parseUrlParts(pageUrl);
  const partsB = parseUrlParts(storedUrl);

  // Reject https -> http protocol downgrades when stored URL explicitly requires HTTPS
  if (partsB?.protocol === 'https:' && partsA?.protocol === 'http:') {
    return false;
  }

  const isLocalhost = (h: string) => h === 'localhost' || h === '127.0.0.1';
  if (isLocalhost(hostA) || isLocalhost(hostB)) {
    if (!(isLocalhost(hostA) && isLocalhost(hostB))) {
      return false;
    }
    const storedPort = partsB?.port || '';
    if (storedPort) {
      const pagePort =
        partsA?.port ||
        (partsA?.protocol === 'https:' ? '443' : partsA?.protocol === 'http:' ? '80' : '');
      if (pagePort !== storedPort) {
        return false;
      }
    }
    return true;
  }

  return domainsMatch(pageUrl, storedUrl);
}

export function normalizeOriginUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

export function classifyCapturedCredential(params: {
  url: string;
  username: string;
  password: string;
  items: VaultItemPayload[];
  neverSaveDomains?: string[];
}): CaptureClassification {
  if (!params.password) {
    return { action: 'skip' };
  }

  const lowerUrl = params.url.toLowerCase();
  if (
    lowerUrl.startsWith('chrome://') ||
    lowerUrl.startsWith('chrome-extension://') ||
    lowerUrl.startsWith('edge://') ||
    lowerUrl.startsWith('brave://') ||
    lowerUrl.startsWith('about:')
  ) {
    return { action: 'skip' };
  }

  const host = extractHost(params.url);
  if (!host) {
    return { action: 'skip' };
  }

  const blocked = (params.neverSaveDomains ?? []).some(
    (d) => d.trim().toLowerCase() === host.toLowerCase()
  );
  if (blocked) {
    return { action: 'skip' };
  }

  const originUrl = normalizeOriginUrl(params.url);
  const siteItems = params.items.filter(
    (item) =>
      item.category === 'login' && item.urls.some((u) => urlsMatchWithLocalhost(params.url, u))
  );

  const candUser = params.username.trim().toLowerCase();

  // Exact credential already saved -> skip
  const exactMatch = siteItems.some((item) => {
    if (item.password !== params.password) return false;
    if (!candUser) return true;
    const savedUser = (item.username || item.emailAlias || '').trim().toLowerCase();
    return savedUser === candUser;
  });
  if (exactMatch) {
    return { action: 'skip' };
  }

  // Same site + username (or sole username-less site item) with a new password -> update
  const updateTarget = siteItems.find((item) => {
    const savedUser = (item.username || item.emailAlias || '').trim().toLowerCase();
    if (candUser) {
      return savedUser === candUser;
    }
    return siteItems.length === 1 && !savedUser;
  });

  if (updateTarget) {
    return {
      action: 'update',
      host,
      originUrl,
      title: updateTarget.title || host,
      existingItem: updateTarget,
    };
  }

  return {
    action: 'create',
    host,
    originUrl,
    title: host,
  };
}
