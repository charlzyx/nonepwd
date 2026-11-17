import {
  Clipboard,
  Overlay,
  Scroll,
  Text,
  View,
  batch,
  cleanup,
  computed,
  effect,
  mount,
  openUrl,
  platform,
  setColorScheme,
  signal,
} from "nsh";
import { AlertDialog, Button, Input, Sheet, Switch, Tab, Tabs } from "nsh/base";
import { BackHandler, Haptics, TabBar, isAvailable as mobileApisAvailable } from "nsh/mobile";
import {
  ApiError,
  clearRememberedSession,
  createVault,
  deleteEmail,
  deleteImapAccount,
  deleteItem,
  getAuthParams,
  getEmailFilter,
  loadClientPrefs,
  loadRememberedSession,
  loadThemePreference,
  logoutSession,
  normalizeServerUrl,
  saveClientPrefs,
  saveEmailFilter,
  saveImapAccount,
  saveItem,
  saveRememberedSession,
  saveThemePreference,
  setupAccount,
  syncAll,
  syncImapNow,
  testImapConnection,
  unlockVault,
  batchSaveItems,
  type SaveImapAccountInput,
  type ThemePreference,
  type UnlockedSession,
} from "./src/api";
import {
  DEFAULT_SERVER_URL,
  auditVaultItems,
  extractEmailAddress,
  generateSecretKey,
  generateTotp,
  randomId,
  type AccountInfo,
  type DecryptedEmailItem,
  type DecryptedVault,
  type EmailFilterConfig,
  type ImapAccountPublic,
  type ItemCategory,
  type RememberDuration,
  type TotpImportEntry,
  type TotpImportPlanItem,
  type TotpResult,
  type VaultItemPayload,
} from "./src/crypto";
import { ImapEditorSheet } from "./src/imap-editor";
import { CATEGORY_OPTIONS, ItemEditorSheet } from "./src/item-editor";
import { QrScannerSheet } from "./src/qr-scanner";

type AppTab = "totp" | "vault" | "inbox" | "settings";
const TAB_ORDER: AppTab[] = ["totp", "vault", "inbox", "settings"];

const REMEMBER_OPTIONS: Array<{ key: RememberDuration; label: string }> = [
  { key: "3h", label: "3小时" },
  { key: "24h", label: "24小时" },
  { key: "7d", label: "7天" },
  { key: "session", label: "仅本次" },
];

const THEME_OPTIONS: Array<{ key: ThemePreference; label: string }> = [
  { key: "system", label: "系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

const DEFAULT_EMAIL_FILTER: EmailFilterConfig = {
  enabled: false,
  otpOnly: false,
  mode: "allow",
  rules: [],
};

function categoryLabel(cat: ItemCategory): string {
  return CATEGORY_OPTIONS.find((o) => o.key === cat)?.label ?? cat;
}

function maskSecret(val: string): string {
  if (!val) return "";
  return "•".repeat(Math.min(16, Math.max(8, val.length)));
}

function extractAddressesFromHeader(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  const matches = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (matches && matches.length > 0) {
    return Array.from(new Set(matches.map((m) => m.toLowerCase())));
  }
  return [extractEmailAddress(trimmed)];
}

function getImapStatusInfo(acc: ImapAccountPublic): { label: string; badgeClass: string } {
  if (!acc.enabled || acc.status === "disabled") {
    return { label: "已禁用", badgeClass: "bg-muted text-muted-foreground" };
  }
  if (acc.status === "listening") {
    return { label: "监听中", badgeClass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
  }
  if (acc.status === "connecting") {
    return { label: "连接中", badgeClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  }
  return { label: "连接异常", badgeClass: "bg-destructive/15 text-destructive" };
}

function App() {
  const isDesktop = platform.desktop;

  // Auth & Connection state
  const phase = signal<"locked" | "setup" | "unlocked">("locked");
  const serverUrl = signal(DEFAULT_SERVER_URL);
  const secretKeyInput = signal("");
  const masterPasswordInput = signal("");
  const showUnlockPassword = signal(false);
  const rememberDuration = signal<RememberDuration>("24h");
  const authBusy = signal(false);
  const authError = signal<string | null>(null);

  // Setup state
  const setupEmail = signal("");
  const setupSecretKey = signal(generateSecretKey());
  const setupPassword = signal("");
  const setupAliasDomain = signal("");

  // Active unlocked session
  const session = signal<UnlockedSession | null>(null);
  const accountInfo = signal<AccountInfo | null>(null);
  const vaults = signal<DecryptedVault[]>([]);
  const vaultKeys = signal<Map<string, Uint8Array>>(new Map());
  const items = signal<VaultItemPayload[]>([]);
  const emails = signal<DecryptedEmailItem[]>([]);
  const imapAccounts = signal<ImapAccountPublic[]>([]);
  const emailFilter = signal<EmailFilterConfig>(DEFAULT_EMAIL_FILTER);

  // Navigation & UI state
  const activeTab = signal<AppTab>("totp");
  const themePref = signal<ThemePreference>("system");
  const toast = signal<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  let toastTimer: number | undefined;

  // 2FA Tab state
  const totpSearch = signal("");
  const nowMs = signal(Date.now());
  const totpCodes = signal<Record<string, TotpResult>>({});

  // Vault Tab state
  const vaultSearch = signal("");
  const selectedVaultId = signal<string>("all");
  const selectedCategory = signal<ItemCategory | "all">("all");
  const selectedTag = signal<string>("all");
  const selectedItemId = signal<string | null>(null);
  const revealedFieldKeys = signal<Record<string, boolean>>({});
  const syncing = signal(false);

  // Inbox Tab state
  const selectedMailbox = signal<string>("all");
  const expandedEmailId = signal<string | null>(null);
  const syncingImap = signal(false);

  // Sheets / Modals
  const qrSheetOpen = signal(false);
  const qrSheetMode = signal<"import" | "single">("import");
  let singleTotpCallback: ((entry: TotpImportEntry) => void) | null = null;

  const itemEditorOpen = signal(false);
  const editingItem = signal<VaultItemPayload | null>(null);

  const imapEditorOpen = signal(false);
  const editingImapAccount = signal<ImapAccountPublic | null>(null);

  const newVaultDialogOpen = signal(false);
  const newVaultName = signal("");

  function showToast(text: string, kind: "ok" | "error" | "info" = "info") {
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toast.set({ kind, text });
    toastTimer = setTimeout(() => {
      toast.set(null);
    }, 2600);
  }

  async function performSync(activeSession: UnlockedSession): Promise<void> {
    const res = await syncAll(
      activeSession.serverUrl,
      activeSession.token,
      activeSession.rootKeyBytes,
      activeSession.emailPrivateKeyPkcs8B64
    );
    batch(() => {
      accountInfo.set(res.account);
      vaults.set(res.vaults);
      vaultKeys.set(res.vaultKeys);
      items.set(res.items);
      emails.set(res.emails);
      imapAccounts.set(res.imapAccounts);
      if (res.emailFilter) {
        emailFilter.set(res.emailFilter);
      }
    });
    if (!res.emailFilter) {
      try {
        const filterCfg = await getEmailFilter(activeSession.serverUrl, activeSession.token);
        emailFilter.set(filterCfg);
      } catch {
        // Ignore if endpoint unavailable
      }
    }
  }

  // Bootstrap persisted prefs, theme & remembered session
  effect(() => {
    let cancelled = false;
    void (async () => {
      const [prefs, savedTheme, remembered] = await Promise.all([
        loadClientPrefs(),
        loadThemePreference(),
        loadRememberedSession(),
      ]);
      if (cancelled) return;
      batch(() => {
        serverUrl.set(prefs.serverUrl || DEFAULT_SERVER_URL);
        if (prefs.secretKey && !secretKeyInput()) {
          secretKeyInput.set(prefs.secretKey);
        }
        rememberDuration.set(prefs.rememberDuration);
        themePref.set(savedTheme);
      });
      setColorScheme(savedTheme);

      if (remembered) {
        const restored: UnlockedSession = {
          serverUrl: remembered.serverUrl,
          token: remembered.token,
          email: remembered.email,
          rootKeyBytes: Buffer.from(
            remembered.rootKeyB64.replace(/-/g, "+").replace(/_/g, "/"),
            "base64"
          ),
          emailPrivateKeyPkcs8B64: remembered.emailPrivateKeyPkcs8B64,
        };
        try {
          await performSync(restored);
          if (cancelled) return;
          batch(() => {
            session.set(restored);
            phase.set("unlocked");
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            await clearRememberedSession();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // Live 1s ticker for TOTP codes while unlocked
  effect(() => {
    if (phase() !== "unlocked") return;
    nowMs.set(Date.now());
    const timer = setInterval(() => {
      nowMs.set(Date.now());
    }, 1000);
    cleanup(() => clearInterval(timer));
  });

  const totpItems = computed(() =>
    items().filter((it) => Boolean(it.totp && it.totp.trim()))
  );

  // Recompute TOTP codes whenever time or TOTP items change
  effect(() => {
    if (phase() !== "unlocked") return;
    const now = nowMs();
    const list = totpItems();
    if (list.length === 0) {
      totpCodes.set({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      list.map(async (it) => {
        try {
          const res = await generateTotp(it.totp!, now);
          return [it.id, res] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, TotpResult> = {};
      for (const pair of entries) {
        if (pair) next[pair[0]] = pair[1];
      }
      totpCodes.set(next);
    });
    return () => {
      cancelled = true;
    };
  });

  // Android hardware back handler for closing modals / detail sheets
  cleanup(
    BackHandler.on("press", () => {
      if (qrSheetOpen()) {
        qrSheetOpen.set(false);
        return true;
      }
      if (itemEditorOpen()) {
        itemEditorOpen.set(false);
        return true;
      }
      if (imapEditorOpen()) {
        imapEditorOpen.set(false);
        return true;
      }
      if (newVaultDialogOpen()) {
        newVaultDialogOpen.set(false);
        return true;
      }
      if (!isDesktop && activeTab() === "vault" && selectedItemId()) {
        selectedItemId.set(null);
        return true;
      }
      return false;
    })
  );

  // Computed lists & filters
  const filteredTotpItems = computed(() => {
    const q = totpSearch().trim().toLowerCase();
    const list = totpItems();
    if (!q) return list;
    return list.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        (it.username ?? "").toLowerCase().includes(q) ||
        it.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const allTags = computed(() => {
    const map = new Map<string, string>();
    for (const it of items()) {
      for (const raw of it.tags) {
        const t = raw.trim();
        if (!t) continue;
        const k = t.toLowerCase();
        if (!map.has(k)) map.set(k, t);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  });

  const filteredVaultItems = computed(() => {
    const q = vaultSearch().trim().toLowerCase();
    const vid = selectedVaultId();
    const cat = selectedCategory();
    const tag = selectedTag();
    return items().filter((it) => {
      if (vid !== "all" && it.vaultId !== vid) return false;
      if (cat !== "all" && it.category !== cat) return false;
      if (tag !== "all" && !it.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        return false;
      }
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        (it.username ?? "").toLowerCase().includes(q) ||
        it.urls.some((u) => u.toLowerCase().includes(q)) ||
        it.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  });

  const selectedItem = computed(() => {
    const id = selectedItemId();
    if (!id) return null;
    return items().find((it) => it.id === id) ?? null;
  });

  const mailboxes = computed(() => {
    const map = new Map<string, { address: string; label?: string; count: number }>();
    for (const acc of imapAccounts()) {
      for (const addr of extractAddressesFromHeader(acc.username)) {
        if (!addr) continue;
        const lbl = acc.label?.trim();
        map.set(addr, {
          address: addr,
          label: lbl && lbl.toLowerCase() !== addr ? lbl : undefined,
          count: 0,
        });
      }
    }
    for (const em of emails()) {
      const addrs = extractAddressesFromHeader(em.envelopeTo || em.to);
      for (const addr of addrs) {
        if (!addr) continue;
        const cur = map.get(addr);
        if (cur) cur.count += 1;
        else map.set(addr, { address: addr, count: 1 });
      }
    }
    return Array.from(map.values());
  });

  const filteredEmails = computed(() => {
    const mb = selectedMailbox();
    const list = emails();
    if (mb === "all") return list;
    return list.filter((em) => {
      const addrs = [
        ...extractAddressesFromHeader(em.to),
        ...extractAddressesFromHeader(em.envelopeTo),
      ];
      return addrs.includes(mb);
    });
  });

  const auditSummary = computed(() => auditVaultItems(items()));

  // Handlers
  async function handleCheckServer() {
    authError.set(null);
    authBusy.set(true);
    try {
      const url = normalizeServerUrl(serverUrl());
      serverUrl.set(url);
      const params = await getAuthParams(url);
      if (!params.initialized) {
        phase.set("setup");
        showToast("该服务端尚未初始化，可立即创建主账号", "info");
      } else {
        phase.set("locked");
        showToast("已连接 NonePwd 服务端", "ok");
      }
    } catch (err) {
      authError.set(err instanceof Error ? err.message : "连接服务端失败");
    } finally {
      authBusy.set(false);
    }
  }

  async function handleUnlock() {
    const sk = secretKeyInput().trim();
    const pw = masterPasswordInput();
    if (!sk || !pw) {
      authError.set("请输入 Secret Key 和主密码");
      return;
    }
    authError.set(null);
    authBusy.set(true);
    try {
      const url = normalizeServerUrl(serverUrl());
      serverUrl.set(url);
      const unlocked = await unlockVault(url, {
        masterPassword: pw,
        secretKey: sk,
      });
      await performSync(unlocked);
      const dur = rememberDuration();
      await saveClientPrefs({
        serverUrl: url,
        email: unlocked.email,
        secretKey: dur === "session" ? "" : sk,
        rememberDuration: dur,
      });
      await saveRememberedSession(unlocked, dur);
      batch(() => {
        session.set(unlocked);
        masterPasswordInput.set("");
        phase.set("unlocked");
      });
      Haptics.notification("success");
    } catch (err) {
      authError.set(err instanceof Error ? err.message : "解锁失败");
      Haptics.notification("error");
    } finally {
      authBusy.set(false);
    }
  }

  async function handleSetup() {
    const email = setupEmail().trim();
    const sk = setupSecretKey().trim();
    const pw = setupPassword();
    if (!email || !sk || !pw) {
      authError.set("请填写邮箱、Secret Key 与主密码");
      return;
    }
    authError.set(null);
    authBusy.set(true);
    try {
      const url = normalizeServerUrl(serverUrl());
      serverUrl.set(url);
      const unlocked = await setupAccount(url, {
        email,
        masterPassword: pw,
        secretKey: sk,
        aliasDomain: setupAliasDomain().trim() || undefined,
      });
      await performSync(unlocked);
      const dur = rememberDuration();
      await saveClientPrefs({
        serverUrl: url,
        email: unlocked.email,
        secretKey: dur === "session" ? "" : sk,
        rememberDuration: dur,
      });
      await saveRememberedSession(unlocked, dur);
      batch(() => {
        session.set(unlocked);
        secretKeyInput.set(sk);
        setupPassword.set("");
        phase.set("unlocked");
      });
      Haptics.notification("success");
      showToast("初始化并解锁成功，请妥善保管 Secret Key", "ok");
    } catch (err) {
      authError.set(err instanceof Error ? err.message : "初始化服务端失败");
      Haptics.notification("error");
    } finally {
      authBusy.set(false);
    }
  }

  async function handleLock(clearCredentials = false) {
    const cur = session();
    if (cur) {
      await logoutSession(cur.serverUrl, cur.token);
    }
    await clearRememberedSession();
    if (clearCredentials) {
      secretKeyInput.set("");
      await saveClientPrefs({
        serverUrl: serverUrl(),
        email: "",
        secretKey: "",
        rememberDuration: rememberDuration(),
      });
    }
    batch(() => {
      session.set(null);
      accountInfo.set(null);
      vaults.set([]);
      vaultKeys.set(new Map());
      items.set([]);
      emails.set([]);
      imapAccounts.set([]);
      selectedItemId.set(null);
      masterPasswordInput.set("");
      phase.set("locked");
    });
    showToast(clearCredentials ? "已清除本地密钥并锁定" : "密码库已锁定", "info");
  }

  async function handleManualSync() {
    const cur = session();
    if (!cur || syncing()) return;
    syncing.set(true);
    try {
      await performSync(cur);
      Haptics.notification("success");
      showToast("同步完成", "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步失败", "error");
    } finally {
      syncing.set(false);
    }
  }

  async function handleCopyText(text: string, label: string) {
    if (!text) return;
    await Clipboard.writeText(text);
    Haptics.notification("success");
    showToast(`已复制${label}`, "ok");
  }

  async function handleSaveVaultItem(payload: VaultItemPayload, isNew: boolean) {
    const cur = session();
    if (!cur) throw new Error("密码库已锁定");
    const vk = vaultKeys().get(payload.vaultId);
    if (!vk) throw new Error("未找到对应保险库密钥");
    const saved = await saveItem(cur.serverUrl, cur.token, vk, payload, isNew);
    items.update((prev) => [saved, ...prev.filter((i) => i.id !== saved.id)]);
    selectedItemId.set(saved.id);
    showToast(isNew ? "已创建条目" : "已保存修改", "ok");
  }

  async function handleDeleteVaultItem(item: VaultItemPayload) {
    const cur = session();
    if (!cur) return;
    const res = await AlertDialog.show({
      title: "删除条目",
      description: `确定永久删除「${item.title}」？此操作不可撤销。`,
      actions: [
        { id: "cancel", label: "取消", role: "cancel" },
        { id: "delete", label: "删除", role: "destructive" },
      ],
    });
    if (res.action !== "delete") return;
    try {
      await deleteItem(cur.serverUrl, cur.token, item.vaultId, item.id);
      items.update((prev) => prev.filter((i) => i.id !== item.id));
      if (selectedItemId() === item.id) selectedItemId.set(null);
      Haptics.notification("success");
      showToast("条目已删除", "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  async function handleImportTotpPlan(vid: string, plan: TotpImportPlanItem[]) {
    const cur = session();
    if (!cur) throw new Error("密码库已锁定");
    const vk = vaultKeys().get(vid);
    if (!vk) throw new Error("未找到目标保险库密钥");

    const now = new Date().toISOString();
    const updatedItems: VaultItemPayload[] = [];
    const newItems: VaultItemPayload[] = [];
    let skipped = 0;

    for (const step of plan) {
      if (step.action === "skip_duplicate") {
        skipped++;
      } else if (step.action === "attach") {
        const existing = items().find((i) => i.id === step.itemId);
        if (!existing) {
          skipped++;
          continue;
        }
        const saved = await saveItem(
          cur.serverUrl,
          cur.token,
          vk,
          { ...existing, totp: step.otpauthUri, updatedAt: now },
          false
        );
        updatedItems.push(saved);
      } else if (step.action === "create") {
        newItems.push({
          id: randomId(),
          vaultId: vid,
          category: "login",
          title: step.title,
          favorite: false,
          tags: [],
          urls: [],
          ...(step.username ? { username: step.username } : {}),
          totp: step.totp,
          customFields: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const createdSaved =
      newItems.length > 0
        ? await batchSaveItems(cur.serverUrl, cur.token, vid, vk, newItems)
        : [];

    if (updatedItems.length > 0 || createdSaved.length > 0) {
      const updatedMap = new Map(updatedItems.map((u) => [u.id, u]));
      items.update((prev) => [
        ...createdSaved,
        ...prev.map((it) => updatedMap.get(it.id) ?? it),
      ]);
    }
    showToast(
      `导入完成：新增 ${createdSaved.length}，关联 ${updatedItems.length}，跳过 ${skipped}`,
      "ok"
    );
  }

  async function handleCreateVault() {
    const cur = session();
    const name = newVaultName().trim();
    if (!cur || !name) return;
    try {
      const created = await createVault(cur.serverUrl, cur.token, cur.rootKeyBytes, name);
      vaultKeys.update((m) => {
        const next = new Map(m);
        next.set(created.id, created.keyBytes);
        return next;
      });
      vaults.update((prev) => [...prev, created]);
      selectedVaultId.set(created.id);
      newVaultName.set("");
      newVaultDialogOpen.set(false);
      showToast(`已创建保险库「${created.metadata.name}」`, "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建保险库失败", "error");
    }
  }

  async function handleSyncImap(accountId?: string) {
    const cur = session();
    if (!cur || syncingImap()) return;
    syncingImap.set(true);
    try {
      const res = await syncImapNow(cur.serverUrl, cur.token, accountId);
      imapAccounts.set(res.accounts);
      await performSync(cur);
      if (res.ok) {
        Haptics.notification("success");
        showToast(
          res.synced && res.synced > 0
            ? `收信同步完成，新增 ${res.synced} 封邮件`
            : "同步完成，当前已是最新",
          "ok"
        );
      } else {
        showToast(res.error || "IMAP 同步返回异常", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步收信失败", "error");
    } finally {
      syncingImap.set(false);
    }
  }

  async function handleSaveImapAccount(input: SaveImapAccountInput) {
    const cur = session();
    if (!cur) throw new Error("密码库已锁定");
    const res = await saveImapAccount(cur.serverUrl, cur.token, input);
    imapAccounts.set(res.accounts);
    await performSync(cur);
    showToast("IMAP 邮箱已保存", "ok");
  }

  async function handleToggleImapEnabled(acc: ImapAccountPublic) {
    const cur = session();
    if (!cur) return;
    try {
      const res = await saveImapAccount(cur.serverUrl, cur.token, {
        id: acc.id,
        label: acc.label,
        enabled: !acc.enabled,
        host: acc.host,
        port: acc.port,
        tls: acc.tls,
        username: acc.username,
      });
      imapAccounts.set(res.accounts);
      showToast(!acc.enabled ? `已启用「${acc.label}」` : `已停用「${acc.label}」`, "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "切换状态失败", "error");
    }
  }

  async function handleDeleteImapAccount(acc: ImapAccountPublic) {
    const cur = session();
    if (!cur) return;
    const res = await AlertDialog.show({
      title: "删除邮箱账号",
      description: `确认移除「${acc.label || acc.username}」？`,
      actions: [
        { id: "cancel", label: "取消", role: "cancel" },
        { id: "delete", label: "删除", role: "destructive" },
      ],
    });
    if (res.action !== "delete") return;
    try {
      const out = await deleteImapAccount(cur.serverUrl, cur.token, acc.id);
      imapAccounts.set(out.accounts);
      showToast("已删除邮箱账号", "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  async function handleToggleOtpOnly(nextOtpOnly: boolean) {
    const cur = session();
    if (!cur) return;
    const nextCfg: EmailFilterConfig = { ...emailFilter(), otpOnly: nextOtpOnly };
    emailFilter.set(nextCfg);
    try {
      const saved = await saveEmailFilter(cur.serverUrl, cur.token, nextCfg);
      emailFilter.set(saved);
      Haptics.selection();
      showToast(saved.otpOnly ? "已开启：仅保留含验证码邮件" : "已关闭：保留全部收件", "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存过滤设置失败", "error");
    }
  }

  async function handleDeleteEmail(em: DecryptedEmailItem) {
    const cur = session();
    if (!cur) return;
    try {
      await deleteEmail(cur.serverUrl, cur.token, em.id);
      emails.update((prev) => prev.filter((e) => e.id !== em.id));
      if (expandedEmailId() === em.id) expandedEmailId.set(null);
      showToast("已删除邮件记录", "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除邮件失败", "error");
    }
  }

  function handleChangeTheme(next: ThemePreference) {
    themePref.set(next);
    setColorScheme(next);
    void saveThemePreference(next);
    Haptics.selection();
  }

  function toggleReveal(key: string) {
    revealedFieldKeys.update((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function renderItemDetailContent(item: VaultItemPayload) {
    const totpState = totpCodes()[item.id];
    const vaultName = vaults().find((v) => v.id === item.vaultId)?.metadata.name ?? "保险库";
    const warnings = auditSummary().issuesByItemId[item.id] ?? [];
    const sshPub =
      item.category === "ssh_key"
        ? item.customFields.find((f) => f.label.trim().toLowerCase() === "public_key")?.value
        : undefined;
    const sshPass =
      item.category === "ssh_key"
        ? item.customFields.find((f) => f.label.trim().toLowerCase() === "passphrase")?.value
        : undefined;
    const extraCustom =
      item.category === "ssh_key"
        ? item.customFields.filter((f) => {
            const k = f.label.trim().toLowerCase();
            return k !== "public_key" && k !== "passphrase";
          })
        : item.customFields;

    return (
      <View class="gap-3">
        {/* Title & Actions */}
        <View class="flex-row items-start justify-between gap-2 border-b border-border pb-3">
          <View class="flex-1 gap-1">
            <View class="flex-row flex-wrap items-center gap-1.5">
              <View class="rounded-md bg-muted px-2 py-0.5">
                <Text class="text-[11px] font-medium text-foreground">{vaultName}</Text>
              </View>
              <View class="rounded-md border border-border px-2 py-0.5">
                <Text class="text-[11px] text-muted-foreground">
                  {categoryLabel(item.category)}
                </Text>
              </View>
            </View>
            <Text class="text-xl font-semibold text-foreground">{item.title}</Text>
            <If when={item.tags.length > 0}>
              <View class="flex-row flex-wrap gap-1">
                <Each of={item.tags}>
                  {(tag) => (
                    <View class="rounded-full bg-muted px-2 py-0.5">
                      <Text class="text-[10px] text-muted-foreground">#{tag()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>

          <View class="flex-row items-center gap-1.5">
            <Button
              onPress={() => {
                editingItem.set(item);
                itemEditorOpen.set(true);
              }}
              class="rounded-lg border border-border bg-background px-2.5 py-1.5 active:bg-muted"
            >
              <Text class="text-xs font-medium text-foreground">编辑</Text>
            </Button>
            <Button
              onPress={() => void handleDeleteVaultItem(item)}
              class="rounded-lg bg-destructive/15 px-2.5 py-1.5 active:opacity-75"
            >
              <Text class="text-xs font-medium text-destructive">删除</Text>
            </Button>
          </View>
        </View>

        <If when={warnings.length > 0}>
          <View class="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <Text class="text-xs font-medium text-amber-600 dark:text-amber-400">
              安全提醒：{warnings.join(" · ")}
            </Text>
          </View>
        </If>

        {/* TOTP Card inside Detail */}
        <If when={totpState}>
          {(t) => (
            <Button
              onPress={() => void handleCopyText(t().code, " 2FA 验证码")}
              class="flex-row items-center justify-between rounded-xl border border-border bg-background p-3.5 active:bg-muted"
            >
              <View class="gap-0.5">
                <Text class="text-[11px] text-muted-foreground">一次性动态验证码 (点击复制)</Text>
                <Text class="font-mono text-2xl font-bold tracking-widest text-foreground">
                  {t().code}
                </Text>
              </View>
              <View class="rounded-full bg-primary/15 px-2.5 py-1">
                <Text class="font-mono text-xs font-semibold text-primary">
                  {t().remainingSeconds}s
                </Text>
              </View>
            </Button>
          )}
        </If>

        {/* Username */}
        <If when={item.username}>
          {(u) => (
            <View class="flex-row items-center justify-between gap-2 rounded-xl border border-border bg-background p-3">
              <View class="flex-1 gap-0.5">
                <Text class="text-[11px] text-muted-foreground">用户名 / 标识</Text>
                <Text class="text-sm text-foreground">{u()}</Text>
              </View>
              <Button
                onPress={() => void handleCopyText(u(), "用户名")}
                class="rounded-lg bg-muted px-2.5 py-1.5 active:opacity-75"
              >
                <Text class="text-xs font-medium text-foreground">复制</Text>
              </Button>
            </View>
          )}
        </If>

        {/* Password / Secret */}
        <If when={item.password}>
          {(pw) => (
            <View class="gap-2 rounded-xl border border-border bg-background p-3">
              <View class="flex-row items-center justify-between gap-2">
                <View class="flex-1 gap-0.5">
                  <Text class="text-[11px] text-muted-foreground">
                    {item.category === "api_credential"
                      ? "API 密钥"
                      : item.category === "ssh_key"
                        ? "SSH 私钥"
                        : "密码 / 机密"}
                  </Text>
                  <Text class="font-mono text-sm text-foreground">
                    {revealedFieldKeys()[`${item.id}:pw`] ? pw() : maskSecret(pw())}
                  </Text>
                </View>
                <View class="flex-row gap-1.5">
                  <Button
                    onPress={() => toggleReveal(`${item.id}:pw`)}
                    class="rounded-lg border border-border bg-card px-2.5 py-1.5 active:bg-muted"
                  >
                    <Text class="text-xs text-foreground">
                      {revealedFieldKeys()[`${item.id}:pw`] ? "隐藏" : "显示"}
                    </Text>
                  </Button>
                  <Button
                    onPress={() => void handleCopyText(pw(), "密码")}
                    class="rounded-lg bg-muted px-2.5 py-1.5 active:opacity-75"
                  >
                    <Text class="text-xs font-medium text-foreground">复制</Text>
                  </Button>
                </View>
              </View>
            </View>
          )}
        </If>

        {/* SSH extra */}
        <If when={sshPub}>
          {(pub) => (
            <View class="flex-row items-center justify-between gap-2 rounded-xl border border-border bg-background p-3">
              <View class="flex-1 gap-0.5">
                <Text class="text-[11px] text-muted-foreground">SSH 公钥</Text>
                <Text class="line-clamp-2 font-mono text-xs text-foreground">
                  {pub()}
                </Text>
              </View>
              <Button
                onPress={() => void handleCopyText(pub(), " SSH 公钥")}
                class="rounded-lg bg-muted px-2.5 py-1.5"
              >
                <Text class="text-xs font-medium text-foreground">复制</Text>
              </Button>
            </View>
          )}
        </If>
        <If when={sshPass}>
          {(pass) => (
            <View class="flex-row items-center justify-between gap-2 rounded-xl border border-border bg-background p-3">
              <View class="flex-1 gap-0.5">
                <Text class="text-[11px] text-muted-foreground">私钥口令</Text>
                <Text class="font-mono text-xs text-foreground">
                  {revealedFieldKeys()[`${item.id}:sshpass`] ? pass() : maskSecret(pass())}
                </Text>
              </View>
              <View class="flex-row gap-1.5">
                <Button
                  onPress={() => toggleReveal(`${item.id}:sshpass`)}
                  class="rounded-lg border border-border bg-card px-2 py-1"
                >
                  <Text class="text-xs text-foreground">
                    {revealedFieldKeys()[`${item.id}:sshpass`] ? "隐藏" : "显示"}
                  </Text>
                </Button>
                <Button
                  onPress={() => void handleCopyText(pass(), "私钥口令")}
                  class="rounded-lg bg-muted px-2.5 py-1"
                >
                  <Text class="text-xs font-medium text-foreground">复制</Text>
                </Button>
              </View>
            </View>
          )}
        </If>

        {/* Card Details */}
        <If when={item.card}>
          {(card) => (
            <View class="gap-2 rounded-xl border border-border bg-background p-3">
              <If when={card().cardholderName}>
                <Text class="text-xs text-foreground">持卡人：{card().cardholderName}</Text>
              </If>
              <If when={card().number}>
                <View class="flex-row items-center justify-between">
                  <Text class="font-mono text-sm text-foreground">
                    {revealedFieldKeys()[`${item.id}:card`]
                      ? card().number
                      : `•••• •••• •••• ${(card().number ?? "").slice(-4)}`}
                  </Text>
                  <View class="flex-row gap-1.5">
                    <Button
                      onPress={() => toggleReveal(`${item.id}:card`)}
                      class="rounded-lg border border-border bg-card px-2 py-1"
                    >
                      <Text class="text-xs text-foreground">
                        {revealedFieldKeys()[`${item.id}:card`] ? "隐藏" : "显示"}
                      </Text>
                    </Button>
                    <Button
                      onPress={() => void handleCopyText(card().number ?? "", "卡号")}
                      class="rounded-lg bg-muted px-2.5 py-1"
                    >
                      <Text class="text-xs font-medium text-foreground">复制</Text>
                    </Button>
                  </View>
                </View>
              </If>
              <View class="flex-row gap-4">
                <If when={card().expMonth || card().expYear}>
                  <Text class="text-xs text-muted-foreground">
                    有效期：{card().expMonth}/{card().expYear}
                  </Text>
                </If>
                <If when={card().cvv}>
                  <Button onPress={() => void handleCopyText(card().cvv ?? "", " CVV")}>
                    <Text class="text-xs text-muted-foreground">
                      CVV：{revealedFieldKeys()[`${item.id}:card`] ? card().cvv : "•••"}
                    </Text>
                  </Button>
                </If>
              </View>
            </View>
          )}
        </If>

        {/* Identity Details */}
        <If when={item.identity}>
          {(id) => (
            <View class="gap-1.5 rounded-xl border border-border bg-background p-3">
              <If when={id().fullName}>
                <Text class="text-sm font-medium text-foreground">{id().fullName}</Text>
              </If>
              <If when={id().email}>
                <Text class="text-xs text-muted-foreground">邮箱：{id().email}</Text>
              </If>
              <If when={id().phone}>
                <Text class="text-xs text-muted-foreground">电话：{id().phone}</Text>
              </If>
              <If when={id().address1 || id().city}>
                <Text class="text-xs text-foreground">
                  {[id().country, id().state, id().city, id().address1, id().postalCode]
                    .filter(Boolean)
                    .join(" ")}
                </Text>
              </If>
            </View>
          )}
        </If>

        {/* URLs */}
        <If when={item.urls.length > 0}>
          <View class="gap-1.5 rounded-xl border border-border bg-background p-3">
            <Text class="text-[11px] text-muted-foreground">关联网址</Text>
            <Each of={item.urls}>
              {(u) => (
                <Button
                  onPress={() => {
                    const target = /^https?:\/\//i.test(u()) ? u() : `https://${u()}`;
                    void openUrl(target);
                  }}
                  class="py-0.5 active:opacity-70"
                >
                  <Text class="text-xs text-primary underline">{u()}</Text>
                </Button>
              )}
            </Each>
          </View>
        </If>

        {/* Custom Fields */}
        <If when={extraCustom.length > 0}>
          <View class="gap-1.5">
            <Each of={extraCustom} key={(cf) => cf.id}>
              {(cf) => (
                <View class="flex-row items-center justify-between gap-2 rounded-xl border border-border bg-background p-3">
                  <View class="flex-1 gap-0.5">
                    <Text class="text-[11px] text-muted-foreground">{cf().label}</Text>
                    <Text class="font-mono text-xs text-foreground">
                      {cf().type === "concealed" && !revealedFieldKeys()[`${item.id}:${cf().id}`]
                        ? maskSecret(cf().value)
                        : cf().value}
                    </Text>
                  </View>
                  <View class="flex-row gap-1.5">
                    <If when={cf().type === "concealed"}>
                      <Button
                        onPress={() => toggleReveal(`${item.id}:${cf().id}`)}
                        class="rounded-lg border border-border bg-card px-2 py-1"
                      >
                        <Text class="text-xs text-foreground">
                          {revealedFieldKeys()[`${item.id}:${cf().id}`] ? "隐藏" : "显示"}
                        </Text>
                      </Button>
                    </If>
                    <Button
                      onPress={() => void handleCopyText(cf().value, cf().label)}
                      class="rounded-lg bg-muted px-2.5 py-1"
                    >
                      <Text class="text-xs font-medium text-foreground">复制</Text>
                    </Button>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>

        {/* Notes */}
        <If when={item.notes}>
          {(n) => (
            <View class="gap-1 rounded-xl border border-border bg-background p-3">
              <Text class="text-[11px] text-muted-foreground">备注</Text>
              <Text class="text-xs text-foreground">{n()}</Text>
            </View>
          )}
        </If>
      </View>
    );
  }

  // ---------- Views ----------

  function renderAuthView() {
    return (
      <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <Scroll
          class="flex-1"
          contentClass="grow items-center justify-center px-5 py-8"
          keyboardDismissMode="on-drag"
        >
          <View class="w-full max-w-md gap-5">
            {/* Brand Header */}
            <View class="items-center gap-1.5">
              <View class="h-14 w-14 items-center justify-center rounded-2xl bg-primary">
                <Text class="text-xl font-bold text-primary-foreground">NP</Text>
              </View>
              <Text class="text-2xl font-bold tracking-tight text-foreground">NonePwd</Text>
              <Text class="text-xs text-muted-foreground">
                端到端零知识密码库 · 2FA 与邮箱验证码中枢
              </Text>
            </View>

            {/* Auth Card */}
            <View class="gap-4 rounded-2xl border border-border bg-card p-5">
              {/* Server URL */}
              <View class="gap-1.5">
                <View class="flex-row items-center justify-between">
                  <Text class="text-xs font-medium text-muted-foreground">服务端地址</Text>
                  <Button
                    disabled={authBusy()}
                    onPress={() => void handleCheckServer()}
                    class="rounded-md px-2 py-0.5 active:bg-muted"
                  >
                    <Text class="text-[11px] font-medium text-primary">检测服务端</Text>
                  </Button>
                </View>
                <Input
                  testID="server-url-input"
                  value={serverUrl()}
                  onChange={(e) => serverUrl.set(e.value)}
                  placeholder="http://127.0.0.1:8787"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
                />
              </View>

              {/* Mode toggle */}
              <View class="flex-row gap-1.5 rounded-xl bg-muted p-1">
                <Button
                  onPress={() => {
                    authError.set(null);
                    phase.set("locked");
                  }}
                  class={`flex-1 items-center rounded-lg py-2 ${
                    phase() === "locked" ? "bg-card" : ""
                  }`}
                >
                  <Text
                    class={`text-xs font-medium ${
                      phase() === "locked" ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    解锁密码库
                  </Text>
                </Button>
                <Button
                  onPress={() => {
                    authError.set(null);
                    phase.set("setup");
                  }}
                  class={`flex-1 items-center rounded-lg py-2 ${
                    phase() === "setup" ? "bg-card" : ""
                  }`}
                >
                  <Text
                    class={`text-xs font-medium ${
                      phase() === "setup" ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    初始化新服务端
                  </Text>
                </Button>
              </View>

              {/* Unlock Form */}
              <If when={phase() === "locked"}>
                <View class="gap-3.5">
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted-foreground">Secret Key</Text>
                    <Input
                      testID="secret-key-input"
                      value={secretKeyInput()}
                      onChange={(e) => secretKeyInput.set(e.value)}
                      placeholder="NP3-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                      autoCapitalize="characters"
                      autoCorrect={false}
                      class="rounded-xl border border-input bg-background px-3 py-2.5 font-mono text-xs text-foreground"
                    />
                  </View>

                  <View class="gap-1">
                    <View class="flex-row items-center justify-between">
                      <Text class="text-xs font-medium text-muted-foreground">主密码</Text>
                      <Button onPress={() => showUnlockPassword.update((v) => !v)}>
                        <Text class="text-[11px] text-primary">
                          {showUnlockPassword() ? "隐藏" : "显示"}
                        </Text>
                      </Button>
                    </View>
                    <Input
                      testID="master-password-input"
                      value={masterPasswordInput()}
                      onChange={(e) => masterPasswordInput.set(e.value)}
                      masked={!showUnlockPassword()}
                      autoComplete="current-password"
                      placeholder="输入主密码"
                      onSubmit={() => void handleUnlock()}
                      class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
                    />
                  </View>

                  <View class="gap-1.5">
                    <Text class="text-xs font-medium text-muted-foreground">记住登录时长</Text>
                    <View class="flex-row gap-1.5">
                      <Each of={REMEMBER_OPTIONS}>
                        {(opt) => (
                          <Button
                            onPress={() => {
                              Haptics.selection();
                              rememberDuration.set(opt().key);
                            }}
                            class={`flex-1 items-center rounded-lg border py-2 ${
                              rememberDuration() === opt().key
                                ? "border-primary bg-primary"
                                : "border-border bg-background"
                            }`}
                          >
                            <Text
                              class={`text-xs font-medium ${
                                rememberDuration() === opt().key
                                  ? "text-primary-foreground"
                                  : "text-foreground"
                              }`}
                            >
                              {opt().label}
                            </Text>
                          </Button>
                        )}
                      </Each>
                    </View>
                  </View>

                  <If when={authError()}>
                    {(msg) => (
                      <View class="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
                        <Text class="text-xs text-destructive">{msg()}</Text>
                      </View>
                    )}
                  </If>

                  <Button
                    testID="unlock-button"
                    disabled={authBusy()}
                    onPress={() => void handleUnlock()}
                    class="items-center rounded-xl bg-primary py-3.5 active:opacity-85 disabled:opacity-50"
                  >
                    <Text class="text-sm font-semibold text-primary-foreground">
                      {authBusy() ? "正在派生密钥并同步..." : "解锁密码库"}
                    </Text>
                  </Button>
                </View>
              </If>

              {/* Setup Form */}
              <If when={phase() === "setup"}>
                <View class="gap-3">
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted-foreground">主账号邮箱</Text>
                    <Input
                      value={setupEmail()}
                      onChange={(e) => setupEmail.set(e.value)}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      placeholder="owner@example.com"
                      class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
                    />
                  </View>

                  <View class="gap-1">
                    <View class="flex-row items-center justify-between">
                      <Text class="text-xs font-medium text-muted-foreground">
                        Secret Key (请务必保存)
                      </Text>
                      <View class="flex-row gap-2">
                        <Button onPress={() => void handleCopyText(setupSecretKey(), " Secret Key")}>
                          <Text class="text-[11px] text-primary">复制</Text>
                        </Button>
                        <Button onPress={() => setupSecretKey.set(generateSecretKey())}>
                          <Text class="text-[11px] text-muted-foreground">重新生成</Text>
                        </Button>
                      </View>
                    </View>
                    <View class="rounded-xl border border-border bg-background px-3 py-2.5">
                      <Text class="font-mono text-xs text-foreground">{setupSecretKey()}</Text>
                    </View>
                  </View>

                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted-foreground">设置主密码</Text>
                    <Input
                      value={setupPassword()}
                      onChange={(e) => setupPassword.set(e.value)}
                      masked
                      autoComplete="new-password"
                      placeholder="至少 10 位强密码"
                      class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
                    />
                  </View>

                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted-foreground">
                      邮箱别名域名 (可选)
                    </Text>
                    <Input
                      value={setupAliasDomain()}
                      onChange={(e) => setupAliasDomain.set(e.value)}
                      autoCapitalize="none"
                      placeholder="mail.example.com"
                      class="rounded-xl border border-input bg-background px-3 py-2.5 text-xs text-foreground"
                    />
                  </View>

                  <If when={authError()}>
                    {(msg) => (
                      <View class="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
                        <Text class="text-xs text-destructive">{msg()}</Text>
                      </View>
                    )}
                  </If>

                  <Button
                    disabled={authBusy()}
                    onPress={() => void handleSetup()}
                    class="items-center rounded-xl bg-primary py-3.5 active:opacity-85 disabled:opacity-50"
                  >
                    <Text class="text-sm font-semibold text-primary-foreground">
                      {authBusy() ? "正在创建加密保险库..." : "初始化并解锁"}
                    </Text>
                  </Button>
                </View>
              </If>
            </View>
          </View>
        </Scroll>
      </View>
    );
  }

  function renderTotpTab() {
    return (
      <View class="flex-1 bg-background">
        <View class="gap-3 border-b border-border bg-card px-4 py-3">
          <View class="flex-row items-center justify-between gap-2">
            <View class="gap-0.5">
              <Text class="text-xl font-bold text-foreground">验证码</Text>
              <Text class="text-xs text-muted-foreground">
                共 {totpItems().length} 个 2FA 密钥 · 点击卡片一键复制
              </Text>
            </View>
            <Button
              testID="totp-import-btn"
              onPress={() => {
                singleTotpCallback = null;
                qrSheetMode.set("import");
                qrSheetOpen.set(true);
              }}
              class="rounded-xl bg-primary px-3.5 py-2 active:opacity-85"
            >
              <Text class="text-xs font-semibold text-primary-foreground">+ 扫码 / 导入 2FA</Text>
            </Button>
          </View>

          <Input
            testID="totp-search-input"
            value={totpSearch()}
            onChange={(e) => totpSearch.set(e.value)}
            placeholder="搜索服务名或账号..."
            class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </View>

        <Scroll class="flex-1" contentClass="p-4 gap-3 pb-6">
          <If
            when={filteredTotpItems().length > 0}
            else={
              <View class="items-center gap-3 rounded-2xl border border-dashed border-border bg-card p-8">
                <Text class="text-sm font-medium text-foreground">暂无 2FA 验证码</Text>
                <Text class="text-center text-xs text-muted-foreground">
                  支持相册选择二维码、摄像头扫码，或粘贴 otpauth:// 与 Google 迁移导出。
                </Text>
                <Button
                  onPress={() => {
                    singleTotpCallback = null;
                    qrSheetMode.set("import");
                    qrSheetOpen.set(true);
                  }}
                  class="rounded-xl bg-primary px-4 py-2.5 active:opacity-85"
                >
                  <Text class="text-xs font-semibold text-primary-foreground">
                    立即导入 2FA 密钥
                  </Text>
                </Button>
              </View>
            }
          >
            <Each of={filteredTotpItems()} key={(it) => it.id}>
              {(it) => {
                const res = computed(() => totpCodes()[it().id]);
                const pct = computed(() => {
                  const r = res();
                  return r ? Math.max(4, Math.min(100, Math.round(r.progress * 100))) : 0;
                });
                const expiring = computed(() => {
                  const r = res();
                  return r ? r.remainingSeconds <= 5 : false;
                });
                return (
                  <Button
                    onPress={() => {
                      const code = res()?.code;
                      if (code) void handleCopyText(code, ` ${it().title} 验证码`);
                    }}
                    class="gap-2.5 rounded-2xl border border-border bg-card p-4 active:opacity-85"
                  >
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="flex-1 gap-0.5">
                        <Text class="text-base font-semibold text-foreground">{it().title}</Text>
                        <If when={it().username}>
                          <Text class="text-xs text-muted-foreground">{it().username}</Text>
                        </If>
                      </View>
                      <View class="items-end gap-1">
                        <Text class="font-mono text-2xl font-bold tracking-widest text-foreground">
                          {res()?.code ?? "------"}
                        </Text>
                        <Text
                          class={`font-mono text-[11px] font-semibold ${
                            expiring() ? "text-destructive" : "text-muted-foreground"
                          }`}
                        >
                          {res() ? `${res()!.remainingSeconds}s` : "..."}
                        </Text>
                      </View>
                    </View>
                    <View class="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <View
                        class={`h-full rounded-full ${
                          expiring() ? "bg-destructive" : "bg-primary"
                        }`}
                        style={{ width: `${pct()}%` }}
                      />
                    </View>
                  </Button>
                );
              }}
            </Each>
          </If>
        </Scroll>
      </View>
    );
  }

  function renderVaultTab() {
    return (
      <View class="flex-1 bg-background">
        {/* Header & Search */}
        <View class="gap-2.5 border-b border-border bg-card px-4 py-3">
          <View class="flex-row items-center justify-between gap-2">
            <View class="gap-0.5">
              <Text class="text-xl font-bold text-foreground">密码库</Text>
              <Text class="text-xs text-muted-foreground">
                {vaults().length} 个保险库 · {filteredVaultItems().length} / {items().length} 条凭据
              </Text>
            </View>
            <View class="flex-row items-center gap-1.5">
              <Button
                disabled={syncing()}
                onPress={() => void handleManualSync()}
                class="rounded-xl border border-border bg-background px-3 py-2 active:bg-muted disabled:opacity-50"
              >
                <Text class="text-xs font-medium text-foreground">
                  {syncing() ? "同步中" : "同步"}
                </Text>
              </Button>
              <Button
                testID="vault-add-btn"
                onPress={() => {
                  editingItem.set(null);
                  itemEditorOpen.set(true);
                }}
                class="rounded-xl bg-primary px-3.5 py-2 active:opacity-85"
              >
                <Text class="text-xs font-semibold text-primary-foreground">+ 新建</Text>
              </Button>
            </View>
          </View>

          <Input
            testID="vault-search-input"
            value={vaultSearch()}
            onChange={(e) => vaultSearch.set(e.value)}
            placeholder="搜索标题、用户名、网址或标签..."
            class="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
          />

          {/* Vault Filter Pills */}
          <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-1.5">
            <Button
              onPress={() => selectedVaultId.set("all")}
              class={`rounded-full border px-3 py-1 ${
                selectedVaultId() === "all"
                  ? "border-primary bg-primary"
                  : "border-border bg-background"
              }`}
            >
              <Text
                class={`text-xs font-medium ${
                  selectedVaultId() === "all" ? "text-primary-foreground" : "text-foreground"
                }`}
              >
                全部库
              </Text>
            </Button>
            <Each of={vaults()}>
              {(v) => (
                <Button
                  onPress={() => selectedVaultId.set(v().id)}
                  class={`rounded-full border px-3 py-1 ${
                    selectedVaultId() === v().id
                      ? "border-primary bg-primary"
                      : "border-border bg-background"
                  }`}
                >
                  <Text
                    class={`text-xs font-medium ${
                      selectedVaultId() === v().id
                        ? "text-primary-foreground"
                        : "text-foreground"
                    }`}
                  >
                    {v().metadata.name}
                  </Text>
                </Button>
              )}
            </Each>
            <Button
              onPress={() => newVaultDialogOpen.set(true)}
              class="rounded-full border border-dashed border-border bg-background px-3 py-1 active:bg-muted"
            >
              <Text class="text-xs text-muted-foreground">+ 新建库</Text>
            </Button>
          </Scroll>

          {/* Category Filter Pills */}
          <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-1.5">
            <Button
              onPress={() => selectedCategory.set("all")}
              class={`rounded-full px-3 py-1 ${
                selectedCategory() === "all" ? "bg-foreground" : "bg-muted"
              }`}
            >
              <Text
                class={`text-xs font-medium ${
                  selectedCategory() === "all" ? "text-background" : "text-foreground"
                }`}
              >
                全部
              </Text>
            </Button>
            <Each of={CATEGORY_OPTIONS}>
              {(cat) => (
                <Button
                  onPress={() => selectedCategory.set(cat().key)}
                  class={`rounded-full px-3 py-1 ${
                    selectedCategory() === cat().key ? "bg-foreground" : "bg-muted"
                  }`}
                >
                  <Text
                    class={`text-xs font-medium ${
                      selectedCategory() === cat().key ? "text-background" : "text-foreground"
                    }`}
                  >
                    {cat().label}
                  </Text>
                </Button>
              )}
            </Each>
          </Scroll>

          {/* Tag / Group Filter Pills */}
          <If when={allTags().length > 0}>
            <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-1.5">
              <Button
                onPress={() => selectedTag.set("all")}
                class={`rounded-full border px-2.5 py-0.5 ${
                  selectedTag() === "all"
                    ? "border-primary bg-primary/15"
                    : "border-border bg-background"
                }`}
              >
                <Text class="text-[11px] text-foreground">全部分组</Text>
              </Button>
              <Each of={allTags()}>
                {(tag) => (
                  <Button
                    onPress={() =>
                      selectedTag.set(selectedTag() === tag() ? "all" : tag())
                    }
                    class={`rounded-full border px-2.5 py-0.5 ${
                      selectedTag() === tag()
                        ? "border-primary bg-primary/15"
                        : "border-border bg-background"
                    }`}
                  >
                    <Text class="text-[11px] text-foreground">#{tag()}</Text>
                  </Button>
                )}
              </Each>
            </Scroll>
          </If>
        </View>

        {/* Master-detail on desktop, list + sheet on mobile */}
        <View class={`flex-1 ${isDesktop ? "flex-row" : ""}`}>
          <Scroll
            class={isDesktop ? "w-80 border-r border-border" : "flex-1"}
            contentClass="p-3 gap-2 pb-6"
          >
            <If
              when={filteredVaultItems().length > 0}
              else={
                <View class="items-center gap-2 rounded-2xl border border-dashed border-border bg-card p-6">
                  <Text class="text-sm font-medium text-foreground">没有匹配的条目</Text>
                  <Text class="text-xs text-muted-foreground">
                    调整筛选条件或点击右上角「+ 新建」添加凭据
                  </Text>
                </View>
              }
            >
              <Each of={filteredVaultItems()} key={(it) => it.id}>
                {(it) => {
                  const isSelected = computed(() => selectedItemId() === it().id);
                  const subtitle = computed(() => {
                    const cur = it();
                    if (cur.category === "card" && cur.card?.number) {
                      return `${cur.card.brand || "银行卡"} •••• ${cur.card.number.slice(-4)}`;
                    }
                    if (cur.category === "identity") {
                      return cur.identity?.fullName || cur.identity?.email || "身份信息";
                    }
                    return cur.username || cur.urls[0] || categoryLabel(cur.category);
                  });
                  const hasIssue = computed(
                    () => Boolean(auditSummary().issuesByItemId[it().id]?.length)
                  );
                  return (
                    <Button
                      onPress={() => {
                        Haptics.selection();
                        selectedItemId.set(it().id);
                      }}
                      class={`gap-1 rounded-2xl border p-3.5 ${
                        isSelected() && isDesktop
                          ? "border-primary bg-primary/10"
                          : "border-border bg-card"
                      }`}
                    >
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="flex-1 truncate text-sm font-semibold text-foreground">
                          {it().title}
                        </Text>
                        <View class="flex-row items-center gap-1">
                          <If when={it().totp}>
                            <View class="rounded bg-primary/15 px-1.5 py-0.5">
                              <Text class="text-[10px] font-semibold text-primary">2FA</Text>
                            </View>
                          </If>
                          <If when={hasIssue()}>
                            <View class="rounded bg-amber-500/15 px-1.5 py-0.5">
                              <Text class="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                风险
                              </Text>
                            </View>
                          </If>
                        </View>
                      </View>
                      <Text class="truncate text-xs text-muted-foreground">
                        {subtitle()}
                      </Text>
                    </Button>
                  );
                }}
              </Each>
            </If>
          </Scroll>

          {/* Desktop Detail Pane */}
          <If when={isDesktop}>
            <Scroll class="flex-1" contentClass="p-5">
              <If
                when={selectedItem()}
                else={
                  <View class="items-center justify-center py-20">
                    <Text class="text-sm text-muted-foreground">从左侧选择一个条目查看详情</Text>
                  </View>
                }
              >
                {(item) => renderItemDetailContent(item())}
              </If>
            </Scroll>
          </If>
        </View>

        {/* Mobile Item Detail Sheet */}
        <If when={!isDesktop}>
          <Sheet
            open={Boolean(selectedItem())}
            onOpenChange={(e) => {
              if (!e.open) selectedItemId.set(null);
            }}
            side="bottom"
            closeOnSwipe
            popupClass="bg-card rounded-t-2xl border-t border-border p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] max-h-[88%]"
            backdropClass="bg-black/45"
          >
            <View class="gap-3">
              <View class="flex-row justify-end">
                <Button
                  onPress={() => selectedItemId.set(null)}
                  class="rounded-full bg-muted px-3 py-1"
                >
                  <Text class="text-xs text-foreground">关闭</Text>
                </Button>
              </View>
              <Scroll class="max-h-[480px]" contentClass="pb-4">
                <If when={selectedItem()}>{(item) => renderItemDetailContent(item())}</If>
              </Scroll>
            </View>
          </Sheet>
        </If>

        {/* Create Vault Sheet */}
        <Sheet
          open={newVaultDialogOpen()}
          onOpenChange={(e) => {
            if (!e.open) newVaultDialogOpen.set(false);
          }}
          side="bottom"
          popupClass="bg-card rounded-t-2xl border-t border-border p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]"
          backdropClass="bg-black/45"
        >
          <View class="gap-3">
            <Text class="text-base font-semibold text-foreground">新建保险库</Text>
            <Input
              value={newVaultName()}
              onChange={(e) => newVaultName.set(e.value)}
              placeholder="例如 家庭、公司"
              class="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground"
            />
            <View class="flex-row gap-2">
              <Button
                onPress={() => newVaultDialogOpen.set(false)}
                class="flex-1 items-center rounded-xl border border-border bg-background py-2.5"
              >
                <Text class="text-xs font-medium text-foreground">取消</Text>
              </Button>
              <Button
                onPress={() => void handleCreateVault()}
                class="flex-1 items-center rounded-xl bg-primary py-2.5"
              >
                <Text class="text-xs font-semibold text-primary-foreground">创建</Text>
              </Button>
            </View>
          </View>
        </Sheet>
      </View>
    );
  }

  function renderInboxTab() {
    return (
      <View class="flex-1 bg-background">
        <View class="gap-2.5 border-b border-border bg-card px-4 py-3">
          <View class="flex-row items-center justify-between gap-2">
            <View class="gap-0.5">
              <Text class="text-xl font-bold text-foreground">收件箱</Text>
              <Text class="text-xs text-muted-foreground">
                端到端加密邮箱验证码流 ({filteredEmails().length} 封)
              </Text>
            </View>
            <Button
              testID="sync-imap-btn"
              disabled={syncingImap()}
              onPress={() => void handleSyncImap()}
              class="rounded-xl bg-primary px-3.5 py-2 active:opacity-85 disabled:opacity-50"
            >
              <Text class="text-xs font-semibold text-primary-foreground">
                {syncingImap() ? "同步中..." : "立即同步收信"}
              </Text>
            </Button>
          </View>

          <If when={mailboxes().length > 0}>
            <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-1.5">
              <Button
                onPress={() => selectedMailbox.set("all")}
                class={`rounded-full border px-3 py-1 ${
                  selectedMailbox() === "all"
                    ? "border-primary bg-primary"
                    : "border-border bg-background"
                }`}
              >
                <Text
                  class={`text-xs font-medium ${
                    selectedMailbox() === "all" ? "text-primary-foreground" : "text-foreground"
                  }`}
                >
                  全部邮箱 ({emails().length})
                </Text>
              </Button>
              <Each of={mailboxes()} key={(m) => m.address}>
                {(mb) => (
                  <Button
                    onPress={() => selectedMailbox.set(mb().address)}
                    class={`rounded-full border px-3 py-1 ${
                      selectedMailbox() === mb().address
                        ? "border-primary bg-primary"
                        : "border-border bg-background"
                    }`}
                  >
                    <Text
                      class={`text-xs font-medium ${
                        selectedMailbox() === mb().address
                          ? "text-primary-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {mb().label ? `${mb().label} · ${mb().address}` : mb().address} ({mb().count})
                    </Text>
                  </Button>
                )}
              </Each>
            </Scroll>
          </If>
        </View>

        <Scroll class="flex-1" contentClass="p-4 gap-3 pb-6">
          <If
            when={filteredEmails().length > 0}
            else={
              <View class="items-center gap-2 rounded-2xl border border-dashed border-border bg-card p-8">
                <Text class="text-sm font-medium text-foreground">暂无验证码邮件</Text>
                <Text class="text-center text-xs text-muted-foreground">
                  在「设置 → 多邮箱 IMAP 收信」中添加 Gmail / QQ / 163 / 126 / iCloud / Outlook 后点击「立即同步收信」。
                </Text>
              </View>
            }
          >
            <Each of={filteredEmails()} key={(em) => em.id}>
              {(em) => {
                const expanded = computed(() => expandedEmailId() === em().id);
                const recipient = computed(
                  () => em().envelopeTo?.trim() || em().to?.trim() || ""
                );
                return (
                  <View class="gap-2.5 rounded-2xl border border-border bg-card p-4">
                    <View class="flex-row items-start justify-between gap-2">
                      <View class="flex-1 gap-1">
                        <View class="flex-row flex-wrap items-center gap-1.5">
                          <View class="rounded bg-muted px-1.5 py-0.5">
                            <Text class="font-mono text-[10px] font-semibold uppercase text-foreground">
                              {em().source}
                            </Text>
                          </View>
                          <Text class="truncate text-xs font-medium text-foreground">
                            {em().from}
                          </Text>
                          <If when={recipient()}>
                            <View class="rounded bg-primary/10 px-1.5 py-0.5">
                              <Text class="truncate font-mono text-[10px] text-primary">
                                → {recipient()}
                              </Text>
                            </View>
                          </If>
                        </View>
                        <Text class="text-sm font-semibold text-foreground">{em().subject}</Text>
                      </View>
                      <Button
                        onPress={() => void handleDeleteEmail(em())}
                        class="rounded-lg px-2 py-1 active:bg-muted"
                      >
                        <Text class="text-xs text-muted-foreground">删除</Text>
                      </Button>
                    </View>

                    <If when={em().otpCode}>
                      {(code) => (
                        <Button
                          onPress={() => void handleCopyText(code(), "邮箱验证码")}
                          class="flex-row items-center justify-between rounded-xl border border-border bg-background px-3.5 py-2.5 active:bg-muted"
                        >
                          <View class="gap-0.5">
                            <Text class="text-[11px] text-muted-foreground">
                              提取验证码 (置信度 {Math.round(em().confidence * 100)}%)
                            </Text>
                            <Text class="font-mono text-2xl font-bold tracking-widest text-foreground">
                              {code()}
                            </Text>
                          </View>
                          <View class="rounded-lg bg-primary px-3 py-1.5">
                            <Text class="text-xs font-semibold text-primary-foreground">复制</Text>
                          </View>
                        </Button>
                      )}
                    </If>

                    <If when={em().magicLink}>
                      {(link) => (
                        <Button
                          onPress={() => void openUrl(link())}
                          class="self-start rounded-lg border border-border bg-background px-3 py-1.5 active:bg-muted"
                        >
                          <Text class="text-xs font-medium text-primary">打开登录链接</Text>
                        </Button>
                      )}
                    </If>

                    <Button
                      onPress={() =>
                        expandedEmailId.set(expanded() ? null : em().id)
                      }
                      class="gap-1"
                    >
                      <Text
                        class={`text-xs text-muted-foreground ${
                          expanded() ? "" : "line-clamp-2"
                        }`}
                      >
                        {expanded() ? em().textBody || em().snippet : em().snippet}
                      </Text>
                      <Text class="text-[11px] font-medium text-primary">
                        {expanded() ? "收起正文" : "展开详情"}
                      </Text>
                    </Button>
                  </View>
                );
              }}
            </Each>
          </If>
        </Scroll>
      </View>
    );
  }

  function renderSettingsTab() {
    return (
      <View class="flex-1 bg-background">
        <View class="border-b border-border bg-card px-4 py-3">
          <Text class="text-xl font-bold text-foreground">设置</Text>
          <Text class="text-xs text-muted-foreground">
            多邮箱 IMAP 收信 · 邮件过滤 · 安全审计 · 外观与会话
          </Text>
        </View>

        <Scroll class="flex-1" contentClass="p-4 gap-4 pb-8">
          {/* Multi-Account IMAP Section */}
          <View class="gap-3 rounded-2xl border border-border bg-card p-4">
            <View class="flex-row items-center justify-between gap-2">
              <View class="flex-1 gap-0.5">
                <Text class="text-base font-semibold text-foreground">多邮箱 IMAP 收信</Text>
                <Text class="text-xs text-muted-foreground">
                  支持 Gmail / QQ / 163 / 126 / iCloud / Outlook / 自定义无限账号
                </Text>
              </View>
              <Button
                testID="add-imap-btn"
                onPress={() => {
                  editingImapAccount.set(null);
                  imapEditorOpen.set(true);
                }}
                class="rounded-xl bg-primary px-3 py-2 active:opacity-85"
              >
                <Text class="text-xs font-semibold text-primary-foreground">+ 添加邮箱账号</Text>
              </Button>
            </View>

            <If
              when={imapAccounts().length > 0}
              else={
                <View class="rounded-xl border border-dashed border-border bg-background p-4">
                  <Text class="text-center text-xs text-muted-foreground">
                    尚未配置 IMAP 收信邮箱，点击上方按钮添加。
                  </Text>
                </View>
              }
            >
              <Each of={imapAccounts()} key={(a) => a.id}>
                {(acc) => {
                  const statusInfo = computed(() => getImapStatusInfo(acc()));
                  return (
                    <View class="gap-2 rounded-xl border border-border bg-background p-3">
                      <View class="flex-row items-center justify-between gap-2">
                        <View class="flex-1 gap-0.5">
                          <View class="flex-row items-center gap-2">
                            <Text class="text-sm font-semibold text-foreground">
                              {acc().label || acc().username}
                            </Text>
                            <View class={`rounded-full px-2 py-0.5 ${statusInfo().badgeClass}`}>
                              <Text class="text-[10px] font-medium">{statusInfo().label}</Text>
                            </View>
                          </View>
                          <Text class="text-xs text-muted-foreground">
                            {acc().username} · {acc().host}:{acc().port}
                          </Text>
                        </View>
                        <Switch
                          checked={acc().enabled}
                          onChange={() => void handleToggleImapEnabled(acc())}
                          trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
                          thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-4"
                        />
                      </View>

                      <If when={acc().lastError}>
                        {(errText) => (
                          <Text class="text-[11px] text-destructive">异常：{errText()}</Text>
                        )}
                      </If>

                      <View class="flex-row gap-2">
                        <Button
                          onPress={() => void handleSyncImap(acc().id)}
                          class="rounded-lg border border-border bg-card px-2.5 py-1.5 active:bg-muted"
                        >
                          <Text class="text-xs text-foreground">立即同步</Text>
                        </Button>
                        <Button
                          onPress={() => {
                            editingImapAccount.set(acc());
                            imapEditorOpen.set(true);
                          }}
                          class="rounded-lg border border-border bg-card px-2.5 py-1.5 active:bg-muted"
                        >
                          <Text class="text-xs text-foreground">编辑 / 改授权码</Text>
                        </Button>
                        <Button
                          onPress={() => void handleDeleteImapAccount(acc())}
                          class="rounded-lg bg-destructive/10 px-2.5 py-1.5 active:opacity-75"
                        >
                          <Text class="text-xs text-destructive">删除</Text>
                        </Button>
                      </View>
                    </View>
                  );
                }}
              </Each>
            </If>
          </View>

          {/* Email Filter Card */}
          <View class="gap-3 rounded-2xl border border-border bg-card p-4">
            <Text class="text-base font-semibold text-foreground">邮件过滤策略</Text>
            <View class="flex-row items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5">
              <View class="flex-1 gap-0.5 pr-3">
                <Text class="text-sm font-medium text-foreground">仅保留含验证码邮件</Text>
                <Text class="text-xs text-muted-foreground">
                  开启后仅入库包含 OTP 或登录链接的邮件 (otpOnly)
                </Text>
              </View>
              <Switch
                testID="otp-only-switch"
                checked={emailFilter().otpOnly}
                onChange={(e) => void handleToggleOtpOnly(e.checked)}
                trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
                thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-4"
              />
            </View>
          </View>

          {/* Security Audit Summary */}
          <View class="gap-3 rounded-2xl border border-border bg-card p-4">
            <View class="flex-row items-center justify-between">
              <Text class="text-base font-semibold text-foreground">安全审计总览</Text>
              <View class="rounded-full bg-primary/15 px-3 py-1">
                <Text class="font-mono text-xs font-bold text-primary">
                  评分 {auditSummary().score} / 100
                </Text>
              </View>
            </View>
            <View class="flex-row gap-2">
              <View class="flex-1 items-center gap-0.5 rounded-xl border border-border bg-background p-2.5">
                <Text class="font-mono text-lg font-bold text-destructive">
                  {auditSummary().weakItems.length}
                </Text>
                <Text class="text-[11px] text-muted-foreground">弱密码</Text>
              </View>
              <View class="flex-1 items-center gap-0.5 rounded-xl border border-border bg-background p-2.5">
                <Text class="font-mono text-lg font-bold text-amber-600 dark:text-amber-400">
                  {auditSummary().reusedItems.length}
                </Text>
                <Text class="text-[11px] text-muted-foreground">重复密码</Text>
              </View>
              <View class="flex-1 items-center gap-0.5 rounded-xl border border-border bg-background p-2.5">
                <Text class="font-mono text-lg font-bold text-foreground">
                  {auditSummary().missingTotpItems.length}
                </Text>
                <Text class="text-[11px] text-muted-foreground">未开 2FA</Text>
              </View>
            </View>
          </View>

          {/* Appearance */}
          <View class="gap-2.5 rounded-2xl border border-border bg-card p-4">
            <Text class="text-base font-semibold text-foreground">外观主题</Text>
            <View class="flex-row gap-2">
              <Each of={THEME_OPTIONS}>
                {(opt) => (
                  <Button
                    onPress={() => handleChangeTheme(opt().key)}
                    class={`flex-1 items-center rounded-xl border py-2.5 ${
                      themePref() === opt().key
                        ? "border-primary bg-primary"
                        : "border-border bg-background"
                    }`}
                  >
                    <Text
                      class={`text-xs font-medium ${
                        themePref() === opt().key
                          ? "text-primary-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {opt().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>

          {/* Session & Actions */}
          <View class="gap-2.5 rounded-2xl border border-border bg-card p-4">
            <Text class="text-base font-semibold text-foreground">账号与同步</Text>
            <Text class="text-xs text-muted-foreground">
              服务端：{session()?.serverUrl} · 账号：{session()?.email}
            </Text>
            <View class="flex-row gap-2">
              <Button
                disabled={syncing()}
                onPress={() => void handleManualSync()}
                class="flex-1 items-center rounded-xl border border-border bg-background py-2.5 active:bg-muted"
              >
                <Text class="text-xs font-medium text-foreground">
                  {syncing() ? "同步中..." : "立即全量同步"}
                </Text>
              </Button>
              <Button
                testID="lock-vault-btn"
                onPress={() => void handleLock(false)}
                class="flex-1 items-center rounded-xl bg-destructive py-2.5 active:opacity-85"
              >
                <Text class="text-xs font-semibold text-white">锁定密码库</Text>
              </Button>
            </View>
            <Button
              onPress={() => void handleLock(true)}
              class="items-center rounded-xl border border-border bg-background py-2 active:bg-muted"
            >
              <Text class="text-xs text-muted-foreground">清除已记住的密钥并锁定</Text>
            </Button>
          </View>
        </Scroll>
      </View>
    );
  }

  function renderMainContent() {
    const tab = activeTab();
    if (tab === "totp") return renderTotpTab();
    if (tab === "vault") return renderVaultTab();
    if (tab === "inbox") return renderInboxTab();
    return renderSettingsTab();
  }

  function renderUnlockedShell() {
    const tabIndex = computed(() => Math.max(0, TAB_ORDER.indexOf(activeTab())));

    if (isDesktop) {
      return (
        <View class="flex-1 flex-row bg-background">
          {/* Desktop Left Rail */}
          <View class="w-56 justify-between border-r border-border bg-card p-3">
            <View class="gap-4">
              <View class="flex-row items-center gap-2.5 px-2 py-1">
                <View class="h-8 w-8 items-center justify-center rounded-lg bg-primary">
                  <Text class="text-xs font-bold text-primary-foreground">NP</Text>
                </View>
                <View class="flex-1">
                  <Text class="text-sm font-bold text-foreground">NonePwd</Text>
                  <Text class="truncate text-[10px] text-muted-foreground">
                    {session()?.email}
                  </Text>
                </View>
              </View>

              <View class="gap-1">
                {(
                  [
                    { key: "totp", label: "验证码 (2FA)" },
                    { key: "vault", label: "密码库" },
                    { key: "inbox", label: "收件箱" },
                    { key: "settings", label: "设置" },
                  ] as const
                ).map((nav) => (
                  <Button
                    onPress={() => activeTab.set(nav.key)}
                    class={`rounded-xl px-3 py-2.5 ${
                      activeTab() === nav.key ? "bg-primary" : "bg-transparent hover:bg-muted"
                    }`}
                  >
                    <Text
                      class={`text-sm font-medium ${
                        activeTab() === nav.key ? "text-primary-foreground" : "text-foreground"
                      }`}
                    >
                      {nav.label}
                    </Text>
                  </Button>
                ))}
              </View>
            </View>

            <View class="gap-2">
              <Button
                disabled={syncing()}
                onPress={() => void handleManualSync()}
                class="items-center rounded-xl border border-border bg-background py-2 hover:bg-muted"
              >
                <Text class="text-xs font-medium text-foreground">
                  {syncing() ? "同步中..." : "立即同步"}
                </Text>
              </Button>
              <Button
                onPress={() => void handleLock(false)}
                class="items-center rounded-xl bg-muted py-2 hover:bg-destructive/20"
              >
                <Text class="text-xs font-medium text-foreground">锁定</Text>
              </Button>
            </View>
          </View>

          <View class="flex-1">{renderMainContent()}</View>
        </View>
      );
    }

    // Mobile layout with native TabBar when available, fallback bottom Tabs otherwise
    return (
      <View class="flex-1 bg-background pt-[env(safe-area-inset-top)]">
        <View class="flex-1">{renderMainContent()}</View>
        <If
          when={mobileApisAvailable}
          else={
            <Tabs class="flex-row border-t border-border bg-card px-2 py-1.5 pb-[calc(env(safe-area-inset-bottom)+6px)]">
              <Each
                of={[
                  { key: "totp" as const, label: "验证码" },
                  { key: "vault" as const, label: "密码库" },
                  { key: "inbox" as const, label: "收件箱" },
                  { key: "settings" as const, label: "设置" },
                ]}
              >
                {(t) => (
                  <Tab
                    selected={activeTab() === t().key}
                    onPress={() => {
                      Haptics.selection();
                      activeTab.set(t().key);
                    }}
                    class={`flex-1 items-center rounded-xl py-2 ${
                      activeTab() === t().key ? "bg-primary/15" : ""
                    }`}
                  >
                    <Text
                      class={`text-xs font-semibold ${
                        activeTab() === t().key ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {t().label}
                    </Text>
                  </Tab>
                )}
              </Each>
            </Tabs>
          }
        >
          <TabBar
            testID="mobile-tab-bar"
            class="w-full"
            items={[
              {
                title: "验证码",
                icon: platform.select({ ios: "qrcode.viewfinder", android: "android:ic_lock_lock" }),
              },
              {
                title: "密码库",
                icon: platform.select({ ios: "key.fill", android: "android:ic_menu_manage" }),
              },
              {
                title: "收件箱",
                icon: platform.select({ ios: "envelope.badge", android: "android:ic_dialog_email" }),
              },
              {
                title: "设置",
                icon: platform.select({ ios: "gearshape.fill", android: "android:ic_menu_preferences" }),
              },
            ]}
            selectedIndex={tabIndex()}
            onChange={(e) => {
              Haptics.selection();
              activeTab.set(TAB_ORDER[e.index] ?? "totp");
            }}
          />
        </If>
      </View>
    );
  }

  return (
    <View class="flex-1 bg-background">
      <If when={phase() === "unlocked"} else={renderAuthView()}>
        {renderUnlockedShell()}
      </If>

      {/* Sheets */}
      <ItemEditorSheet
        open={itemEditorOpen()}
        initialItem={editingItem()}
        vaults={vaults()}
        defaultVaultId={selectedVaultId()}
        allTags={allTags()}
        onSave={handleSaveVaultItem}
        onOpenQrForTotp={(cb) => {
          singleTotpCallback = cb;
          qrSheetMode.set("single");
          qrSheetOpen.set(true);
        }}
        onClose={() => itemEditorOpen.set(false)}
      />

      <ImapEditorSheet
        open={imapEditorOpen()}
        initialAccount={editingImapAccount()}
        onTest={async (input) => {
          const cur = session();
          if (!cur) return { ok: false, error: "密码库已锁定" };
          return testImapConnection(cur.serverUrl, cur.token, input);
        }}
        onSave={handleSaveImapAccount}
        onClose={() => imapEditorOpen.set(false)}
      />

      <QrScannerSheet
        open={qrSheetOpen()}
        mode={qrSheetMode()}
        vaults={vaults()}
        existingItems={items()}
        initialVaultId={selectedVaultId() !== "all" ? selectedVaultId() : vaults()[0]?.id}
        onApplySingle={(entry) => {
          singleTotpCallback?.(entry);
          singleTotpCallback = null;
        }}
        onImportPlan={handleImportTotpPlan}
        onClose={() => qrSheetOpen.set(false)}
      />

      {/* Toast Overlay */}
      <If when={toast()}>
        {(t) => (
          <Overlay class="top-12 left-4 right-4 items-center">
            <Button
              onPress={() => toast.set(null)}
              class={`rounded-full border px-4 py-2 ${
                t().kind === "error"
                  ? "border-destructive bg-destructive"
                  : "border-border bg-card"
              }`}
            >
              <Text
                class={`text-xs font-medium ${
                  t().kind === "error" ? "text-white" : "text-foreground"
                }`}
              >
                {t().text}
              </Text>
            </Button>
          </Overlay>
        )}
      </If>
    </View>
  );
}

mount(App);
