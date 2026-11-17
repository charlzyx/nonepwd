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

export function urlsMatchWithLocalhost(urlA: string, urlB: string): boolean {
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
