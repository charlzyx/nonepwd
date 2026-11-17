import type { DecryptedEmailPayload, VaultItemPayload } from '@nonepwd/core';
import { detectInputTarget, type DetectedTarget } from './detector.js';
import { fillLoginCredentials, fillOtpTarget } from './filler.js';

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
  pendingItem: TabLoginMatch | null;
  latestOtpEmail: (DecryptedEmailPayload & { id: string }) | null;
}

const POPOVER_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
  .np-badge {
    position: fixed;
    z-index: 2147483646;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: 1px solid rgba(99, 102, 241, 0.45);
    background: linear-gradient(135deg, #4f46e5, #6366f1);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.45);
    transition: transform 0.12s ease, filter 0.12s ease;
    padding: 0;
  }
  .np-badge:hover { transform: scale(1.06); filter: brightness(1.1); }
  .np-popover {
    position: fixed;
    z-index: 2147483647;
    width: 316px;
    max-width: calc(100vw - 24px);
    background: #121622;
    color: #f1f5f9;
    border: 1px solid #293247;
    border-radius: 14px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.65);
    overflow: hidden;
    animation: np-fade 0.12s ease-out;
  }
  @keyframes np-fade {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .np-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    background: #0d111a;
    border-bottom: 1px solid #1e2638;
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
  }
  .np-brand { display: flex; align-items: center; gap: 6px; color: #c7d2fe; }
  .np-dot { width: 7px; height: 7px; border-radius: 999px; background: #10b981; }
  .np-dot.locked { background: #f59e0b; }
  .np-list { padding: 6px; max-height: 280px; overflow-y: auto; }
  .np-item {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 9px 10px;
    border-radius: 9px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .np-item:hover, .np-item.active {
    background: rgba(99, 102, 241, 0.22);
    outline: 1px solid rgba(99, 102, 241, 0.45);
  }
  .np-item-title { font-size: 13px; font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np-item-sub { font-size: 11px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .np-pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 7px;
    background: rgba(16, 185, 129, 0.16);
    color: #6ee7b7;
    border: 1px solid rgba(16, 185, 129, 0.35);
    shrink: 0;
  }
  .np-pill.totp {
    background: rgba(99, 102, 241, 0.18);
    color: #c7d2fe;
    border-color: rgba(99, 102, 241, 0.4);
  }
  .np-empty {
    padding: 14px 12px;
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.5;
  }
  .np-wait {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    font-size: 11px;
    color: #a5b4fc;
    background: rgba(99, 102, 241, 0.08);
    border-top: 1px solid #1e2638;
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
let optionHandlers: Array<() => void> = [];

function ensureShadowUi(): ShadowRoot {
  if (shadowRoot && hostEl?.isConnected) return shadowRoot;
  hostEl = document.createElement('div');
  hostEl.setAttribute('data-nonepwd-overlay', 'true');
  shadowRoot = hostEl.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = POPOVER_CSS;
  shadowRoot.appendChild(style);

  badgeBtn = document.createElement('button');
  badgeBtn.type = 'button';
  badgeBtn.className = 'np-badge';
  badgeBtn.title = 'nonepwd 自动填充';
  badgeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
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

function positionOverlays(anchor: HTMLInputElement) {
  const rect = anchor.getBoundingClientRect();
  if (badgeBtn) {
    badgeBtn.style.display = 'flex';
    badgeBtn.style.top = `${Math.max(4, rect.top + (rect.height - 22) / 2)}px`;
    badgeBtn.style.left = `${Math.max(4, rect.right - 28)}px`;
  }
  if (popoverEl && popoverEl.style.display !== 'none') {
    const top = Math.min(window.innerHeight - 60, rect.bottom + 6);
    const left = Math.max(8, Math.min(window.innerWidth - 324, rect.left));
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
    return { ok: false, unlocked: false, logins: [], pendingItem: null, latestOtpEmail: null };
  }
}

function renderPopover() {
  if (!popoverEl || !currentTarget || !lastQueryData) return;

  const data = lastQueryData;
  const target = currentTarget;
  optionHandlers = [];
  activeIndex = 0;

  popoverEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'np-header';
  header.innerHTML = `
    <span class="np-brand">
      <span class="np-dot ${data.unlocked ? '' : 'locked'}"></span>
      nonepwd
    </span>
    <span>${data.unlocked ? '↑↓ 选择 · Enter 填充' : '已锁定'}</span>
  `;
  popoverEl.appendChild(header);

  if (!data.unlocked) {
    const empty = document.createElement('div');
    empty.className = 'np-empty';
    empty.textContent = 'nonepwd 密码库已锁定。请点击浏览器右上角 nonepwd 插件图标输入主密码解锁。';
    popoverEl.appendChild(empty);
    popoverEl.style.display = 'block';
    positionOverlays(target.anchor);
    return;
  }

  const list = document.createElement('div');
  list.className = 'np-list';

  const addOption = (title: string, subtitle: string, pillHtml: string, onSelect: () => void) => {
    const idx = optionHandlers.length;
    optionHandlers.push(onSelect);
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
        `邮箱验证码：${emailOtp.otpCode}`,
        `来自 ${emailOtp.senderDomain || emailOtp.from}`,
        `<span class="np-pill">${emailOtp.otpCode}</span>`,
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
        `${entry.item.title} · 2FA 动态码`,
        `${entry.item.username || 'TOTP'} · 剩余 ${entry.totpRemaining}s`,
        `<span class="np-pill totp">${entry.totpCode}</span>`,
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
      waitBar.textContent = '正在实时监听邮箱验证码推送（收到后自动出现）...';
      popoverEl.appendChild(waitBar);
    }
  } else if (target.kind === 'new-password') {
    addOption(
      '生成 20 位强密码并保存登录条目',
      '自动填入新密码并加密同步至 Vault',
      '<span class="np-pill totp">生成密码</span>',
      () => {
        void (async () => {
          const res = (await chrome.runtime.sendMessage({
            type: 'NONEPWD_CREATE_SIGNUP_LOGIN',
            url: window.location.href,
            withAlias: false,
          })) as { ok: boolean; item?: VaultItemPayload };
          if (res.ok && res.item) {
            fillLoginCredentials(target.anchor, undefined, res.item.password);
            hidePopover();
          }
        })();
      }
    );

    if (data.aliasDomain) {
      addOption(
        `生成别名邮箱 (@${data.aliasDomain}) + 强密码`,
        '防垃圾邮件追踪，自动保存为新账号',
        '<span class="np-pill">别名+密码</span>',
        () => {
          void (async () => {
            const res = (await chrome.runtime.sendMessage({
              type: 'NONEPWD_CREATE_SIGNUP_LOGIN',
              url: window.location.href,
              withAlias: true,
            })) as { ok: boolean; item?: VaultItemPayload };
            if (res.ok && res.item) {
              fillLoginCredentials(target.anchor, res.item.username, res.item.password);
              hidePopover();
            }
          })();
        }
      );
    }

    popoverEl.appendChild(list);
  } else {
    for (const entry of data.logins) {
      addOption(
        entry.item.title,
        entry.item.username || entry.item.emailAlias || '点击填充账号密码',
        entry.totpCode ? '<span class="np-pill totp">2FA</span>' : '',
        () => {
          fillLoginCredentials(target.anchor, entry.item.username, entry.item.password);
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
      empty.textContent = `未找到匹配当前域名 (${window.location.hostname}) 的账号。可在 nonepwd 中新增或点击插件图标搜索。`;
      list.appendChild(empty);
    }
    popoverEl.appendChild(list);
  }

  popoverEl.style.display = 'block';
  positionOverlays(target.anchor);
}

async function openPopoverForTarget(target: DetectedTarget) {
  ensureShadowUi();
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

document.addEventListener(
  'focusin',
  (evt) => {
    const el = evt.target;
    if (!(el instanceof HTMLInputElement)) return;
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
      evt.preventDefault();
      evt.stopPropagation();
      optionHandlers[activeIndex]?.();
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
    if (evt.target instanceof HTMLInputElement && currentTarget?.anchor === evt.target) return;
    hidePopover();
  },
  true
);

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'NONEPWD_LIVE_OTP' && msg.email) {
    liveEmailOverride = msg.email as DecryptedEmailPayload & { id?: string };
    if (currentTarget && (currentTarget.kind === 'otp-single' || currentTarget.kind === 'otp-split')) {
      void openPopoverForTarget(currentTarget);
    }
  } else if (msg?.type === 'NONEPWD_FILL_FROM_POPUP' && msg.item) {
    const item = msg.item as VaultItemPayload;
    const anchor =
      currentTarget?.anchor ??
      (document.querySelector('input[type="password"], input[type="email"], input[type="text"]') as HTMLInputElement | null);
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
      currentTarget?.anchor ??
      (document.querySelector('input[maxlength="1"], input[autocomplete="one-time-code"]') as HTMLInputElement | null);
    if (anchor) {
      const target = detectInputTarget(anchor) ?? { kind: 'otp-single', anchor };
      fillOtpTarget(target, String(msg.code));
    }
  }
});
