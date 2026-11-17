import type { DecryptedEmailPayload, VaultItemPayload } from '@nonepwd/core';
import type { PendingCredentialCapture } from './capture.js';
import {
  detectInputTarget,
  extractSubmittedLogin,
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
import {
  INLINE_BADGE_HIDDEN_KEY,
  loadInlineBadgeHidden,
  loadThemePreference,
  normalizeThemePreference,
  saveInlineBadgeHidden,
  THEME_STORAGE_KEY,
} from './theme.js';
import { cropAndDecodeQrDataUrl, type QrCropRect } from './qr.js';
import type { ExtendedVaultItem } from './types.js';

export { INLINE_BADGE_HIDDEN_KEY as HIDE_BADGE_STORAGE_KEY };

const THREE_KEYS_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <circle cx="7.2" cy="7.4" r="3.1" fill="#f5cc2e"/>
  <circle cx="7.2" cy="7.1" r="1.05" fill="#1c1c1e"/>
  <rect x="6.1" y="9.8" width="2.2" height="9.2" rx="1.1" fill="#f5cc2e"/>
  <rect x="8.1" y="14.5" width="1.9" height="1.5" rx="0.45" fill="#f5cc2e"/>
  <rect x="8.1" y="17.1" width="1.9" height="1.5" rx="0.45" fill="#f5cc2e"/>
  <circle cx="12" cy="9.2" r="3.1" fill="#3dcc61"/>
  <circle cx="12" cy="8.9" r="1.05" fill="#1c1c1e"/>
  <rect x="10.9" y="11.6" width="2.2" height="9.2" rx="1.1" fill="#3dcc61"/>
  <rect x="12.9" y="16.3" width="1.9" height="1.5" rx="0.45" fill="#3dcc61"/>
  <rect x="12.9" y="18.9" width="1.9" height="1.5" rx="0.45" fill="#3dcc61"/>
  <circle cx="16.8" cy="7.4" r="3.1" fill="#3d8afa"/>
  <circle cx="16.8" cy="7.1" r="1.05" fill="#1c1c1e"/>
  <rect x="15.7" y="9.8" width="2.2" height="9.2" rx="1.1" fill="#3d8afa"/>
  <rect x="17.7" y="14.5" width="1.9" height="1.5" rx="0.45" fill="#3d8afa"/>
  <rect x="17.7" y="17.1" width="1.9" height="1.5" rx="0.45" fill="#3d8afa"/>
</svg>`;

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
  pendingCapture?: PendingCredentialCapture | null;
}

export const POPOVER_CSS = `
  :host {
    all: initial;
    --np-bg: #ffffff;
    --np-surface: #f5f5f7;
    --np-fg: #1d1d1f;
    --np-muted: #6e6e73;
    --np-border: rgba(0, 0, 0, 0.08);
    --np-hover: rgba(0, 0, 0, 0.05);
    --np-active-border: rgba(53, 85, 245, 0.35);
    --np-primary: #3555f5;
    --np-primary-fg: #ffffff;
    --np-pill-bg: rgba(0, 0, 0, 0.055);
    --np-pill-fg: #1d1d1f;
    --np-pill-border: transparent;
    --np-dot-unlocked: #30d158;
    --np-dot-locked: #a3a3a3;
    --np-input-bg: rgba(0, 0, 0, 0.055);
    --np-shadow: 0 14px 36px rgba(0, 0, 0, 0.14), 0 0 0 0.5px rgba(0, 0, 0, 0.08);
  }
  :host([data-theme="dark"]) {
    --np-bg: #1c1c1e;
    --np-surface: #2c2c2e;
    --np-fg: #f5f5f7;
    --np-muted: #98989d;
    --np-border: rgba(255, 255, 255, 0.10);
    --np-hover: rgba(255, 255, 255, 0.08);
    --np-active-border: rgba(76, 110, 245, 0.45);
    --np-primary: #4c6ef5;
    --np-primary-fg: #ffffff;
    --np-pill-bg: rgba(255, 255, 255, 0.10);
    --np-pill-fg: #f5f5f7;
    --np-pill-border: transparent;
    --np-dot-unlocked: #30d158;
    --np-dot-locked: #737373;
    --np-input-bg: rgba(255, 255, 255, 0.08);
    --np-shadow: 0 18px 44px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255, 255, 255, 0.10);
  }
  @media (prefers-color-scheme: dark) {
    :host([data-theme="system"]) {
      --np-bg: #1c1c1e;
      --np-surface: #2c2c2e;
      --np-fg: #f5f5f7;
      --np-muted: #98989d;
      --np-border: rgba(255, 255, 255, 0.10);
      --np-hover: rgba(255, 255, 255, 0.08);
      --np-active-border: rgba(76, 110, 245, 0.45);
      --np-primary: #4c6ef5;
      --np-primary-fg: #ffffff;
      --np-pill-bg: rgba(255, 255, 255, 0.10);
      --np-pill-fg: #f5f5f7;
      --np-pill-border: transparent;
      --np-dot-unlocked: #30d158;
      --np-dot-locked: #737373;
      --np-input-bg: rgba(255, 255, 255, 0.08);
      --np-shadow: 0 18px 44px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255, 255, 255, 0.10);
    }
  }
  * {
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", sans-serif;
  }
  .np-badge-wrap {
    position: fixed;
    z-index: 2147483646;
    width: 22px;
    height: 22px;
    display: none;
    user-select: none;
  }
  .np-badge {
    width: 22px;
    height: 22px;
    border-radius: 5.5px;
    border: 0.5px solid rgba(255, 255, 255, 0.14);
    background: #1c1c1e;
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
    transition: transform 0.12s ease, opacity 0.12s ease;
    padding: 0;
  }
  .np-badge:hover { transform: scale(1.06); }
  .np-badge.dragging, .np-badge:active { cursor: grabbing; transform: scale(1.04); }
  .np-badge-close {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #1c1c1e;
    color: #f5f5f7;
    font-size: 10px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  }
  .np-badge-wrap:hover .np-badge-close,
  .np-badge-close:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
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
  .np-save-banner {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    width: 316px;
    max-width: calc(100vw - 24px);
    background: var(--np-bg);
    color: var(--np-fg);
    border-radius: 14px;
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.16), 0 0 0 1px var(--np-border);
    padding: 14px;
    animation: np-fade 0.14s ease-out;
  }
  .np-save-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
  }
  .np-save-head-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .np-save-emblem {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: #1c1c1e;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .np-save-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--np-fg);
    line-height: 1.25;
  }
  .np-save-sub {
    font-size: 11px;
    color: var(--np-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .np-save-close {
    width: 22px;
    height: 22px;
    border: none;
    background: var(--np-input-bg);
    color: var(--np-muted);
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .np-save-close:hover {
    color: var(--np-fg);
  }
  .np-save-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }
  .np-save-pw-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .np-save-input {
    width: 100%;
    height: 34px;
    border: none;
    outline: none;
    border-radius: 999px;
    background: var(--np-input-bg);
    color: var(--np-fg);
    font-size: 12.5px;
    padding: 0 14px;
  }
  .np-save-pw-wrap .np-save-input {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    padding-right: 36px;
  }
  .np-save-input:focus {
    background: var(--np-hover);
    box-shadow: none;
  }
  .np-save-eye {
    position: absolute;
    right: 6px;
    border: none;
    background: transparent;
    color: var(--np-muted);
    cursor: pointer;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .np-save-eye:hover {
    color: var(--np-fg);
  }
  .np-save-err {
    font-size: 11px;
    color: #e5484d;
    margin-bottom: 8px;
  }
  .np-save-notice {
    font-size: 12px;
    color: var(--np-muted);
    background: var(--np-input-bg);
    border-radius: 9px;
    padding: 9px 11px;
    line-height: 1.45;
    margin-bottom: 12px;
  }
  .np-save-done {
    font-size: 12.5px;
    font-weight: 600;
    color: #18a957;
    text-align: center;
    padding: 10px 4px 4px;
  }
  .np-save-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .np-save-actions-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .np-save-btn {
    height: 32px;
    border: none;
    border-radius: 999px;
    padding: 0 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.12s ease, background 0.12s ease;
  }
  .np-save-btn.secondary {
    background: var(--np-input-bg);
    color: var(--np-fg);
  }
  .np-save-btn.secondary:hover {
    background: var(--np-hover);
  }
  .np-save-btn.link {
    background: transparent;
    color: var(--np-muted);
    padding: 0 4px;
    font-weight: 500;
  }
  .np-save-btn.link:hover {
    color: var(--np-fg);
  }
  .np-save-btn.primary {
    background: var(--np-primary);
    color: var(--np-primary-fg);
  }
  .np-save-btn.primary:hover {
    opacity: 0.92;
  }
  .np-save-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .np-qr-toast {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    width: 332px;
    max-width: calc(100vw - 24px);
    background: var(--np-bg);
    color: var(--np-fg);
    border-radius: 14px;
    box-shadow: var(--np-shadow);
    border: 1px solid var(--np-border);
    padding: 12px 14px;
    display: none;
    animation: np-fade 0.14s ease-out;
  }
  .np-qr-toast-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .np-qr-toast-left {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .np-qr-toast-msg {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--np-fg);
    line-height: 1.4;
    word-break: break-word;
  }
  .np-qr-toast-msg.ok {
    color: var(--np-fg);
  }
  .np-qr-toast-msg.err {
    color: #e5484d;
  }
  .np-qr-toast-sub {
    margin-top: 2px;
    font-size: 11px;
    color: var(--np-muted);
    line-height: 1.4;
    word-break: break-word;
  }
  .np-qr-toast-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 10px;
  }
`;

const QR_SNIP_CSS = `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    cursor: crosshair;
    user-select: none;
    -webkit-user-select: none;
  }
  * {
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", sans-serif;
  }
  .np-snip-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    cursor: crosshair;
    user-select: none;
  }
  .np-snip-backdrop.dragging {
    background: transparent;
  }
  .np-snip-box {
    position: fixed;
    display: none;
    border: 2px solid #3555f5;
    border-radius: 6px;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.42);
    pointer-events: none;
    z-index: 1;
  }
  .np-snip-pill {
    position: fixed;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px 7px 14px;
    border-radius: 999px;
    background: rgba(28, 28, 30, 0.92);
    color: #f5f5f7;
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(12px);
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    cursor: default;
  }
  .np-snip-pill-cancel {
    border: none;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    color: #ffffff;
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .np-snip-pill-cancel:hover {
    background: rgba(255, 255, 255, 0.24);
  }
`;

interface QrImportResultMessage {
  type: 'NONEPWD_QR_IMPORT_RESULT';
  ok: boolean;
  locked?: boolean;
  previewTitle?: string;
  importedCount?: number;
  createdCount?: number;
  attachedCount?: number;
  skippedCount?: number;
  title?: string;
  code?: string;
  remainingSeconds?: number;
  error?: string;
}

let hostEl: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let badgeWrap: HTMLDivElement | null = null;
let badgeBtn: HTMLButtonElement | null = null;
let badgeHideBtn: HTMLButtonElement | null = null;
let popoverEl: HTMLDivElement | null = null;
let saveBannerEl: HTMLDivElement | null = null;
let qrToastEl: HTMLDivElement | null = null;
let qrToastTimer: ReturnType<typeof setTimeout> | null = null;
let qrSnipCleanup: (() => void) | null = null;

let currentTarget: DetectedTarget | null = null;
let lastQueryData: TabQueryResponse | null = null;
let liveEmailOverride: (DecryptedEmailPayload & { id?: string }) | null = null;
let activeIndex = 0;
let optionHandlers: Array<{ run: () => void; clickOnly?: boolean }> = [];
let currentThemePref: 'light' | 'dark' | 'system' = 'light';
let inlineBadgeHidden = false;
let badgeDragOffset = { x: 0, y: 0 };
let activeBannerId: string | null = null;
let activeBannerUnlocked = false;
let lastCaptureSig = '';
let lastCaptureAt = 0;

const LAST_USER_KEY = '__np_last_user';

function rememberTypedUsername(val: string) {
  const clean = val.trim();
  if (!clean) return;
  try {
    sessionStorage.setItem(LAST_USER_KEY, JSON.stringify({ value: clean, ts: Date.now() }));
  } catch {
    // ignore storage-restricted origins
  }
}

function readLastTypedUsername(): string {
  try {
    const raw = sessionStorage.getItem(LAST_USER_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { value?: string; ts?: number };
    if (parsed.value && parsed.ts && Date.now() - parsed.ts < 5 * 60_000) {
      return parsed.value;
    }
  } catch {
    // ignore
  }
  return '';
}

function tryCaptureCredentials(scope: ParentNode) {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') return;
  const creds = extractSubmittedLogin(scope, readLastTypedUsername());
  if (!creds) return;
  rememberTypedUsername(creds.username);
  const sig = `${window.location.origin}|${creds.username}|${creds.password}`;
  const now = Date.now();
  if (sig === lastCaptureSig && now - lastCaptureAt < 900) return;
  lastCaptureSig = sig;
  lastCaptureAt = now;

  void chrome.runtime
    .sendMessage({
      type: 'NONEPWD_CAPTURE_CREDENTIAL',
      url: window.location.href,
      username: creds.username,
      password: creds.password,
    })
    .catch(() => {});
}

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

  badgeWrap = document.createElement('div');
  badgeWrap.className = 'np-badge-wrap';

  badgeBtn = document.createElement('button');
  badgeBtn.type = 'button';
  badgeBtn.className = 'np-badge';
  badgeBtn.title = 'NonePwd 自动填充（可拖动位置，悬停点 × 可隐藏）';
  badgeBtn.innerHTML = THREE_KEYS_SVG;
  badgeBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = badgeDragOffset.x;
    const origY = badgeDragOffset.y;
    let dragged = false;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) >= 4) {
        dragged = true;
        badgeBtn?.classList.add('dragging');
      }
      if (dragged) {
        badgeDragOffset = { x: origX + dx, y: origY + dy };
        if (currentTarget) positionOverlays(currentTarget.anchor);
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      badgeBtn?.classList.remove('dragging');
      if (!dragged) {
        if (popoverEl && popoverEl.style.display !== 'none') {
          hidePopover();
        } else if (currentTarget) {
          void openPopoverForTarget(currentTarget);
        }
      }
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });

  badgeHideBtn = document.createElement('button');
  badgeHideBtn.type = 'button';
  badgeHideBtn.className = 'np-badge-close';
  badgeHideBtn.title = '隐藏网页内悬浮图标（可在浏览器右上角 NonePwd 扩展中重新开启）';
  badgeHideBtn.setAttribute('aria-label', '隐藏网页内悬浮图标');
  badgeHideBtn.textContent = '×';
  badgeHideBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  badgeHideBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    inlineBadgeHidden = true;
    if (badgeWrap) badgeWrap.style.display = 'none';
    hidePopover();
    void saveInlineBadgeHidden(true);
  });

  badgeWrap.appendChild(badgeBtn);
  badgeWrap.appendChild(badgeHideBtn);
  shadowRoot.appendChild(badgeWrap);

  popoverEl = document.createElement('div');
  popoverEl.className = 'np-popover';
  popoverEl.style.display = 'none';
  shadowRoot.appendChild(popoverEl);

  saveBannerEl = document.createElement('div');
  saveBannerEl.className = 'np-save-banner';
  saveBannerEl.style.display = 'none';
  shadowRoot.appendChild(saveBannerEl);

  qrToastEl = document.createElement('div');
  qrToastEl.className = 'np-qr-toast';
  qrToastEl.style.display = 'none';
  shadowRoot.appendChild(qrToastEl);

  document.documentElement.appendChild(hostEl);
  return shadowRoot;
}

function hideQrToast() {
  if (qrToastTimer !== null) {
    clearTimeout(qrToastTimer);
    qrToastTimer = null;
  }
  if (qrToastEl) {
    qrToastEl.style.display = 'none';
    qrToastEl.innerHTML = '';
  }
}

async function showQrImportToast(msg: QrImportResultMessage) {
  currentThemePref = await loadThemePreference();
  ensureShadowUi();
  syncHostTheme();
  if (!qrToastEl) return;

  if (qrToastTimer !== null) {
    clearTimeout(qrToastTimer);
    qrToastTimer = null;
  }
  qrToastEl.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'np-qr-toast-row';

  const left = document.createElement('div');
  left.className = 'np-qr-toast-left';

  const emblem = document.createElement('div');
  emblem.className = 'np-save-emblem';
  emblem.innerHTML = THREE_KEYS_SVG.replace('width="16" height="16"', 'width="20" height="20"');

  const body = document.createElement('div');
  body.style.minWidth = '0';
  body.style.flex = '1';

  const msgEl = document.createElement('div');
  msgEl.className = `np-qr-toast-msg ${msg.ok ? 'ok' : 'err'}`;

  const subEl = document.createElement('div');
  subEl.className = 'np-qr-toast-sub';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'np-qr-toast-actions';

  if (msg.ok && !msg.locked) {
    if (msg.code && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(msg.code).catch(() => {});
    }
    const title = msg.title || '2FA';
    const code = msg.code || '';
    if ((msg.importedCount ?? 0) > 1) {
      msgEl.textContent = `✓ 已导入 ${msg.importedCount} 个 2FA · ${title} · 验证码 ${code} 已复制`;
    } else if (msg.importedCount === 0 && (msg.skippedCount ?? 0) > 0) {
      msgEl.textContent = `✓ 该 2FA 已存在：${title} · 验证码 ${code} 已复制`;
    } else {
      msgEl.textContent = `✓ 已导入 2FA：${title} · 验证码 ${code} 已复制`;
    }
    if (typeof msg.remainingSeconds === 'number') {
      subEl.textContent = `当前周期剩余 ${msg.remainingSeconds}s`;
    }

    const otpAnchor =
      (currentTarget && (currentTarget.kind === 'otp-single' || currentTarget.kind === 'otp-split')
        ? currentTarget.anchor
        : null) ??
      findFallbackField((t) => Boolean(t && (t.kind === 'otp-single' || t.kind === 'otp-split')));
    if (otpAnchor && code) {
      const fillBtn = document.createElement('button');
      fillBtn.type = 'button';
      fillBtn.className = 'np-save-btn primary';
      fillBtn.textContent = '填入';
      fillBtn.addEventListener('click', () => {
        const target = detectInputTarget(otpAnchor) ?? {
          kind: 'otp-single',
          anchor: otpAnchor as HTMLInputElement,
        };
        fillOtpTarget(target, code);
        hideQrToast();
      });
      actionsEl.appendChild(fillBtn);
    }
  } else if (msg.ok && msg.locked) {
    msgEl.textContent = '已识别 2FA 二维码，请在弹出的 NonePwd 窗口解锁后自动保存';
    if (msg.previewTitle) {
      subEl.textContent = msg.previewTitle;
    }
  } else {
    msgEl.textContent = msg.error || '所选区域未识别到有效的 2FA 二维码';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'np-save-btn primary';
    retryBtn.textContent = '重新框选';
    retryBtn.addEventListener('click', () => {
      hideQrToast();
      void startQrSnipOverlay();
    });
    actionsEl.appendChild(retryBtn);
  }

  body.appendChild(msgEl);
  if (subEl.textContent) {
    body.appendChild(subEl);
  }
  left.appendChild(emblem);
  left.appendChild(body);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'np-save-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', hideQrToast);

  row.appendChild(left);
  row.appendChild(closeBtn);
  qrToastEl.appendChild(row);
  if (actionsEl.childElementCount > 0) {
    qrToastEl.appendChild(actionsEl);
  }
  qrToastEl.style.display = 'block';

  qrToastTimer = setTimeout(() => {
    hideQrToast();
  }, 4500);
}

function cleanupQrSnipOverlay() {
  if (qrSnipCleanup) {
    const fn = qrSnipCleanup;
    qrSnipCleanup = null;
    fn();
  }
  const stale = document.querySelectorAll('[data-nonepwd-qr-snip="true"]');
  for (const node of Array.from(stale)) {
    node.remove();
  }
}

async function startQrSnipOverlay() {
  if (typeof window === 'undefined' || window !== window.top) return;
  cleanupQrSnipOverlay();
  hidePopover();
  hideQrToast();

  const snipHost = document.createElement('div');
  snipHost.setAttribute('data-nonepwd-qr-snip', 'true');
  const snipShadow = snipHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = QR_SNIP_CSS;
  snipShadow.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'np-snip-backdrop';

  const box = document.createElement('div');
  box.className = 'np-snip-box';

  const pill = document.createElement('div');
  pill.className = 'np-snip-pill';
  const pillText = document.createElement('span');
  pillText.textContent = '拖拽框选网页上的 2FA 二维码 · 按 Esc 取消';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'np-snip-pill-cancel';
  cancelBtn.textContent = '取消';
  pill.appendChild(pillText);
  pill.appendChild(cancelBtn);

  backdrop.appendChild(box);
  backdrop.appendChild(pill);
  snipShadow.appendChild(backdrop);

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let currentRect = { x: 0, y: 0, width: 0, height: 0 };

  const updateBox = (clientX: number, clientY: number) => {
    const clampedX = Math.max(0, Math.min(window.innerWidth, clientX));
    const clampedY = Math.max(0, Math.min(window.innerHeight, clientY));
    const x = Math.min(startX, clampedX);
    const y = Math.min(startY, clampedY);
    const width = Math.abs(clampedX - startX);
    const height = Math.abs(clampedY - startY);
    currentRect = { x, y, width, height };
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    if (width > 0 || height > 0) {
      backdrop.classList.add('dragging');
      box.style.display = 'block';
    }
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
      cleanupQrSnipOverlay();
      return;
    }
    if (e.button !== 0) return;
    if (e.composedPath().includes(pill)) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = Math.max(0, Math.min(window.innerWidth, e.clientX));
    startY = Math.max(0, Math.min(window.innerHeight, e.clientY));
    currentRect = { x: startX, y: startY, width: 0, height: 0 };
    box.style.display = 'none';
    backdrop.classList.remove('dragging');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    e.preventDefault();
    updateBox(e.clientX, e.clientY);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!dragging) return;
    dragging = false;
    e.preventDefault();
    e.stopPropagation();
    updateBox(e.clientX, e.clientY);

    const { x, y, width, height } = currentRect;
    if (width < 14 || height < 14) {
      box.style.display = 'none';
      backdrop.classList.remove('dragging');
      return;
    }

    cleanupQrSnipOverlay();
    void (async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      try {
        await chrome.runtime.sendMessage({
          type: 'NONEPWD_CAPTURE_QR_RECT',
          rect: {
            x,
            y,
            width,
            height,
            dpr: window.devicePixelRatio || 1,
            pageUrl: window.location.href,
            pageTitle: document.title,
          },
        });
      } catch {
        // ignore send errors if tab navigated or extension reloaded
      }
    })();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanupQrSnipOverlay();
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    cleanupQrSnipOverlay();
  };

  cancelBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cleanupQrSnipOverlay();
  });

  backdrop.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('contextmenu', onContextMenu, true);

  qrSnipCleanup = () => {
    backdrop.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    snipHost.remove();
  };

  document.documentElement.appendChild(snipHost);
}

function hideSaveBanner() {
  if (saveBannerEl) {
    saveBannerEl.style.display = 'none';
    saveBannerEl.innerHTML = '';
  }
  activeBannerId = null;
  activeBannerUnlocked = false;
}

function renderSaveBanner(capture: PendingCredentialCapture, unlocked: boolean) {
  if (!saveBannerEl) return;
  activeBannerId = capture.id;
  saveBannerEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'np-save-head';

  const headLeft = document.createElement('div');
  headLeft.className = 'np-save-head-left';

  const emblem = document.createElement('div');
  emblem.className = 'np-save-emblem';
  emblem.innerHTML = THREE_KEYS_SVG.replace('width="16" height="16"', 'width="20" height="20"');

  const titleWrap = document.createElement('div');
  titleWrap.style.minWidth = '0';
  const titleEl = document.createElement('div');
  titleEl.className = 'np-save-title';
  titleEl.textContent = capture.mode === 'update' ? '更新密码？' : '保存密码到 NonePwd？';
  const subEl = document.createElement('div');
  subEl.className = 'np-save-sub';
  subEl.textContent = capture.host;
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(subEl);

  headLeft.appendChild(emblem);
  headLeft.appendChild(titleWrap);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'np-save-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    void chrome.runtime.sendMessage({
      type: 'NONEPWD_DISMISS_SAVE_CREDENTIAL',
      captureId: capture.id,
    });
    hideSaveBanner();
  });

  head.appendChild(headLeft);
  head.appendChild(closeBtn);
  saveBannerEl.appendChild(head);

  const dismissBanner = (neverForSite: boolean) => {
    void chrome.runtime.sendMessage({
      type: 'NONEPWD_DISMISS_SAVE_CREDENTIAL',
      captureId: capture.id,
      neverForSite,
      host: capture.host,
    });
    hideSaveBanner();
  };

  if (!unlocked) {
    const notice = document.createElement('div');
    notice.className = 'np-save-notice';
    notice.textContent = `已捕获 ${capture.username || capture.host} 的凭据。密码库当前已锁定，请点击浏览器右上角 NonePwd 扩展图标解锁后保存。`;
    saveBannerEl.appendChild(notice);

    const actions = document.createElement('div');
    actions.className = 'np-save-actions';
    const neverBtn = document.createElement('button');
    neverBtn.type = 'button';
    neverBtn.className = 'np-save-btn link';
    neverBtn.textContent = '对此网站一律不';
    neverBtn.addEventListener('click', () => dismissBanner(true));

    const laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'np-save-btn secondary';
    laterBtn.textContent = '暂不';
    laterBtn.addEventListener('click', () => dismissBanner(false));

    actions.appendChild(neverBtn);
    actions.appendChild(laterBtn);
    saveBannerEl.appendChild(actions);
    saveBannerEl.style.display = 'block';
    return;
  }

  const fields = document.createElement('div');
  fields.className = 'np-save-fields';

  const userInput = document.createElement('input');
  userInput.type = 'text';
  userInput.className = 'np-save-input';
  userInput.placeholder = '用户名 / 邮箱（可选）';
  userInput.value = capture.username;

  const pwWrap = document.createElement('div');
  pwWrap.className = 'np-save-pw-wrap';
  const pwInput = document.createElement('input');
  pwInput.type = 'password';
  pwInput.className = 'np-save-input';
  pwInput.value = capture.password;

  let pwVisible = false;
  const eyeBtn = document.createElement('button');
  eyeBtn.type = 'button';
  eyeBtn.className = 'np-save-eye';
  eyeBtn.title = '显示密码';
  const renderEyeIcon = () => {
    eyeBtn.innerHTML = pwVisible
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  };
  renderEyeIcon();
  eyeBtn.addEventListener('click', () => {
    pwVisible = !pwVisible;
    pwInput.type = pwVisible ? 'text' : 'password';
    eyeBtn.title = pwVisible ? '隐藏密码' : '显示密码';
    renderEyeIcon();
  });

  pwWrap.appendChild(pwInput);
  pwWrap.appendChild(eyeBtn);
  fields.appendChild(userInput);
  fields.appendChild(pwWrap);
  saveBannerEl.appendChild(fields);

  const errEl = document.createElement('div');
  errEl.className = 'np-save-err';
  errEl.style.display = 'none';
  saveBannerEl.appendChild(errEl);

  const actions = document.createElement('div');
  actions.className = 'np-save-actions';

  const neverBtn = document.createElement('button');
  neverBtn.type = 'button';
  neverBtn.className = 'np-save-btn link';
  neverBtn.textContent = '一律不';
  neverBtn.addEventListener('click', () => dismissBanner(true));

  const rightGroup = document.createElement('div');
  rightGroup.className = 'np-save-actions-right';

  const laterBtn = document.createElement('button');
  laterBtn.type = 'button';
  laterBtn.className = 'np-save-btn secondary';
  laterBtn.textContent = '暂不';
  laterBtn.addEventListener('click', () => dismissBanner(false));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'np-save-btn primary';
  saveBtn.textContent = capture.mode === 'update' ? '更新' : '保存';
  saveBtn.addEventListener('click', () => {
    void (async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
      errEl.style.display = 'none';
      try {
        const res = (await chrome.runtime.sendMessage({
          type: 'NONEPWD_CONFIRM_SAVE_CREDENTIAL',
          captureId: capture.id,
          username: userInput.value,
          password: pwInput.value,
          title: capture.title,
        })) as { ok: boolean; error?: string; mode?: 'create' | 'update' };
        if (!res.ok) throw new Error(res.error || '保存失败');
        if (saveBannerEl) {
          saveBannerEl.innerHTML = '';
          const done = document.createElement('div');
          done.className = 'np-save-done';
          done.textContent =
            res.mode === 'update' ? '✓ 已加密更新至 NonePwd' : '✓ 已加密保存至 NonePwd';
          saveBannerEl.appendChild(done);
          setTimeout(hideSaveBanner, 1200);
        }
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = capture.mode === 'update' ? '更新' : '保存';
        errEl.textContent = err instanceof Error ? err.message : String(err);
        errEl.style.display = 'block';
      }
    })();
  });

  rightGroup.appendChild(laterBtn);
  rightGroup.appendChild(saveBtn);
  actions.appendChild(neverBtn);
  actions.appendChild(rightGroup);
  saveBannerEl.appendChild(actions);
  saveBannerEl.style.display = 'block';
}

async function ensureThemeAndShowBanner(capture: PendingCredentialCapture, unlocked: boolean) {
  if (
    activeBannerId === capture.id &&
    activeBannerUnlocked === unlocked &&
    saveBannerEl?.style.display === 'block'
  ) {
    return;
  }
  currentThemePref = await loadThemePreference();
  ensureShadowUi();
  syncHostTheme();
  activeBannerUnlocked = unlocked;
  renderSaveBanner(capture, unlocked);
}

function positionOverlays(anchor: FormFieldElement) {
  const rect = anchor.getBoundingClientRect();
  if (badgeWrap) {
    if (inlineBadgeHidden) {
      badgeWrap.style.display = 'none';
    } else {
      const isPasswordField =
        anchor instanceof HTMLInputElement &&
        (anchor.type === 'password' ||
          currentTarget?.kind === 'password' ||
          currentTarget?.kind === 'new-password');
      const baseRightOffset =
        isPasswordField && rect.width >= 150 ? 50 : anchor.tagName === 'SELECT' ? 38 : 26;
      const top = Math.max(
        4,
        Math.min(window.innerHeight - 26, rect.top + (rect.height - 22) / 2 + badgeDragOffset.y)
      );
      const left = Math.max(
        4,
        Math.min(window.innerWidth - 26, rect.right - baseRightOffset + badgeDragOffset.x)
      );
      badgeWrap.style.display = 'block';
      badgeWrap.style.top = `${top}px`;
      badgeWrap.style.left = `${left}px`;
    }
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
  if (badgeWrap) badgeWrap.style.display = 'none';
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
      pendingCapture: null,
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

  void loadInlineBadgeHidden().then((hidden) => {
    inlineBadgeHidden = hidden;
    if (inlineBadgeHidden && badgeWrap) {
      badgeWrap.style.display = 'none';
    }
  });

  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    void queryBackground().then((data) => {
      if (data.pendingCapture) {
        void ensureThemeAndShowBanner(data.pendingCapture, data.unlocked);
      }
    });
  }

  const trackUsernameField = (evt: Event) => {
    const el = evt.target;
    if (!(el instanceof HTMLInputElement)) return;
    const t = detectInputTarget(el);
    if (t?.kind === 'username' || t?.kind === 'identity-email') {
      rememberTypedUsername(el.value);
    }
  };
  document.addEventListener('input', trackUsernameField, true);
  document.addEventListener('change', trackUsernameField, true);

  document.addEventListener(
    'submit',
    (evt) => {
      const scope = evt.target instanceof HTMLFormElement ? evt.target : document;
      tryCaptureCredentials(scope);
    },
    true
  );

  document.addEventListener(
    'click',
    (evt) => {
      const targetEl = evt.target instanceof Element ? evt.target : null;
      const btn = targetEl?.closest('button, input[type="submit"], [role="button"]');
      if (!btn) return;
      if ((btn.getAttribute('type') || '').toLowerCase() === 'reset') return;
      const scope = btn.closest('form') ?? document;
      tryCaptureCredentials(scope);
    },
    true
  );

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
      if (inlineBadgeHidden) {
        currentTarget = detected;
        hidePopover();
        if (badgeWrap) badgeWrap.style.display = 'none';
        return;
      }
      void openPopoverForTarget(detected);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (evt) => {
      if (evt.key === 'Enter' && evt.target instanceof HTMLInputElement) {
        const scope = evt.target.closest('form') ?? document;
        tryCaptureCredentials(scope);
      }
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
    if (areaName !== 'local') return;
    if (changes[THEME_STORAGE_KEY]) {
      currentThemePref = normalizeThemePreference(changes[THEME_STORAGE_KEY].newValue);
      syncHostTheme();
    }
    if (changes[INLINE_BADGE_HIDDEN_KEY]) {
      inlineBadgeHidden = Boolean(changes[INLINE_BADGE_HIDDEN_KEY].newValue);
      if (inlineBadgeHidden) {
        if (badgeWrap) badgeWrap.style.display = 'none';
        hidePopover();
      } else if (currentTarget) {
        positionOverlays(currentTarget.anchor);
      }
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'NONEPWD_BEGIN_QR_SNIP') {
      if (typeof window !== 'undefined' && window === window.top) {
        void startQrSnipOverlay();
        sendResponse({ ok: true });
      }
      return;
    }

    if (msg?.type === 'NONEPWD_DECODE_QR_DATAURL') {
      if (typeof window !== 'undefined' && window === window.top) {
        void cropAndDecodeQrDataUrl(
          String(msg.dataUrl || ''),
          msg.rect as QrCropRect | undefined
        )
          .then((res) => sendResponse({ ok: true, ...res }))
          .catch((err) =>
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          );
        return true;
      }
      return;
    }

    if (msg?.type === 'NONEPWD_QR_IMPORT_RESULT') {
      if (typeof window !== 'undefined' && window === window.top) {
        void showQrImportToast(msg as QrImportResultMessage);
        sendResponse({ ok: true });
      }
      return;
    }

    if (msg?.type === 'NONEPWD_PROMPT_SAVE' && msg.capture) {
      void ensureThemeAndShowBanner(msg.capture as PendingCredentialCapture, Boolean(msg.unlocked));
    } else if (msg?.type === 'NONEPWD_LIVE_OTP' && msg.email) {
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
