import { host } from "nsh";
import type { DecryptedEmailItem, VaultItemPayload } from "./crypto";

export interface AndroidAutofillStatus {
  available: boolean;
  supported: boolean;
  enabled: boolean;
}

export interface AndroidAutofillCredential {
  id: string;
  title: string;
  username: string;
  password: string;
  totp: string;
  emailAlias: string;
  domains: string[];
  urls: string[];
}

export interface PendingAndroidSave {
  id: string;
  domain: string;
  packageName?: string;
  username: string;
  password: string;
  capturedAtMs?: number;
}

export function parseHostJson<T>(raw: unknown): T {
  if (typeof raw === "string") {
    return JSON.parse(raw) as T;
  }
  return raw as T;
}

export function extractHostsFromUrls(urls: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(withScheme);
      const hostname = parsed.hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
      if (hostname) {
        hosts.add(hostname);
        if (hostname.startsWith("www.") && hostname.length > 4) {
          hosts.add(hostname.slice(4));
        }
      }
    } catch {
      const fallback = trimmed
        .replace(/^[a-z]+:\/\//i, "")
        .split(/[/?#]/)[0]
        ?.split(":")[0]
        ?.trim()
        .toLowerCase();
      if (fallback) {
        hosts.add(fallback);
      }
    }
  }
  return Array.from(hosts);
}

export async function getAndroidAutofillStatus(): Promise<AndroidAutofillStatus> {
  if (!host.available()) {
    return { available: false, supported: false, enabled: false };
  }
  try {
    const raw = await host.call("autofill.status", "{}");
    const parsed = parseHostJson<Partial<AndroidAutofillStatus> | null>(raw);
    return {
      available: Boolean(parsed?.available ?? true),
      supported: Boolean(parsed?.supported ?? false),
      enabled: Boolean(parsed?.enabled ?? false),
    };
  } catch {
    return { available: false, supported: false, enabled: false };
  }
}

export async function requestEnableAndroidAutofill(): Promise<boolean> {
  if (!host.available()) {
    return false;
  }
  try {
    const raw = await host.call("autofill.enable", "{}");
    const parsed = parseHostJson<boolean | { launched?: boolean; enabled?: boolean } | null>(raw);
    if (typeof parsed === "boolean") return parsed;
    return Boolean(parsed?.launched ?? parsed?.enabled);
  } catch {
    return false;
  }
}

export async function syncAndroidAutofill(params: {
  unlocked: boolean;
  expiresAtMs?: number;
  items?: readonly VaultItemPayload[];
  emails?: readonly DecryptedEmailItem[];
}): Promise<void> {
  if (!host.available()) return;

  let credentials: AndroidAutofillCredential[] = [];
  let latestOtpCode = "";
  let latestOtpSender = "";

  if (params.unlocked) {
    credentials = (params.items ?? [])
      .filter(
        (it) =>
          it.category === "login" &&
          Boolean(it.username?.trim() || it.password || it.totp?.trim())
      )
      .map((it) => ({
        id: it.id,
        title: it.title,
        username: it.username?.trim() ?? "",
        password: it.password ?? "",
        totp: it.totp?.trim() ?? "",
        emailAlias: it.emailAlias?.trim() ?? "",
        domains: extractHostsFromUrls(it.urls),
        urls: it.urls,
      }));

    const otpEmails = (params.emails ?? []).filter((em) => Boolean(em.otpCode?.trim()));
    if (otpEmails.length > 0) {
      const sorted = [...otpEmails].sort(
        (a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || "")
      );
      const latest = sorted[0];
      latestOtpCode = latest.otpCode?.trim() ?? "";
      latestOtpSender = latest.senderDomain?.trim() || latest.from?.trim() || "";
    }
  }

  try {
    await host.call(
      "autofill.sync",
      JSON.stringify({
        unlocked: params.unlocked,
        expiresAtMs: params.unlocked ? params.expiresAtMs ?? 0 : 0,
        credentials,
        latestOtpCode,
        latestOtpSender,
      })
    );
  } catch {
    // Ignore when host is unavailable or denies autofill sync
  }
}

export async function takePendingAndroidSaves(): Promise<PendingAndroidSave[]> {
  if (!host.available()) return [];
  try {
    const raw = await host.call("autofill.takePendingSaves", "{}");
    const parsed = parseHostJson<
      PendingAndroidSave[] | { saves?: PendingAndroidSave[]; items?: PendingAndroidSave[] } | null
    >(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed?.saves ?? parsed?.items ?? [];
    return list.filter(
      (entry): entry is PendingAndroidSave =>
        Boolean(entry && typeof entry.username === "string" && typeof entry.password === "string")
    );
  } catch {
    return [];
  }
}
