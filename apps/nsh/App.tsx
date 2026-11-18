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
  lifecycle,
  mount,
  openUrl,
  platform,
  setColorScheme,
  signal,
  token,
  windowSize,
} from "nsh";
import { AlertDialog, Button, Progress, Switch, Tab, Tabs } from "nsh/base";
import { BackHandler, Haptics, TabBar, isAvailable as mobileApisAvailable } from "nsh/mobile";
import appIcon from "./icon.png";
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
  rememberDurationMs,
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
  getAndroidAutofillStatus,
  requestEnableAndroidAutofill,
  syncAndroidAutofill,
  takePendingAndroidSaves,
  type AndroidAutofillStatus,
  type PendingAndroidSave,
} from "./src/autofill";
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
import chevronRightIcon from "./src/icons/chevron-right.png";
import copyIcon from "./src/icons/copy.png";
import plusIcon from "./src/icons/plus.png";
import qrcodeIcon from "./src/icons/qrcode.png";
import refreshIcon from "./src/icons/refresh.png";
import { ImapEditorSheet } from "./src/imap-editor";
import { CATEGORY_OPTIONS, ItemEditorSheet } from "./src/item-editor";
import { QrScannerSheet } from "./src/qr-scanner";
import {
  ActionButton,
  AppBrandLogo,
  AppInput,
  AppSelect,
  BadgePill,
  BodyText,
  CaptionText,
  CompactButton,
  FeedbackBanner,
  FilterPill,
  FormField,
  GroupedList,
  GroupedRow,
  ItemAvatar,
  OtpHeroText,
  PageTitle,
  ScreenHeader,
  SearchBar,
  SectionHeader,
  SectionTitle,
  SegmentedControl,
  SheetContainer,
  SubheadText,
  SurfaceCard,
  UiIcon,
  type BadgeTone,
} from "./src/ui";

type AppTab = "totp" | "vault" | "inbox" | "settings";
const TAB_ORDER: AppTab[] = ["totp", "vault", "inbox", "settings"];

const MOBILE_TABS = [
  { key: "totp" as const, label: "验证码" },
  { key: "vault" as const, label: "密码库" },
  { key: "inbox" as const, label: "收件箱" },
  { key: "settings" as const, label: "设置" },
];

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

function getImapStatusInfo(acc: ImapAccountPublic): { label: string; tone: BadgeTone } {
  if (!acc.enabled || acc.status === "disabled") {
    return { label: "已禁用", tone: "neutral" };
  }
  if (acc.status === "listening") {
    return { label: "监听中", tone: "success" };
  }
  if (acc.status === "connecting") {
    return { label: "连接中", tone: "warning" };
  }
  return { label: "连接异常", tone: "danger" };
}

function App() {
  const isWideDesktop = computed(() => platform.desktop && windowSize().width >= 720);

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

  // Android System Autofill state
  const autofillStatus = signal<AndroidAutofillStatus>({
    available: false,
    supported: false,
    enabled: false,
  });
  const pendingAndroidSaves = signal<PendingAndroidSave[]>([]);

  function showToast(text: string, kind: "ok" | "error" | "info" = "info") {
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toast.set({ kind, text });
    toastTimer = setTimeout(() => {
      toast.set(null);
    }, 2600);
  }

  async function syncAutofillNow() {
    if (phase() !== "unlocked") return;
    const durMs = rememberDurationMs(rememberDuration());
    const expiresAtMs = durMs > 0 ? Date.now() + durMs : 0;
    await syncAndroidAutofill({
      unlocked: true,
      expiresAtMs,
      items: items(),
      emails: emails(),
    });
  }

  async function refreshAutofillAndPending() {
    const st = await getAndroidAutofillStatus();
    autofillStatus.set(st);
    if (phase() === "unlocked") {
      const pending = await takePendingAndroidSaves();
      if (pending.length > 0) {
        pendingAndroidSaves.update((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...pending.filter((p) => !seen.has(p.id))];
        });
      }
    }
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
      const [prefs, savedTheme, remembered, afStatus] = await Promise.all([
        loadClientPrefs(),
        loadThemePreference(),
        loadRememberedSession(),
        getAndroidAutofillStatus(),
      ]);
      if (cancelled) return;
      batch(() => {
        serverUrl.set(prefs.serverUrl || DEFAULT_SERVER_URL);
        if (prefs.secretKey && !secretKeyInput()) {
          secretKeyInput.set(prefs.secretKey);
        }
        rememberDuration.set(prefs.rememberDuration);
        themePref.set(savedTheme);
        autofillStatus.set(afStatus);
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
          void syncAutofillNow();
          void refreshAutofillAndPending();
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

  // Refresh Android Autofill status and pending captured logins when app resumes
  effect(() => {
    if (phase() === "unlocked" && lifecycle() === "active") {
      void refreshAutofillAndPending();
    }
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
      if (!isWideDesktop() && activeTab() === "vault" && selectedItemId()) {
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
      void syncAutofillNow();
      void refreshAutofillAndPending();
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
      void syncAutofillNow();
      void refreshAutofillAndPending();
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
    void syncAndroidAutofill({ unlocked: false });
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
      emailFilter.set(DEFAULT_EMAIL_FILTER);
      pendingAndroidSaves.set([]);
      selectedVaultId.set("all");
      selectedCategory.set("all");
      selectedTag.set("all");
      selectedItemId.set(null);
      selectedMailbox.set("all");
      expandedEmailId.set(null);
      revealedFieldKeys.set({});
      totpSearch.set("");
      vaultSearch.set("");
      masterPasswordInput.set("");
      activeTab.set("totp");
      phase.set("locked");
    });
    showToast(clearCredentials ? "已退出登录并清除本地密钥" : "密码库已锁定", "info");
  }

  async function handleManualSync() {
    const cur = session();
    if (!cur || syncing()) return;
    syncing.set(true);
    try {
      await performSync(cur);
      void syncAutofillNow();
      void refreshAutofillAndPending();
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

  async function handleSaveVaultItem(
    payload: VaultItemPayload,
    isNew: boolean,
    opts?: { select?: boolean }
  ) {
    const cur = session();
    if (!cur) throw new Error("密码库已锁定");
    const vk = vaultKeys().get(payload.vaultId);
    if (!vk) throw new Error("未找到对应保险库密钥");
    const saved = await saveItem(cur.serverUrl, cur.token, vk, payload, isNew);
    items.update((prev) => [saved, ...prev.filter((i) => i.id !== saved.id)]);
    if (opts?.select !== false) {
      selectedItemId.set(saved.id);
    }
    void syncAutofillNow();
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
      void syncAutofillNow();
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
        const nextItem: VaultItemPayload = {
          ...existing,
          totp: step.otpauthUri,
          updatedAt: now,
        };
        const saved = await saveItem(cur.serverUrl, cur.token, vk, nextItem, false);
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
      void syncAutofillNow();
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
      void syncAutofillNow();
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
      void syncAutofillNow();
      showToast("已删除邮件记录", "ok");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除邮件失败", "error");
    }
  }

  async function handleEnableAndroidAutofill() {
    const launched = await requestEnableAndroidAutofill();
    if (launched) {
      showToast("请在系统设置中选择「NonePwd」作为自动填充服务", "info");
      setTimeout(() => {
        void getAndroidAutofillStatus().then((st) => autofillStatus.set(st));
      }, 800);
    } else if (platform.os !== "android") {
      showToast("系统级自动填充服务仅支持 Android 8.0+ 原生客户端", "info");
    } else {
      showToast("请前往系统设置 → 密码与自动填充 → 选择 NonePwd", "info");
    }
  }

  async function handleRefreshAutofillStatus() {
    const st = await getAndroidAutofillStatus();
    autofillStatus.set(st);
    if (phase() === "unlocked") {
      await syncAutofillNow();
      await refreshAutofillAndPending();
    }
    showToast(st.enabled ? "系统自动填充已开启" : "已刷新自动填充状态", "info");
  }

  async function handleSavePendingAndroidLogin(pending: PendingAndroidSave) {
    const targetVid =
      selectedVaultId() !== "all" ? selectedVaultId() : vaults()[0]?.id ?? "";
    if (!targetVid) {
      showToast("未找到可用保险库", "error");
      return;
    }
    const now = new Date().toISOString();
    const rawDomain = pending.domain.trim();
    const url = rawDomain
      ? /^https?:\/\//i.test(rawDomain)
        ? rawDomain
        : `https://${rawDomain}`
      : "";
    const title = rawDomain || pending.packageName || pending.username || "登录凭据";
    try {
      await handleSaveVaultItem(
        {
          id: randomId(),
          vaultId: targetVid,
          category: "login",
          title,
          favorite: false,
          tags: [],
          urls: url ? [url] : [],
          username: pending.username,
          password: pending.password,
          customFields: [],
          createdAt: now,
          updatedAt: now,
        },
        true,
        { select: isWideDesktop() }
      );
      pendingAndroidSaves.update((prev) => prev.filter((p) => p.id !== pending.id));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存自动填充凭据失败", "error");
    }
  }

  function handleDismissPendingAndroidLogin(id: string) {
    pendingAndroidSaves.update((prev) => prev.filter((p) => p.id !== id));
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

  function renderItemDetailContent(item: () => VaultItemPayload, inSheet = false) {
    const totpState = computed(() => totpCodes()[item().id]);
    const vaultName = computed(
      () => vaults().find((v) => v.id === item().vaultId)?.metadata.name ?? "保险库"
    );
    const warnings = computed(() => auditSummary().issuesByItemId[item().id] ?? []);
    const sshPub = computed(() => {
      const cur = item();
      return cur.category === "ssh_key"
        ? cur.customFields.find((f) => f.label.trim().toLowerCase() === "public_key")?.value
        : undefined;
    });
    const sshPass = computed(() => {
      const cur = item();
      return cur.category === "ssh_key"
        ? cur.customFields.find((f) => f.label.trim().toLowerCase() === "passphrase")?.value
        : undefined;
    });
    const extraCustom = computed(() => {
      const cur = item();
      return cur.category === "ssh_key"
        ? cur.customFields.filter((f) => {
            const k = f.label.trim().toLowerCase();
            return k !== "public_key" && k !== "passphrase";
          })
        : cur.customFields;
    });

    const lastDetailKey = computed(() => {
      const cur = item();
      const visibleKeys: string[] = [];
      if (totpState()) visibleKeys.push("totp");
      if (cur.username) visibleKeys.push("username");
      if (cur.password) visibleKeys.push("password");
      if (sshPub()) visibleKeys.push("sshPub");
      if (sshPass()) visibleKeys.push("sshPass");
      if (cur.card) visibleKeys.push("card");
      if (cur.identity) visibleKeys.push("identity");
      if (cur.urls.length > 0) visibleKeys.push("urls");
      for (const cf of extraCustom()) visibleKeys.push(`cf:${cf.id}`);
      if (cur.notes) visibleKeys.push("notes");
      return visibleKeys[visibleKeys.length - 1];
    });

    return (
      <View class="gap-4">
        {/* Title & Actions */}
        <View class="flex-row items-start justify-between gap-3">
          <View class="flex-1 min-w-0 flex-row items-center gap-3">
            <ItemAvatar title={item().title} category={item().category} />
            <View class="flex-1 min-w-0 gap-1">
              <If when={!inSheet}>
                <SectionTitle>{item().title}</SectionTitle>
              </If>
              <View class="flex-row flex-wrap items-center gap-2">
                <BadgePill label={vaultName()} tone="neutral" />
                <BadgePill label={categoryLabel(item().category)} tone="primary" />
              </View>
              <If when={item().tags.length > 0}>
                <View class="flex-row flex-wrap gap-1 pt-1">
                  <Each of={item().tags}>
                    {(tag) => <BadgePill label={`#${tag()}`} tone="neutral" />}
                  </Each>
                </View>
              </If>
            </View>
          </View>

          <View class="shrink-0 flex-row items-center gap-2">
            <CompactButton
              label="编辑"
              variant="neutral"
              onPress={() => {
                editingItem.set(item());
                itemEditorOpen.set(true);
              }}
            />
            <CompactButton
              label="删除"
              variant="danger"
              onPress={() => void handleDeleteVaultItem(item())}
            />
          </View>
        </View>

        <If when={warnings().length > 0}>
          <FeedbackBanner kind="warning" text={`安全提醒：${warnings().join(" · ")}`} />
        </If>

        {/* Quiet Grouped Fields List (no nested cards) */}
        <If when={lastDetailKey() !== undefined}>
          <GroupedList surface={inSheet ? "sheet" : "canvas"}>
            {/* TOTP */}
            <If when={totpState()}>
              {(t) => (
                <GroupedRow
                  last={lastDetailKey() === "totp"}
                  onPress={() => void handleCopyText(t().code, " 2FA 验证码")}
                  class="flex-row items-center justify-between gap-3"
                >
                  <View class="flex-1 min-w-0 gap-1">
                    <SubheadText>一次性动态验证码 (点击复制)</SubheadText>
                    <OtpHeroText code={t().code} />
                  </View>
                  <BadgePill label={`${t().remainingSeconds}s`} tone="primary" />
                </GroupedRow>
              )}
            </If>

            {/* Username */}
            <If when={item().username}>
              {(u) => (
                <GroupedRow
                  last={lastDetailKey() === "username"}
                  class="flex-row items-center justify-between gap-3"
                >
                  <View class="flex-1 min-w-0 gap-1">
                    <CaptionText>用户名 / 标识</CaptionText>
                    <BodyText>{u()}</BodyText>
                  </View>
                  <CompactButton
                    label="复制"
                    icon={copyIcon}
                    variant="card"
                    onPress={() => void handleCopyText(u(), "用户名")}
                  />
                </GroupedRow>
              )}
            </If>

            {/* Password / Secret */}
            <If when={item().password}>
              {(pw) => (
                <GroupedRow
                  last={lastDetailKey() === "password"}
                  class="flex-row items-center justify-between gap-3"
                >
                  <View class="flex-1 min-w-0 gap-1">
                    <CaptionText>
                      {item().category === "api_credential"
                        ? "API 密钥"
                        : item().category === "ssh_key"
                          ? "SSH 私钥"
                          : "密码 / 机密"}
                    </CaptionText>
                    <Text class="font-mono text-[15px] text-foreground">
                      {revealedFieldKeys()[`${item().id}:pw`] ? pw() : maskSecret(pw())}
                    </Text>
                  </View>
                  <View class="shrink-0 flex-row gap-2">
                    <CompactButton
                      label={revealedFieldKeys()[`${item().id}:pw`] ? "隐藏" : "显示"}
                      variant="card"
                      onPress={() => toggleReveal(`${item().id}:pw`)}
                    />
                    <CompactButton
                      label="复制"
                      icon={copyIcon}
                      variant="tonal"
                      onPress={() => void handleCopyText(pw(), "密码")}
                    />
                  </View>
                </GroupedRow>
              )}
            </If>

            {/* SSH extra */}
            <If when={sshPub()}>
              {(pub) => (
                <GroupedRow
                  last={lastDetailKey() === "sshPub"}
                  class="flex-row items-center justify-between gap-3"
                >
                  <View class="flex-1 min-w-0 gap-1">
                    <CaptionText>SSH 公钥</CaptionText>
                    <Text class="line-clamp-2 font-mono text-[13px] text-foreground">{pub()}</Text>
                  </View>
                  <CompactButton
                    label="复制"
                    icon={copyIcon}
                    variant="card"
                    onPress={() => void handleCopyText(pub(), " SSH 公钥")}
                  />
                </GroupedRow>
              )}
            </If>
            <If when={sshPass()}>
              {(pass) => (
                <GroupedRow
                  last={lastDetailKey() === "sshPass"}
                  class="flex-row items-center justify-between gap-3"
                >
                  <View class="flex-1 min-w-0 gap-1">
                    <CaptionText>私钥口令</CaptionText>
                    <Text class="font-mono text-[14px] text-foreground">
                      {revealedFieldKeys()[`${item().id}:sshpass`] ? pass() : maskSecret(pass())}
                    </Text>
                  </View>
                  <View class="shrink-0 flex-row gap-2">
                    <CompactButton
                      label={revealedFieldKeys()[`${item().id}:sshpass`] ? "隐藏" : "显示"}
                      variant="card"
                      onPress={() => toggleReveal(`${item().id}:sshpass`)}
                    />
                    <CompactButton
                      label="复制"
                      icon={copyIcon}
                      variant="tonal"
                      onPress={() => void handleCopyText(pass(), "私钥口令")}
                    />
                  </View>
                </GroupedRow>
              )}
            </If>

            {/* Card Details */}
            <If when={item().card}>
              {(card) => (
                <GroupedRow last={lastDetailKey() === "card"} class="gap-2">
                  <If when={card().cardholderName}>
                    <BodyText>持卡人：{card().cardholderName}</BodyText>
                  </If>
                  <If when={card().number}>
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="flex-1 min-w-0 font-mono text-[15px] text-foreground">
                        {revealedFieldKeys()[`${item().id}:card`]
                          ? card().number
                          : `•••• •••• •••• ${(card().number ?? "").slice(-4)}`}
                      </Text>
                      <View class="shrink-0 flex-row gap-2">
                        <CompactButton
                          label={revealedFieldKeys()[`${item().id}:card`] ? "隐藏" : "显示"}
                          variant="card"
                          onPress={() => toggleReveal(`${item().id}:card`)}
                        />
                        <CompactButton
                          label="复制"
                          icon={copyIcon}
                          variant="tonal"
                          onPress={() => void handleCopyText(card().number ?? "", "卡号")}
                        />
                      </View>
                    </View>
                  </If>
                  <View class="flex-row gap-4">
                    <If when={card().expMonth || card().expYear}>
                      <SubheadText>
                        有效期：{card().expMonth}/{card().expYear}
                      </SubheadText>
                    </If>
                    <If when={card().cvv}>
                      <Button onPress={() => void handleCopyText(card().cvv ?? "", " CVV")}>
                        <SubheadText>
                          CVV：{revealedFieldKeys()[`${item().id}:card`] ? card().cvv : "•••"}
                        </SubheadText>
                      </Button>
                    </If>
                  </View>
                </GroupedRow>
              )}
            </If>

            {/* Identity Details */}
            <If when={item().identity}>
              {(id) => (
                <GroupedRow last={lastDetailKey() === "identity"} class="gap-1">
                  <If when={id().fullName}>
                    <BodyText class="font-semibold">{id().fullName}</BodyText>
                  </If>
                  <If when={id().email}>
                    <SubheadText>邮箱：{id().email}</SubheadText>
                  </If>
                  <If when={id().phone}>
                    <SubheadText>电话：{id().phone}</SubheadText>
                  </If>
                  <If when={id().address1 || id().city}>
                    <BodyText>
                      {[id().country, id().state, id().city, id().address1, id().postalCode]
                        .filter(Boolean)
                        .join(" ")}
                    </BodyText>
                  </If>
                </GroupedRow>
              )}
            </If>

            {/* URLs */}
            <If when={item().urls.length > 0}>
              <GroupedRow last={lastDetailKey() === "urls"} class="gap-1">
                <CaptionText>关联网址</CaptionText>
                <Each of={item().urls}>
                  {(u) => (
                    <Button
                      onPress={() => {
                        const target = /^https?:\/\//i.test(u()) ? u() : `https://${u()}`;
                        void openUrl(target);
                      }}
                      class="py-1 active:opacity-70"
                    >
                      <Text class="text-[14px] font-medium text-primary underline">{u()}</Text>
                    </Button>
                  )}
                </Each>
              </GroupedRow>
            </If>

            {/* Custom Fields */}
            <Each of={extraCustom()} key={(cf) => cf.id}>
              {(cf) => (
                <GroupedRow
                  last={lastDetailKey() === `cf:${cf().id}`}
                  class="flex-row items-center justify-between gap-3"
                >
                  <View class="flex-1 min-w-0 gap-1">
                    <CaptionText>{cf().label}</CaptionText>
                    <Text class="font-mono text-[14px] text-foreground">
                      {cf().type === "concealed" && !revealedFieldKeys()[`${item().id}:${cf().id}`]
                        ? maskSecret(cf().value)
                        : cf().value}
                    </Text>
                  </View>
                  <View class="shrink-0 flex-row gap-2">
                    <If when={cf().type === "concealed"}>
                      <CompactButton
                        label={revealedFieldKeys()[`${item().id}:${cf().id}`] ? "隐藏" : "显示"}
                        variant="card"
                        onPress={() => toggleReveal(`${item().id}:${cf().id}`)}
                      />
                    </If>
                    <CompactButton
                      label="复制"
                      icon={copyIcon}
                      variant="tonal"
                      onPress={() => void handleCopyText(cf().value, cf().label)}
                    />
                  </View>
                </GroupedRow>
              )}
            </Each>

            {/* Notes */}
            <If when={item().notes}>
              {(n) => (
                <GroupedRow last={lastDetailKey() === "notes"} class="gap-1">
                  <CaptionText>备注</CaptionText>
                  <BodyText>{n()}</BodyText>
                </GroupedRow>
              )}
            </If>
          </GroupedList>
        </If>
      </View>
    );
  }

  // ---------- Views ----------

  function renderAuthInlinePill(props: {
    label: string;
    variant?: "tonal" | "neutral";
    icon?: typeof copyIcon;
    disabled?: boolean;
    onPress: () => void;
  }) {
    const isTonal = () => (props.variant ?? "neutral") === "tonal";
    return (
      <Button
        disabled={props.disabled}
        onPress={props.onPress}
        class={`h-7 px-2.5 rounded-md items-center justify-center flex-row gap-1 disabled:opacity-50 ${
          isTonal() ? "bg-primary/12 active:opacity-75" : "bg-muted active:opacity-75"
        }`}
      >
        <If when={props.icon}>
          {(ic) => <UiIcon src={ic()} size={13} color={isTonal() ? token("primary") : token("foreground")} />}
        </If>
        <Text
          class={`text-[12px] font-semibold ${isTonal() ? "text-primary" : "text-foreground"}`}
          style={{ numberOfLines: 1 }}
        >
          {props.label}
        </Text>
      </Button>
    );
  }

  function renderAuthView() {
    return (
      <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <Scroll
          class="flex-1"
          contentClass="grow items-center justify-center px-4 py-3"
          bounces={false}
          scrollbar={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View class="w-full max-w-md gap-4">
            {/* Compact Brand Header */}
            <View class="flex-row items-center justify-center gap-3">
              <AppBrandLogo src={appIcon} size={44} class="h-11 w-11 rounded-xl" />
              <View class="gap-0.5">
                <PageTitle>NonePwd</PageTitle>
                <CaptionText>零知识密码库 · 2FA 与收信中枢</CaptionText>
              </View>
            </View>

            {/* Auth Card */}
            <View class="gap-3 rounded-2xl border border-border bg-card p-3.5">
              {/* Server URL */}
              <FormField
                label="服务端地址"
                class="gap-1.5"
                rightSlot={renderAuthInlinePill({
                  label: "检测服务端",
                  variant: "tonal",
                  disabled: authBusy(),
                  onPress: () => void handleCheckServer(),
                })}
              >
                <AppInput
                  testID="server-url-input"
                  value={serverUrl()}
                  onChange={(e) => serverUrl.set(e.value)}
                  placeholder="https://vault.yourdomain.com"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  class="h-10"
                  style={{ height: 40 }}
                />
              </FormField>

              {/* Mode toggle */}
              <SegmentedControl
                options={[
                  { key: "locked", label: "解锁密码库" },
                  { key: "setup", label: "初始化新服务端" },
                ]}
                value={phase() === "setup" ? "setup" : "locked"}
                onChange={(next) => {
                  authError.set(null);
                  phase.set(next);
                }}
              />

              {/* Unlock Form */}
              <If when={phase() === "locked"}>
                <View class="gap-3">
                  <FormField label="Secret Key" class="gap-1.5">
                    <AppInput
                      mono
                      testID="secret-key-input"
                      value={secretKeyInput()}
                      onChange={(e) => secretKeyInput.set(e.value)}
                      placeholder="NP3-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                      autoCapitalize="characters"
                      autoCorrect={false}
                      class="h-10"
                      style={{ height: 40 }}
                    />
                  </FormField>

                  <FormField
                    label="主密码"
                    class="gap-1.5"
                    rightSlot={renderAuthInlinePill({
                      label: showUnlockPassword() ? "隐藏" : "显示",
                      variant: "neutral",
                      onPress: () => showUnlockPassword.update((v) => !v),
                    })}
                  >
                    <AppInput
                      testID="master-password-input"
                      value={masterPasswordInput()}
                      onChange={(e) => masterPasswordInput.set(e.value)}
                      masked={!showUnlockPassword()}
                      autoComplete="current-password"
                      placeholder="输入主密码"
                      onSubmit={() => void handleUnlock()}
                      class="h-10"
                      style={{ height: 40 }}
                    />
                  </FormField>

                  <FormField label="记住登录时长" class="gap-1.5">
                    <SegmentedControl
                      options={REMEMBER_OPTIONS}
                      value={rememberDuration()}
                      onChange={(dur) => rememberDuration.set(dur)}
                    />
                  </FormField>

                  <If when={authError()}>
                    {(msg) => <FeedbackBanner kind="error" text={msg()} />}
                  </If>

                  <ActionButton
                    testID="unlock-button"
                    disabled={authBusy()}
                    onPress={() => void handleUnlock()}
                    label={authBusy() ? "正在派生密钥并同步..." : "解锁密码库"}
                  />
                </View>
              </If>

              {/* Setup Form */}
              <If when={phase() === "setup"}>
                <View class="gap-3">
                  <FormField label="主账号邮箱" class="gap-1.5">
                    <AppInput
                      value={setupEmail()}
                      onChange={(e) => setupEmail.set(e.value)}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      placeholder="owner@example.com"
                      class="h-10"
                      style={{ height: 40 }}
                    />
                  </FormField>

                  <FormField
                    label="Secret Key (请务必保存)"
                    class="gap-1.5"
                    rightSlot={
                      <View class="shrink-0 flex-row gap-1.5">
                        {renderAuthInlinePill({
                          label: "复制",
                          icon: copyIcon,
                          variant: "tonal",
                          onPress: () => void handleCopyText(setupSecretKey(), " Secret Key"),
                        })}
                        {renderAuthInlinePill({
                          label: "重新生成",
                          variant: "neutral",
                          onPress: () => setupSecretKey.set(generateSecretKey()),
                        })}
                      </View>
                    }
                  >
                    <View class="h-10 justify-center rounded-xl bg-input px-3">
                      <Text
                        class="font-mono text-[13px] text-foreground"
                        style={{ numberOfLines: 1 }}
                      >
                        {setupSecretKey()}
                      </Text>
                    </View>
                  </FormField>

                  <FormField label="设置主密码" class="gap-1.5">
                    <AppInput
                      value={setupPassword()}
                      onChange={(e) => setupPassword.set(e.value)}
                      masked
                      autoComplete="new-password"
                      placeholder="至少 10 位强密码"
                      class="h-10"
                      style={{ height: 40 }}
                    />
                  </FormField>

                  <FormField label="邮箱别名域名 (可选)" class="gap-1.5">
                    <AppInput
                      value={setupAliasDomain()}
                      onChange={(e) => setupAliasDomain.set(e.value)}
                      autoCapitalize="none"
                      placeholder="mail.example.com"
                      class="h-10"
                      style={{ height: 40 }}
                    />
                  </FormField>

                  <If when={authError()}>
                    {(msg) => <FeedbackBanner kind="error" text={msg()} />}
                  </If>

                  <ActionButton
                    disabled={authBusy()}
                    onPress={() => void handleSetup()}
                    label={authBusy() ? "正在创建加密保险库..." : "初始化并解锁"}
                  />
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
        <ScreenHeader
          title="验证码"
          badge={`${totpItems().length}`}
          rightSlot={
            <CompactButton
              testID="totp-import-btn"
              label="+ 导入 2FA"
              icon={qrcodeIcon}
              variant="primary"
              onPress={() => {
                singleTotpCallback = null;
                qrSheetMode.set("import");
                qrSheetOpen.set(true);
              }}
            />
          }
        >
          <SearchBar
            testID="totp-search-input"
            value={totpSearch()}
            onChange={(v) => totpSearch.set(v)}
            placeholder="搜索服务名或账号..."
          />
        </ScreenHeader>

        <Scroll
          class="flex-1"
          contentClass="px-4 pt-2 pb-6 gap-3"
          refreshing={syncing()}
          onRefresh={() => void handleManualSync()}
        >
          <If
            when={filteredTotpItems().length > 0}
            else={
              <SurfaceCard class="items-center py-8 gap-3 border border-border">
                <SectionTitle>暂无 2FA 验证码</SectionTitle>
                <SubheadText class="text-center">
                  支持相册选择二维码、摄像头扫码，或粘贴 otpauth:// 与 Google 迁移导出。
                </SubheadText>
                <ActionButton
                  label="立即导入 2FA 密钥"
                  icon={qrcodeIcon}
                  onPress={() => {
                    singleTotpCallback = null;
                    qrSheetMode.set("import");
                    qrSheetOpen.set(true);
                  }}
                />
              </SurfaceCard>
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
                  <SurfaceCard
                    class="border border-border"
                    onPress={() => {
                      const code = res()?.code;
                      if (code) void handleCopyText(code, ` ${it().title} 验证码`);
                    }}
                  >
                    <View class="flex-row items-center justify-between gap-3">
                      <View class="flex-1 min-w-0 flex-row items-center gap-3">
                        <ItemAvatar title={it().title} category={it().category} />
                        <View class="flex-1 min-w-0 gap-1">
                          <Text class="line-clamp-1 text-[15px] font-semibold text-foreground">
                            {it().title}
                          </Text>
                          <If when={it().username}>
                            <SubheadText lineClamp={1}>{it().username}</SubheadText>
                          </If>
                        </View>
                      </View>
                      <View class="shrink-0 items-end gap-1">
                        <OtpHeroText code={res()?.code ?? "------"} expiring={expiring()} />
                        <BadgePill
                          label={res() ? `${res()!.remainingSeconds}s` : "..."}
                          tone={expiring() ? "danger" : "primary"}
                        />
                      </View>
                    </View>
                    <Progress
                      value={pct()}
                      accessibilityLabel={`${it().title} 验证码倒计时`}
                      trackClass="h-1 w-full overflow-hidden rounded-full bg-secondary"
                      indicatorClass={`h-full rounded-full ${
                        expiring() ? "bg-destructive" : "bg-primary"
                      }`}
                    />
                  </SurfaceCard>
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
        <ScreenHeader
          title="密码库"
          badge={`${filteredVaultItems().length} / ${items().length}`}
          rightSlot={
            <View class="shrink-0 flex-row items-center gap-2">
              <CompactButton
                label={syncing() ? "同步中" : "同步"}
                icon={refreshIcon}
                variant="card"
                disabled={syncing()}
                onPress={() => void handleManualSync()}
              />
              <CompactButton
                testID="vault-add-btn"
                label="+ 新建"
                variant="primary"
                onPress={() => {
                  editingItem.set(null);
                  itemEditorOpen.set(true);
                }}
              />
            </View>
          }
        >
          <SearchBar
            testID="vault-search-input"
            value={vaultSearch()}
            onChange={(v) => vaultSearch.set(v)}
            placeholder="搜索标题、用户名、网址或标签..."
          />

          {/* Official Select for switching Vaults when multiple vaults exist */}
          <If when={vaults().length > 1}>
            <AppSelect
              surface="canvas"
              accessibilityLabel="切换保险库"
              items={[
                { value: "all", title: "全部保险库" },
                ...vaults().map((v) => ({
                  value: v.id,
                  title: v.metadata.name,
                })),
              ]}
              value={selectedVaultId()}
              onChange={(val) => selectedVaultId.set(val)}
            />
          </If>

          {/* Category Filter Pills */}
          <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-2">
            <FilterPill
              label="全部"
              selected={selectedCategory() === "all"}
              onPress={() => selectedCategory.set("all")}
            />
            <Each of={CATEGORY_OPTIONS}>
              {(cat) => (
                <FilterPill
                  label={cat().label}
                  selected={selectedCategory() === cat().key}
                  onPress={() => selectedCategory.set(cat().key)}
                />
              )}
            </Each>
          </Scroll>

          {/* Tag Filter Strip (only shown when tags exist) */}
          <If when={allTags().length > 0}>
            <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-2">
              <FilterPill
                label="全部分组"
                selected={selectedTag() === "all"}
                onPress={() => selectedTag.set("all")}
              />
              <Each of={allTags()}>
                {(tag) => (
                  <FilterPill
                    label={`#${tag()}`}
                    selected={selectedTag() === tag()}
                    onPress={() =>
                      selectedTag.set(selectedTag() === tag() ? "all" : tag())
                    }
                  />
                )}
              </Each>
            </Scroll>
          </If>
        </ScreenHeader>

        {/* Master-detail on desktop, quiet grouped list + sheet on mobile */}
        <View class={`flex-1 ${isWideDesktop() ? "flex-row" : ""}`}>
          <Scroll
            class={isWideDesktop() ? "w-80 border-r border-border" : "flex-1"}
            contentClass="px-4 pt-2 pb-6 gap-3"
            refreshing={syncing()}
            onRefresh={() => void handleManualSync()}
          >
            {/* Android System Autofill prompt when supported but not enabled */}
            <If when={autofillStatus().supported && !autofillStatus().enabled}>
              <GroupedList>
                <GroupedRow last class="flex-row items-center justify-between gap-3">
                  <View class="flex-1 min-w-0 gap-1">
                    <BodyText class="font-semibold">系统自动填充尚未开启</BodyText>
                    <SubheadText>开启后可在 Chrome 和其他 App 一键填充</SubheadText>
                  </View>
                  <CompactButton
                    label="去开启"
                    variant="tonal"
                    onPress={() => void handleEnableAndroidAutofill()}
                  />
                </GroupedRow>
              </GroupedList>
            </If>

            {/* Pending captured Android logins */}
            <If when={pendingAndroidSaves().length > 0}>
              <View class="gap-2">
                <SectionHeader title="待保存的自动填充登录" />
                <GroupedList>
                  <Each of={pendingAndroidSaves()} key={(p) => p.id}>
                    {(p, idx) => (
                      <GroupedRow
                        last={idx() === pendingAndroidSaves().length - 1}
                        class="flex-row items-center justify-between gap-3"
                      >
                        <View class="flex-1 min-w-0 gap-1">
                          <BodyText class="font-semibold" lineClamp={1}>
                            {p().domain || p().packageName || "新登录凭据"}
                          </BodyText>
                          <SubheadText lineClamp={1}>{p().username}</SubheadText>
                        </View>
                        <View class="shrink-0 flex-row items-center gap-2">
                          <CompactButton
                            label="忽略"
                            variant="neutral"
                            onPress={() => handleDismissPendingAndroidLogin(p().id)}
                          />
                          <CompactButton
                            label="保存到密码库"
                            variant="primary"
                            onPress={() => void handleSavePendingAndroidLogin(p())}
                          />
                        </View>
                      </GroupedRow>
                    )}
                  </Each>
                </GroupedList>
              </View>
            </If>

            <If
              when={filteredVaultItems().length > 0}
              else={
                <SurfaceCard class="items-center py-8 gap-2 border border-border">
                  <SectionTitle>没有匹配的条目</SectionTitle>
                  <SubheadText class="text-center">
                    调整筛选条件或点击右上角「+ 新建」添加凭据
                  </SubheadText>
                </SurfaceCard>
              }
            >
              <GroupedList>
                <Each of={filteredVaultItems()} key={(it) => it.id}>
                  {(it, idx) => {
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
                      <GroupedRow
                        last={idx() === filteredVaultItems().length - 1}
                        selected={isSelected() && isWideDesktop()}
                        onPress={() => {
                          Haptics.selection();
                          selectedItemId.set(it().id);
                        }}
                      >
                        <View class="flex-row items-center gap-3">
                          <ItemAvatar title={it().title} category={it().category} />
                          <View class="flex-1 min-w-0 gap-1">
                            <View class="flex-row items-center gap-2">
                              <Text class="flex-1 min-w-0 line-clamp-1 text-[15px] font-semibold text-foreground">
                                {it().title}
                              </Text>
                              <If when={it().totp}>
                                <BadgePill label="2FA" tone="primary" />
                              </If>
                              <If when={hasIssue()}>
                                <BadgePill label="风险" tone="warning" />
                              </If>
                            </View>
                            <SubheadText lineClamp={1}>{subtitle()}</SubheadText>
                          </View>
                          <UiIcon src={chevronRightIcon} size={16} color={token("muted-foreground")} />
                        </View>
                      </GroupedRow>
                    );
                  }}
                </Each>
              </GroupedList>
            </If>
          </Scroll>

          {/* Desktop Detail Pane */}
          <If when={isWideDesktop()}>
            <Scroll class="flex-1" contentClass="p-6">
              <If
                when={selectedItem()}
                else={
                  <View class="items-center justify-center py-20">
                    <SubheadText>从左侧选择一个条目查看详情</SubheadText>
                  </View>
                }
              >
                {(item) => renderItemDetailContent(item, false)}
              </If>
            </Scroll>
          </If>
        </View>

        {/* Mobile Item Detail Sheet */}
        <If when={!isWideDesktop()}>
          <SheetContainer
            open={Boolean(selectedItem())}
            onClose={() => selectedItemId.set(null)}
            title={selectedItem()?.title ?? "凭据详情"}
            subtitle={
              selectedItem()
                ? categoryLabel(selectedItem()!.category)
                : undefined
            }
            closeLabel="关闭"
          >
            <If when={selectedItem()}>{(item) => renderItemDetailContent(item, true)}</If>
          </SheetContainer>
        </If>

        {/* Create Vault Sheet */}
        <SheetContainer
          open={newVaultDialogOpen()}
          onClose={() => newVaultDialogOpen.set(false)}
          title="新建保险库"
          closeLabel="取消"
          scrollable={false}
          footer={
            <View class="flex-row gap-2">
              <ActionButton
                variant="secondary"
                class="flex-1"
                label="取消"
                onPress={() => newVaultDialogOpen.set(false)}
              />
              <ActionButton
                variant="primary"
                class="flex-1"
                label="创建"
                onPress={() => void handleCreateVault()}
              />
            </View>
          }
        >
          <FormField label="保险库名称">
            <AppInput
              value={newVaultName()}
              onChange={(e) => newVaultName.set(e.value)}
              placeholder="例如 家庭、公司"
            />
          </FormField>
        </SheetContainer>
      </View>
    );
  }

  function renderInboxTab() {
    return (
      <View class="flex-1 bg-background">
        <ScreenHeader
          title="收件箱"
          badge={`${filteredEmails().length}`}
          rightSlot={
            <CompactButton
              testID="sync-imap-btn"
              label={syncingImap() ? "同步中..." : "立即同步收信"}
              icon={refreshIcon}
              variant="primary"
              disabled={syncingImap()}
              onPress={() => void handleSyncImap()}
            />
          }
        >
          <If when={mailboxes().length > 0}>
            <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-2">
              <FilterPill
                label={`全部邮箱 (${emails().length})`}
                selected={selectedMailbox() === "all"}
                onPress={() => selectedMailbox.set("all")}
              />
              <Each of={mailboxes()} key={(m) => m.address}>
                {(mb) => (
                  <FilterPill
                    label={`${mb().label ? `${mb().label} · ${mb().address}` : mb().address} (${mb().count})`}
                    selected={selectedMailbox() === mb().address}
                    onPress={() => selectedMailbox.set(mb().address)}
                  />
                )}
              </Each>
            </Scroll>
          </If>
        </ScreenHeader>

        <Scroll
          class="flex-1"
          contentClass="px-4 pt-2 pb-6 gap-3"
          refreshing={syncingImap()}
          onRefresh={() => void handleSyncImap()}
        >
          <If
            when={filteredEmails().length > 0}
            else={
              <SurfaceCard class="items-center py-8 gap-2 border border-border">
                <SectionTitle>暂无验证码邮件</SectionTitle>
                <SubheadText class="text-center">
                  在「设置 → 多邮箱 IMAP 收信」中添加 Gmail / QQ / 163 / 126 / iCloud / Outlook 后点击「立即同步收信」。
                </SubheadText>
              </SurfaceCard>
            }
          >
            <Each of={filteredEmails()} key={(em) => em.id}>
              {(em) => {
                const expanded = computed(() => expandedEmailId() === em().id);
                const recipient = computed(
                  () => em().envelopeTo?.trim() || em().to?.trim() || ""
                );
                return (
                  <SurfaceCard class="border border-border">
                    <View class="flex-row items-start gap-3">
                      <ItemAvatar title={em().from || em().subject || "Mail"} category="email" />
                      <View class="flex-1 min-w-0 gap-1">
                        <Text class="text-[15px] font-semibold text-foreground">
                          {em().subject}
                        </Text>
                        <SubheadText lineClamp={1}>{em().from}</SubheadText>
                        <View class="flex-row flex-wrap items-center gap-2 pt-1">
                          <BadgePill label={em().source.toUpperCase()} tone="neutral" />
                          <If when={recipient()}>
                            <BadgePill label={`→ ${recipient()}`} tone="primary" />
                          </If>
                        </View>
                      </View>
                      <CompactButton
                        label="删除"
                        variant="neutral"
                        onPress={() => void handleDeleteEmail(em())}
                      />
                    </View>

                    <If when={em().otpCode}>
                      {(code) => (
                        <Button
                          onPress={() => void handleCopyText(code(), "邮箱验证码")}
                          class="flex-row items-center justify-between gap-3 rounded-xl bg-input px-4 py-3 active:opacity-80"
                        >
                          <View class="flex-1 min-w-0 gap-1">
                            <CaptionText>
                              提取验证码 · 置信度 {Math.round(em().confidence * 100)}%
                            </CaptionText>
                            <OtpHeroText code={code()} size="compact" />
                          </View>
                          <CompactButton
                            label="复制"
                            icon={copyIcon}
                            variant="primary"
                            onPress={() => void handleCopyText(code(), "邮箱验证码")}
                          />
                        </Button>
                      )}
                    </If>

                    <If when={em().magicLink}>
                      {(link) => (
                        <CompactButton
                          label="打开登录链接"
                          variant="tonal"
                          class="self-start"
                          onPress={() => void openUrl(link())}
                        />
                      )}
                    </If>

                    <Button
                      onPress={() =>
                        expandedEmailId.set(expanded() ? null : em().id)
                      }
                      class="gap-1 active:opacity-80"
                    >
                      <SubheadText lineClamp={expanded() ? undefined : 2}>
                        {expanded() ? em().textBody || em().snippet : em().snippet}
                      </SubheadText>
                      <CaptionText class="text-primary">
                        {expanded() ? "收起正文" : "展开详情"}
                      </CaptionText>
                    </Button>
                  </SurfaceCard>
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
        <ScreenHeader
          title="设置"
          rightSlot={
            <CompactButton
              label="锁定"
              variant="neutral"
              onPress={() => void handleLock(false)}
            />
          }
        />

        <Scroll class="flex-1" contentClass="px-4 pt-2 pb-8 gap-6">
          {/* 1. Current Account & Actions */}
          <View class="gap-2">
            <SectionHeader
              title="当前账号"
              rightSlot={
                <CompactButton
                  label="新建保险库"
                  icon={plusIcon}
                  variant="tonal"
                  onPress={() => newVaultDialogOpen.set(true)}
                />
              }
            />
            <GroupedList>
              <GroupedRow class="gap-1">
                <BodyText class="font-medium">{session()?.email}</BodyText>
                <SubheadText>服务端：{session()?.serverUrl}</SubheadText>
              </GroupedRow>
              <GroupedRow last class="gap-2">
                <View class="gap-2">
                  <View class="flex-row gap-2">
                    <ActionButton
                      variant="secondary"
                      class="flex-1"
                      disabled={syncing()}
                      onPress={() => void handleManualSync()}
                      label={syncing() ? "同步中..." : "立即全量同步"}
                    />
                    <ActionButton
                      testID="lock-vault-btn"
                      variant="primary"
                      class="flex-1"
                      onPress={() => void handleLock(false)}
                      label="锁定密码库"
                    />
                  </View>
                  <ActionButton
                    testID="logout-account-btn"
                    variant="danger"
                    onPress={() => void handleLock(true)}
                    label="退出登录（切换账号）"
                  />
                </View>
              </GroupedRow>
            </GroupedList>
          </View>

          {/* 2. Android System Autofill Section */}
          <If when={platform.os === "android"}>
            <View class="gap-2">
              <SectionHeader title="系统自动填充" />
              <GroupedList>
                <GroupedRow class="gap-1">
                  <View class="flex-row items-center justify-between gap-2">
                    <BodyText class="flex-1 min-w-0 font-semibold">Android 系统自动填充</BodyText>
                    <BadgePill
                      label={
                        autofillStatus().enabled
                          ? "已开启"
                          : autofillStatus().supported
                            ? "未启用"
                            : "系统级填充服务"
                      }
                      tone={
                        autofillStatus().enabled
                          ? "success"
                          : autofillStatus().supported
                            ? "warning"
                            : "neutral"
                      }
                    />
                  </View>
                  <SubheadText>
                    在 Chrome 与其他 Android App 登录框自动填充账号、密码、实时 2FA 与邮箱验证码
                  </SubheadText>
                </GroupedRow>
                <GroupedRow last class="flex-row flex-wrap items-center gap-2">
                  <CompactButton
                    testID="enable-autofill-btn"
                    label="开启系统自动填充"
                    variant={autofillStatus().enabled ? "neutral" : "primary"}
                    onPress={() => void handleEnableAndroidAutofill()}
                  />
                  <CompactButton
                    label="刷新状态"
                    icon={refreshIcon}
                    variant="neutral"
                    onPress={() => void handleRefreshAutofillStatus()}
                  />
                </GroupedRow>
              </GroupedList>
            </View>
          </If>

          {/* 2. Multi-Account IMAP Section */}
          <View class="gap-2">
            <SectionHeader
              title="多邮箱 IMAP 收信"
              rightSlot={
                <CompactButton
                  testID="add-imap-btn"
                  label="+ 添加邮箱账号"
                  variant="primary"
                  onPress={() => {
                    editingImapAccount.set(null);
                    imapEditorOpen.set(true);
                  }}
                />
              }
            />
            <GroupedList>
              <If
                when={imapAccounts().length > 0}
                else={
                  <GroupedRow last class="items-center py-4">
                    <SubheadText class="text-center">
                      尚未配置 IMAP 收信邮箱，支持 Gmail / QQ / 163 / 126 / iCloud / Outlook。
                    </SubheadText>
                  </GroupedRow>
                }
              >
                <Each of={imapAccounts()} key={(a) => a.id}>
                  {(acc, idx) => {
                    const statusInfo = computed(() => getImapStatusInfo(acc()));
                    return (
                      <GroupedRow
                        last={idx() === imapAccounts().length - 1}
                        class="gap-3"
                      >
                        <View class="flex-row items-center justify-between gap-2">
                          <View class="flex-1 min-w-0 gap-1">
                            <View class="flex-row flex-wrap items-center gap-2">
                              <BodyText class="font-semibold">
                                {acc().label || acc().username}
                              </BodyText>
                              <BadgePill
                                label={statusInfo().label}
                                tone={statusInfo().tone}
                              />
                            </View>
                            <SubheadText>
                              {acc().username} · {acc().host}:{acc().port}
                            </SubheadText>
                          </View>
                          <Switch
                            checked={acc().enabled}
                            onChange={() => void handleToggleImapEnabled(acc())}
                            class="shrink-0"
                            trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
                            thumbClass="w-5 h-5 rounded-full bg-primary-foreground checked:translate-x-4"
                          />
                        </View>

                        <If when={acc().lastError}>
                          {(errText) => (
                            <Text class="text-[13px] font-medium text-destructive">
                              异常：{errText()}
                            </Text>
                          )}
                        </If>

                        <View class="flex-row flex-wrap gap-2">
                          <CompactButton
                            label="立即同步"
                            icon={refreshIcon}
                            variant="neutral"
                            onPress={() => void handleSyncImap(acc().id)}
                          />
                          <CompactButton
                            label="编辑 / 改授权码"
                            variant="neutral"
                            onPress={() => {
                              editingImapAccount.set(acc());
                              imapEditorOpen.set(true);
                            }}
                          />
                          <CompactButton
                            label="删除"
                            variant="danger"
                            onPress={() => void handleDeleteImapAccount(acc())}
                          />
                        </View>
                      </GroupedRow>
                    );
                  }}
                </Each>
              </If>
            </GroupedList>
          </View>

          {/* 3. Email Filter Section */}
          <View class="gap-2">
            <SectionHeader title="邮件过滤策略" />
            <GroupedList>
              <GroupedRow last class="flex-row items-center justify-between gap-3">
                <View class="flex-1 min-w-0 gap-1">
                  <BodyText class="font-medium">仅保留含验证码邮件</BodyText>
                  <SubheadText>
                    开启后仅入库包含 OTP 或登录链接的邮件 (otpOnly)
                  </SubheadText>
                </View>
                <Switch
                  testID="otp-only-switch"
                  checked={emailFilter().otpOnly}
                  onChange={(e) => void handleToggleOtpOnly(e.checked)}
                  class="shrink-0"
                  trackClass="w-10 h-6 rounded-full bg-muted checked:bg-primary p-0.5 justify-center"
                  thumbClass="w-5 h-5 rounded-full bg-primary-foreground checked:translate-x-4"
                />
              </GroupedRow>
            </GroupedList>
          </View>

          {/* 4. Security Audit Summary */}
          <View class="gap-2">
            <SectionHeader
              title="安全审计总览"
              rightSlot={
                <BadgePill label={`评分 ${auditSummary().score} / 100`} tone="primary" />
              }
            />
            <GroupedList>
              <GroupedRow last class="p-0">
                <View class="flex-row">
                  <View class="flex-1 items-center gap-1 border-r border-border px-2 py-3">
                    <Text class="font-mono text-[20px] font-bold text-destructive">
                      {auditSummary().weakItems.length}
                    </Text>
                    <CaptionText>弱密码</CaptionText>
                  </View>
                  <View class="flex-1 items-center gap-1 border-r border-border px-2 py-3">
                    <Text class="font-mono text-[20px] font-bold text-chart-3">
                      {auditSummary().reusedItems.length}
                    </Text>
                    <CaptionText>重复密码</CaptionText>
                  </View>
                  <View class="flex-1 items-center gap-1 px-2 py-3">
                    <Text class="font-mono text-[20px] font-bold text-foreground">
                      {auditSummary().missingTotpItems.length}
                    </Text>
                    <CaptionText>未开 2FA</CaptionText>
                  </View>
                </View>
              </GroupedRow>
            </GroupedList>
          </View>

          {/* 6. Appearance */}
          <View class="gap-2">
            <SectionHeader title="外观主题" />
            <GroupedList>
              <GroupedRow last class="p-3">
                <SegmentedControl
                  options={THEME_OPTIONS}
                  value={themePref()}
                  onChange={(pref) => handleChangeTheme(pref)}
                />
              </GroupedRow>
            </GroupedList>
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

    return (
      <If
        when={isWideDesktop()}
        else={
          <View class="flex-1 bg-background pt-[env(safe-area-inset-top)]">
            <View class="flex-1">{renderMainContent()}</View>
            <If
              when={mobileApisAvailable}
              else={
                <Tabs
                  testID="mobile-tab-bar"
                  class="flex-row bg-card border-t border-border px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)]"
                >
                  <Each of={MOBILE_TABS} key={(t) => t.key}>
                    {(t) => {
                      const active = () => activeTab() === t().key;
                      return (
                        <Tab
                          selected={active()}
                          onPress={() => {
                            Haptics.selection();
                            activeTab.set(t().key);
                          }}
                          class={`flex-1 h-11 items-center justify-center rounded-xl ${
                            active() ? "bg-primary/12" : ""
                          }`}
                        >
                          <Text
                            class={`text-[13px] ${
                              active()
                                ? "font-semibold text-primary"
                                : "font-medium text-muted-foreground"
                            }`}
                          >
                            {t().label}
                          </Text>
                        </Tab>
                      );
                    }}
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
                    icon: platform.select({ ios: "qrcode.viewfinder", android: "tab_totp" }),
                  },
                  {
                    title: "密码库",
                    icon: platform.select({ ios: "key.fill", android: "tab_vault" }),
                  },
                  {
                    title: "收件箱",
                    icon: platform.select({ ios: "envelope.badge", android: "tab_inbox" }),
                  },
                  {
                    title: "设置",
                    icon: platform.select({ ios: "gearshape.fill", android: "tab_settings" }),
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
        }
      >
        <View class="flex-1 flex-row bg-background">
          {/* Desktop Left Rail */}
          <View class="w-56 justify-between border-r border-border bg-card p-3">
            <View class="gap-4">
              <View class="flex-row items-center gap-3 px-2 py-1">
                <AppBrandLogo src={appIcon} size={36} class="h-9 w-9 shrink-0 rounded-lg" />
                <View class="flex-1 min-w-0 gap-1">
                  <BodyText class="font-bold">NonePwd</BodyText>
                  <CaptionText numberOfLines={1}>{session()?.email ?? ""}</CaptionText>
                </View>
              </View>

              <View class="gap-1">
                <Each of={MOBILE_TABS} key={(n) => n.key}>
                  {(nav) => {
                    const active = () => activeTab() === nav().key;
                    return (
                      <Button
                        onPress={() => activeTab.set(nav().key)}
                        class={`h-11 flex-row items-center rounded-xl px-3 ${
                          active() ? "bg-primary" : "bg-transparent hover:bg-muted"
                        }`}
                      >
                        <Text
                          class={`text-[15px] ${
                            active()
                              ? "font-semibold text-primary-foreground"
                              : "font-medium text-foreground"
                          }`}
                        >
                          {nav().label}
                        </Text>
                      </Button>
                    );
                  }}
                </Each>
              </View>
            </View>

            <View class="gap-2">
              <CompactButton
                label={syncing() ? "同步中..." : "立即同步"}
                icon={refreshIcon}
                variant="neutral"
                disabled={syncing()}
                onPress={() => void handleManualSync()}
              />
              <CompactButton
                label="锁定"
                variant="danger"
                onPress={() => void handleLock(false)}
              />
            </View>
          </View>

          <View class="flex-1">{renderMainContent()}</View>
        </View>
      </If>
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
              class={`rounded-full px-4 py-2 ${
                t().kind === "error"
                  ? "bg-destructive"
                  : "bg-card border border-border"
              }`}
            >
              <Text
                class={`text-[13px] font-semibold ${
                  t().kind === "error" ? "text-primary-foreground" : "text-foreground"
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
