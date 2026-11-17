import type { DecryptedEmailPayload, VaultItemPayload } from '@nonepwd/core';
import {
  detectInputTarget,
  isCardKind,
  isIdentityKind,
  type DetectedTarget,
  type FormFieldElement,
} from './detector.js';
import {
  fillCardCvv,
  fillCardForm,
  fillIdentityForm,
  fillLoginCredentials,
  fillOtpTarget,
  formatCardDisplay,
  formatCardExpiry,
} from './filler.js';
import { loadThemePreference, normalizeThemePreference, THEME_STORAGE_KEY } from './theme.js';
import type { ExtendedVaultItem } from './types.js';

interface TabLoginMatch {
  item: VaultItemPayload;
  totpCode: string | null;
  totpRemaining: number;
}

interface TabQueryResponse {
  ok: boolean;
  unlocked: boolean;
  aliasDomain?: string;
  logins: TabLoginMatch[];
  cards: ExtendedVaultItem[];
  identities: ExtendedVaultItem[];
  pendingItem: TabLoginMatch | null;
  latestOtpEmail: (DecryptedEmailPayload & { id: string }) | null;
}

export const POPOVER_CSS = `
  :host {
    all: initial;
    --np-bg: #ffffff;
    --np-surface: #fafafa;
    --np-fg: #0a0a0a;
    --np-muted: #737373;
    --np-border: #e5e5e5;
    --np-hover: #f5f5f5;
    --np-active-border: #d4d4d4;
    --np-primary: #171717;
    --np-primary-fg: #fafafa;
    --np-pill-bg: #f5f5f5;
    --np-pill-fg: #171717;
    --np-pill-border: #e5e5e5;
    --np-dot-unlocked: #171717;
    --np-dot-locked: #a3a3a3;
    --np-shadow: 0 10px 30px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  :host([data-theme="dark"]) {
    --np-bg: #141414;
    --np-surface: #1b1b1b;
    --np-fg: #fafafa;
    --np-muted: #a3a3a3;
    --np-border: rgba(255, 255, 255, 0.12);
    --np-hover: #262626;
    --np-active-border: rgba(255, 255, 255, 0.22);
    --np-primary: #ebebeb;
    --np-primary-fg: #171717;
    --np-pill-bg: #242424;
    --np-pill-fg: #fafafa;
    --np-pill-border: rgba(255, 255, 255, 0.14);
    --np-dot-unlocked: #fafafa;
    --np-dot-locked: #737373;
    --np-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  }
  @media (prefers-color-scheme: dark) {
    :host([data-theme="system"]) {
      --np-bg: #141414;
      --np-surface: #1b1b1b;
      --np-fg: #fafafa;
      --np-muted: #a3a3a3;
      --np-border: rgba(255, 255, 255, 0.12);
      --np-hover: #262626;
      --np-active-border: rgba(255, 255, 255, 0.22);
      --np-primary: #ebebeb;
      --np-primary-fg: #171717;
      --np-pill-bg: #242424;
      --np-pill-fg: #fafafa;
      --np-pill-border: rgba(255, 255, 255, 0.14);
      --np-dot-unlocked: #fafafa;
      --np-dot-locked: #737373;
      --np-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
    }
  }
  * {
    box-sizing: border-box;
    font-family: "Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .np-badge {
    position: fixed;
    z-index: 2147483646;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    border: 1px solid var(--np-border);
    background: var(--np-primary);
    color: var(--np-primary-fg);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    transition: transform 0.12s ease, opacity 0.12s ease;
    padding: 0;
  }
  .np-badge:hover { transform: scale(1.06); }
  .np-popover {
    position: fixed;
    z-index: 2147483647;
    width: 284px;
    max-width: calc(100vw - 16px);
    background: var(--np-bg);
    color: var(--np-fg);
    border: 1px solid var(--np-border);
    border-radius: 10px;
    box-shadow: var(--np-shadow);
    overflow: hidden;
    animation: np-fade 0.1s ease-out;
  }
  @keyframes np-fade {
    from { opacity: 0; transform: translateY(-3px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .np-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    background: var(--np-surface);
    border-bottom: 1px solid var(--np-border);
    font-size: 11px;
    font-weight: 500;
    color: var(--np-muted);
  }
  .np-brand {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--np-fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .np-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--np-dot-unlocked); }
  .np-dot.locked { background: var(--np-dot-locked); }
  .np-list { padding: 4px; max-height: 248px; overflow-y: auto; }
  .np-item {
    width: 100%;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 7px 8px;
    border-radius: 7px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .np-item:hover, .np-item.active {
    background: var(--np-hover);
    border-color: var(--np-active-border);
  }
  .np-item-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--np-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .np-item-sub {
    font-size: 11px;
    color: var(--np-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
  }
  .np-pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--np-pill-bg);
    color: var(--np-pill-fg);
    border: 1px solid var(--np-pill-border);
    flex-shrink: 0;
  }
  .np-pill.primary {
    background: var(--np-primary);
    color: var(--np-primary-fg);
    border-color: var(--np-primary);
  }
  .np-empty {
    padding: 12px 10px;
    font-size: 11px;
    color: var(--np-muted);
    line-height: 1.5;
  }
  .np-wait {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    font-size: 11px;
    color: var(--np-muted);
    background: var(--np-surface);
    border-top: 1px solid var(--np-border);
  }
`;

let hostEl: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let badgeBtn: HTMLButtonElement | null = null;
let popoverEl: HTMLDivElement | null = null;

let currentTarget: DetectedTarget | null = null;
let lastQueryData: TabQueryResponse | null = null;
let liveEmailOverride: (DecryptedEmailPayload & { id?: string }) | null = null;
let activeIndex = 0;
let optionHandlers: Array<{ run: () => void; clickOnly?: boolean }> = [];
let currentThemePref: 'light' | 'dark' | 'system' = 'light';

function syncHostTheme() {
  if (hostEl) {
    hostEl.setAttribute('data-theme', currentThemePref);
  }
}

function ensureShadowUi(): ShadowRoot {
  if (shadowRoot && hostEl?.isConnected) return shadowRoot;
  hostEl = document.createElement('div');
  hostEl.setAttribute('data-nonepwd-overlay', 'true');
  syncHostTheme();
  shadowRoot = hostEl.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = POPOVER_CSS;
  shadowRoot.appendChild(style);

  badgeBtn = document.createElement('button');
  badgeBtn.type = 'button';
  badgeBtn.className = 'np-badge';
  badgeBtn.title = 'nonepwd 自动填充';
  badgeBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
  badgeBtn.style.display = 'none';
  badgeBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (popoverEl && popoverEl.style.display !== 'none') {
      hidePopover();
    } else if (currentTarget) {
      void openPopoverForTarget(currentTarget);
    }
  });
  shadowRoot.appendChild(badgeBtn);

  popoverEl = document.createElement('div');
  popoverEl.className = 'np-popover';
  popoverEl.style.display = 'none';
  shadowRoot.appendChild(popoverEl);

  document.documentElement.appendChild(hostEl);
  return shadowRoot;
}

function positionOverlays(anchor: FormFieldElement) {
  const rect = anchor.getBoundingClientRect();
  if (badgeBtn) {
    const rightOffset = anchor.tagName === 'SELECT' ? 36 : 25;
    badgeBtn.style.display = 'flex';
    badgeBtn.style.top = `${Math.max(4, rect.top + (rect.height - 20) / 2)}px`;
    badgeBtn.style.left = `${Math.max(4, rect.right - rightOffset)}px`;
  }
  if (popoverEl && popoverEl.style.display !== 'none') {
    const popHeight = popoverEl.offsetHeight || 180;
    const fitsBelow = rect.bottom + 6 + popHeight <= window.innerHeight - 8;
    const top = fitsBelow
      ? Math.max(8, rect.bottom + 6)
      : Math.max(8, rect.top - popHeight - 6);
    const left = Math.max(8, Math.min(window.innerWidth - 292, rect.left));
    popoverEl.style.top = `${top}px`;
    popoverEl.style.left = `${left}px`;
  }
}

function hidePopover() {
  if (popoverEl) popoverEl.style.display = 'none';
  optionHandlers = [];
  activeIndex = 0;
}

function hideAllOverlays() {
  hidePopover();
  if (badgeBtn) badgeBtn.style.display = 'none';
  currentTarget = null;
}

async function queryBackground(): Promise<TabQueryResponse> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'NONEPWD_QUERY_TAB',
      url: window.location.href,
    })) as TabQueryResponse;
    return res;
  } catch {
    return {
      ok: false,
      unlocked: false,
      logins: [],
      cards: [],
      identities: [],
      pendingItem: null,
      latestOtpEmail: null,
    };
  }
}

function renderPopover() {
  if (!popoverEl || !currentTarget || !lastQueryData) return;

  const data = lastQueryData;
  const target = currentTarget;
  optionHandlers = [];
  activeIndex = 0;

  popoverEl.innerHTML = '';

  const headerHint = !data.unlocked
    ? '已锁定'
    : target.kind === 'cc-csc'
      ? '需点击填入安全码'
      : '↑↓ · Enter 填充';

  const header = document.createElement('div');
  header.className = 'np-header';
  header.innerHTML = `
    <span class="np-brand">
      <span class="np-dot ${data.unlocked ? '' : 'locked'}"></span>
      nonepwd
    </span>
    <span>${headerHint}</span>
  `;
  popoverEl.appendChild(header);

  if (!data.unlocked) {
    const empty = document.createElement('div');
    empty.className = 'np-empty';
    empty.textContent = '密码库已锁定，请点击右上角 nonepwd 图标输入主密码解锁。';
    popoverEl.appendChild(empty);
    popoverEl.style.display = 'block';
    positionOverlays(target.anchor);
    return;
  }

  const list = document.createElement('div');
  list.className = 'np-list';

  const addOption = (
    title: string,
    subtitle: string,
    pillHtml: string,
    onSelect: () => void,
    clickOnly = false
  ) => {
    const idx = optionHandlers.length;
    optionHandlers.push({ run: onSelect, clickOnly });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `np-item ${idx === activeIndex ? 'active' : ''}`;
    btn.innerHTML = `
      <div style="min-width:0;flex:1">
        <div class="np-item-title"></div>
        <div class="np-item-sub"></div>
      </div>
      ${pillHtml}
    `;
    btn.querySelector('.np-item-title')!.textContent = title;
    btn.querySelector('.np-item-sub')!.textContent = subtitle;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect();
    });
    list.appendChild(btn);
  };

  if (target.kind === 'otp-single' || target.kind === 'otp-split') {
    const emailOtp = liveEmailOverride ?? data.latestOtpEmail;
    if (emailOtp?.otpCode) {
      addOption(
        `邮箱验证码`,
        `来自 ${emailOtp.senderDomain || emailOtp.from}`,
        `<span class="np-pill primary">${emailOtp.otpCode}</span>`,
        () => {
          fillOtpTarget(target, emailOtp.otpCode!);
          hidePopover();
        }
      );
    }

    const candidates = data.pendingItem
      ? [data.pendingItem, ...data.logins.filter((l) => l.item.id !== data.pendingItem!.item.id)]
      : data.logins;

    for (const entry of candidates) {
      if (!entry.totpCode) continue;
      addOption(
        `${entry.item.title} · 2FA`,
        `${entry.item.username || 'TOTP'} · ${entry.totpRemaining}s`,
        `<span class="np-pill">${entry.totpCode}</span>`,
        () => {
          fillOtpTarget(target, entry.totpCode!);
          hidePopover();
        }
      );
    }

    if (optionHandlers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = '暂无匹配的 2FA 或邮件验证码。';
      list.appendChild(empty);
    }

    popoverEl.appendChild(list);

    if (!emailOtp?.otpCode) {
      const waitBar = document.createElement('div');
      waitBar.className = 'np-wait';
      waitBar.textContent = '正在监听邮箱验证码推送...';
      popoverEl.appendChild(waitBar);
    }
  } else if (target.kind === 'cc-csc') {
    const cardsWithCvv = (data.cards ?? []).filter((c) => Boolean(c.card?.cvv));
    for (const item of cardsWithCvv) {
      const { label } = formatCardDisplay(item.card, item.title);
      addOption(
        label,
        `${item.title} · 点击填入安全码`,
        '<span class="np-pill">CVV</span>',
        () => {
          if (item.card?.cvv) {
            fillCardCvv(target.anchor, item.card.cvv);
          }
          hidePopover();
        },
        true
      );
    }

    if (optionHandlers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = '暂无包含安全码 (CVV) 的卡片条目。';
      list.appendChild(empty);
    }
    popoverEl.appendChild(list);
  } else if (isCardKind(target.kind)) {
    for (const item of data.cards ?? []) {
      if (!item.card) continue;
      const { label } = formatCardDisplay(item.card, item.title);
      const exp = formatCardExpiry(item.card.expMonth, item.card.expYear);
      const subParts = [item.title, item.card.cardholderName, exp].filter(Boolean);
      addOption(
        label,
        subParts.join(' · ') || '填充卡片信息（不含安全码）',
        '<span class="np-pill">卡片</span>',
        () => {
          fillCardForm(target.anchor, item.card!, { includeCvv: false });
          hidePopover();
        }
      );
    }

    if (optionHandlers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = '密码库中暂无信用卡条目。';
      list.appendChild(empty);
    }
    popoverEl.appendChild(list);
  } else if (isIdentityKind(target.kind)) {
    for (const item of data.identities ?? []) {
      if (!item.identity) continue;
      const id = item.identity;
      const title =
        id.fullName ||
        [id.firstName, id.lastName].filter(Boolean).join(' ') ||
        item.title;
      const sub = [id.address1, id.city, id.phone || id.email].filter(Boolean).join(' · ') || item.title;
      addOption(
        title,
        sub,
        '<span class="np-pill">地址</span>',
        () => {
          fillIdentityForm(target.anchor, id);
          hidePopover();
        }
      );
    }

    if (optionHandlers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = '密码库中暂无地址 / 身份条目。';
      list.appendChild(empty);
    }
    popoverEl.appendChild(list);
  } else if (target.kind === 'new-password') {
    const anchorInput = target.anchor;
    addOption(
      '生成 20 位强密码并保存',
      '自动填入并加密同步至 Vault',
      '<span class="np-pill primary">生成</span>',
      () => {
        void (async () => {
          const res = (await chrome.runtime.sendMessage({
            type: 'NONEPWD_CREATE_SIGNUP_LOGIN',
            url: window.location.href,
            withAlias: false,
          })) as { ok: boolean; item?: VaultItemPayload };
          if (res.ok && res.item) {
            fillLoginCredentials(anchorInput, undefined, res.item.password);
            hidePopover();
          }
        })();
      }
    );

    if (data.aliasDomain) {
      addOption(
        `别名邮箱 (@${data.aliasDomain}) + 密码`,
        '生成独立邮箱别名并保存条目',
        '<span class="np-pill">别名</span>',
        () => {
          void (async () => {
            const res = (await chrome.runtime.sendMessage({
              type: 'NONEPWD_CREATE_SIGNUP_LOGIN',
              url: window.location.href,
              withAlias: true,
            })) as { ok: boolean; item?: VaultItemPayload };
            if (res.ok && res.item) {
              fillLoginCredentials(anchorInput, res.item.username, res.item.password);
              hidePopover();
            }
          })();
        }
      );
    }

    popoverEl.appendChild(list);
  } else if (target.anchor instanceof HTMLInputElement) {
    const anchorInput = target.anchor;
    for (const entry of data.logins) {
      addOption(
        entry.item.title,
        entry.item.username || entry.item.emailAlias || '点击填充账号密码',
        entry.totpCode ? '<span class="np-pill">2FA</span>' : '',
        () => {
          fillLoginCredentials(anchorInput, entry.item.username, entry.item.password);
          void chrome.runtime.sendMessage({
            type: 'NONEPWD_RECORD_FILL',
            itemId: entry.item.id,
            title: entry.item.title,
            url: window.location.href,
            emailAlias: entry.item.emailAlias,
          });
          hidePopover();
        }
      );
    }

    if (optionHandlers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = `当前站点 (${window.location.hostname}) 暂无匹配账号。`;
      list.appendChild(empty);
    }
    popoverEl.appendChild(list);
  }

  popoverEl.style.display = 'block';
  positionOverlays(target.anchor);
}

async function openPopoverForTarget(target: DetectedTarget) {
  currentThemePref = await loadThemePreference();
  ensureShadowUi();
  syncHostTheme();
  currentTarget = target;
  lastQueryData = await queryBackground();
  renderPopover();
}

function updateActiveRowHighlight() {
  if (!popoverEl) return;
  const rows = Array.from(popoverEl.querySelectorAll('.np-item'));
  rows.forEach((r, idx) => {
    r.classList.toggle('active', idx === activeIndex);
  });
}

function findFallbackField(
  predicate: (kind: ReturnType<typeof detectInputTarget>) => boolean
): FormFieldElement | null {
  const fields = Array.from(document.querySelectorAll('input, select, textarea')) as FormFieldElement[];
  for (const field of fields) {
    const t = detectInputTarget(field);
    if (predicate(t)) return field;
  }
  return null;
}

if (typeof document !== 'undefined') {
  void loadThemePreference().then((pref) => {
    currentThemePref = pref;
    syncHostTheme();
  });

  document.addEventListener(
    'focusin',
    (evt) => {
      const el = evt.target;
      if (
        !(
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        )
      ) {
        return;
      }
      const detected = detectInputTarget(el);
      if (!detected) {
        hideAllOverlays();
        return;
      }
      void openPopoverForTarget(detected);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (evt) => {
      if (!popoverEl || popoverEl.style.display === 'none' || optionHandlers.length === 0) {
        return;
      }
      if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        activeIndex = (activeIndex + 1) % optionHandlers.length;
        updateActiveRowHighlight();
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        activeIndex = (activeIndex - 1 + optionHandlers.length) % optionHandlers.length;
        updateActiveRowHighlight();
      } else if (evt.key === 'Enter') {
        const handler = optionHandlers[activeIndex];
        if (!handler || handler.clickOnly) {
          // Never auto-fill CVV without explicit click
          return;
        }
        evt.preventDefault();
        evt.stopPropagation();
        handler.run();
      } else if (evt.key === 'Escape') {
        hidePopover();
      }
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (evt) => {
      if (evt.target === hostEl) return;
      if (
        (evt.target instanceof HTMLInputElement ||
          evt.target instanceof HTMLSelectElement ||
          evt.target instanceof HTMLTextAreaElement) &&
        currentTarget?.anchor === evt.target
      ) {
        return;
      }
      hidePopover();
    },
    true
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'scroll',
    () => {
      if (currentTarget) positionOverlays(currentTarget.anchor);
    },
    true
  );

  window.addEventListener('resize', () => {
    if (currentTarget) positionOverlays(currentTarget.anchor);
  });
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[THEME_STORAGE_KEY]) {
      currentThemePref = normalizeThemePreference(changes[THEME_STORAGE_KEY].newValue);
      syncHostTheme();
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'NONEPWD_LIVE_OTP' && msg.email) {
      liveEmailOverride = msg.email as DecryptedEmailPayload & { id?: string };
      if (currentTarget && (currentTarget.kind === 'otp-single' || currentTarget.kind === 'otp-split')) {
        void openPopoverForTarget(currentTarget);
      }
    } else if (msg?.type === 'NONEPWD_FILL_FROM_POPUP' && msg.item) {
      const item = msg.item as VaultItemPayload;
      const anchor =
        (currentTarget && currentTarget.anchor instanceof HTMLInputElement
          ? currentTarget.anchor
          : null) ??
        (document.querySelector(
          'input[type="password"], input[type="email"], input[type="text"]'
        ) as HTMLInputElement | null);
      if (anchor) {
        fillLoginCredentials(anchor, item.username, item.password);
        void chrome.runtime.sendMessage({
          type: 'NONEPWD_RECORD_FILL',
          itemId: item.id,
          title: item.title,
          url: window.location.href,
          emailAlias: item.emailAlias,
        });
      }
    } else if (msg?.type === 'NONEPWD_FILL_OTP_FROM_POPUP' && msg.code) {
      const anchor =
        (currentTarget && currentTarget.anchor instanceof HTMLInputElement
          ? currentTarget.anchor
          : null) ??
        (document.querySelector(
          'input[maxlength="1"], input[autocomplete="one-time-code"]'
        ) as HTMLInputElement | null);
      if (anchor) {
        const target = detectInputTarget(anchor) ?? { kind: 'otp-single', anchor };
        fillOtpTarget(target, String(msg.code));
      }
    } else if (msg?.type === 'NONEPWD_FILL_CARD_FROM_POPUP' && msg.item) {
      const item = msg.item as ExtendedVaultItem;
      if (!item.card) return;
      const anchor =
        (currentTarget && isCardKind(currentTarget.kind) ? currentTarget.anchor : null) ??
        findFallbackField((t) => Boolean(t && isCardKind(t.kind) && t.kind !== 'cc-csc'));
      if (anchor) {
        fillCardForm(anchor, item.card, { includeCvv: false });
      }
    } else if (msg?.type === 'NONEPWD_FILL_CVV_FROM_POPUP' && msg.item) {
      const item = msg.item as ExtendedVaultItem;
      if (!item.card?.cvv) return;
      const anchor =
        (currentTarget?.kind === 'cc-csc' ? currentTarget.anchor : null) ??
        findFallbackField((t) => Boolean(t && t.kind === 'cc-csc'));
      if (anchor) {
        fillCardCvv(anchor, item.card.cvv);
      }
    } else if (msg?.type === 'NONEPWD_FILL_IDENTITY_FROM_POPUP' && msg.item) {
      const item = msg.item as ExtendedVaultItem;
      if (!item.identity) return;
      const anchor =
        (currentTarget && isIdentityKind(currentTarget.kind) ? currentTarget.anchor : null) ??
        findFallbackField((t) => Boolean(t && isIdentityKind(t.kind)));
      if (anchor) {
        fillIdentityForm(anchor, item.identity);
      }
    }
  });
}
