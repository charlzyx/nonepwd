import {
  detectInputTarget,
  findCardFormFields,
  findFormFields,
  findIdentityFormFields,
  type CardInputKind,
  type DetectedInputKind,
  type DetectedTarget,
  type FormFieldElement,
  type IdentityInputKind,
} from './detector.js';
import type { CardPayload, IdentityPayload } from './types.js';

function isSelectEl(el: FormFieldElement): el is HTMLSelectElement {
  const win = el.ownerDocument.defaultView;
  return win?.HTMLSelectElement ? el instanceof win.HTMLSelectElement : el.tagName === 'SELECT';
}

function isTextAreaEl(el: FormFieldElement): el is HTMLTextAreaElement {
  const win = el.ownerDocument.defaultView;
  return win?.HTMLTextAreaElement ? el instanceof win.HTMLTextAreaElement : el.tagName === 'TEXTAREA';
}

export function setNativeInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const win = input.ownerDocument.defaultView;
  const proto = isTextAreaEl(input)
    ? (win ? win.HTMLTextAreaElement.prototype : HTMLTextAreaElement.prototype)
    : (win ? win.HTMLInputElement.prototype : HTMLInputElement.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  const EventCtor = win?.Event ?? Event;
  input.dispatchEvent(new EventCtor('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new EventCtor('change', { bubbles: true, cancelable: true }));
}

const MONTH_NAMES = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may', 'may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

const COUNTRY_ALIASES: string[][] = [
  ['cn', 'chn', 'china', '中国', '中华人民共和国', '中国大陆'],
  ['us', 'usa', 'united states', 'united states of america', '美国'],
  ['gb', 'uk', 'united kingdom', 'great britain', 'england', '英国'],
  ['jp', 'jpn', 'japan', '日本'],
  ['hk', 'hkg', 'hong kong', '香港', '中国香港'],
  ['tw', 'twn', 'taiwan', '台湾', '中国台湾'],
  ['sg', 'sgp', 'singapore', '新加坡'],
  ['ca', 'can', 'canada', '加拿大'],
  ['au', 'aus', 'australia', '澳大利亚'],
  ['de', 'deu', 'germany', '德国'],
  ['fr', 'fra', 'france', '法国'],
  ['kr', 'kor', 'south korea', 'korea', 'republic of korea', '韩国'],
];

function findCountryAliasGroup(val: string): string[] | undefined {
  const low = val.trim().toLowerCase();
  return COUNTRY_ALIASES.find((group) => group.includes(low));
}

export function setNativeSelectValue(
  select: HTMLSelectElement,
  rawValue: string,
  kind?: DetectedInputKind
): boolean {
  const target = rawValue.trim();
  if (!target) return false;
  const targetLower = target.toLowerCase();

  const options = Array.from(select.options);
  let matched: HTMLOptionElement | undefined;

  if (kind === 'cc-exp-month') {
    const num = Number.parseInt(target, 10);
    if (num >= 1 && num <= 12) {
      const padded = String(num).padStart(2, '0');
      const unpadded = String(num);
      const names = MONTH_NAMES[num - 1] ?? [];
      matched =
        options.find((o) => {
          const v = o.value.trim().toLowerCase();
          const t = (o.textContent || '').trim().toLowerCase();
          return (
            v === padded ||
            v === unpadded ||
            t === padded ||
            t === unpadded ||
            t === `${padded}月` ||
            t === `${unpadded}月`
          );
        }) ??
        options.find((o) => {
          const t = (o.textContent || '').trim().toLowerCase();
          return (
            t.startsWith(`${padded} `) ||
            t.startsWith(`${padded}-`) ||
            t.startsWith(`${padded}/`) ||
            t.startsWith(`${unpadded} `) ||
            t.startsWith(`${unpadded}-`) ||
            names.some((n) => t.includes(n))
          );
        });
    }
  } else if (kind === 'cc-exp-year') {
    const digits = target.replace(/\D/g, '');
    if (digits) {
      const full = digits.length === 2 ? `20${digits}` : digits.slice(0, 4);
      const short = full.slice(-2);
      matched = options.find((o) => {
        const v = o.value.trim().toLowerCase();
        const t = (o.textContent || '').trim().toLowerCase();
        return (
          v === full ||
          v === short ||
          t === full ||
          t === short ||
          t === `${full}年` ||
          t === `${short}年`
        );
      });
    }
  }

  if (!matched) {
    matched = options.find((o) => {
      const v = o.value.trim().toLowerCase();
      const t = (o.textContent || '').trim().toLowerCase();
      return v === targetLower || t === targetLower;
    });
  }

  if (!matched && kind === 'identity-country') {
    const aliases = findCountryAliasGroup(targetLower);
    if (aliases) {
      matched = options.find((o) => {
        const v = o.value.trim().toLowerCase();
        const t = (o.textContent || '').trim().toLowerCase();
        return aliases.includes(v) || aliases.includes(t);
      });
    }
  }

  if (!matched && targetLower.length >= 2) {
    matched = options.find((o) => {
      const v = o.value.trim().toLowerCase();
      const t = (o.textContent || '').trim().toLowerCase();
      if (!v && !t) return false;
      if (/^(请选择|select|choose|--)/.test(t)) return false;
      return (
        (t.length >= 2 && (t.includes(targetLower) || targetLower.includes(t))) ||
        (v.length >= 2 && (v.includes(targetLower) || targetLower.includes(v)))
      );
    });
  }

  if (!matched) return false;

  const win = select.ownerDocument.defaultView;
  const proto = win ? win.HTMLSelectElement.prototype : HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  matched.selected = true;
  if (descriptor?.set) {
    descriptor.set.call(select, matched.value);
  } else {
    select.value = matched.value;
  }

  const EventCtor = win?.Event ?? Event;
  select.dispatchEvent(new EventCtor('input', { bubbles: true, cancelable: true }));
  select.dispatchEvent(new EventCtor('change', { bubbles: true, cancelable: true }));
  return true;
}

function setFieldValue(
  el: FormFieldElement,
  value: string,
  kind?: DetectedInputKind
): boolean {
  if (!value) return false;
  if (isSelectEl(el)) {
    return setNativeSelectValue(el, value, kind);
  }
  el.focus();
  setNativeInputValue(el, value);
  return true;
}

export function inferCardBrand(cardNumber?: string): string {
  const digits = (cardNumber ?? '').replace(/\D/g, '');
  if (!digits) return 'Card';
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^62/.test(digits)) return 'UnionPay';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'Discover';
  if (/^35/.test(digits)) return 'JCB';
  return 'Card';
}

export function formatCardDisplay(
  card?: CardPayload,
  fallbackTitle?: string
): { brand: string; last4: string; label: string } {
  const digits = (card?.number ?? '').replace(/\D/g, '');
  const last4 = digits.length >= 4 ? digits.slice(-4) : '';
  const brand = card?.brand?.trim() || inferCardBrand(card?.number);
  const label = last4 ? `${brand} •••• ${last4}` : fallbackTitle || brand;
  return { brand, last4, label };
}

export function formatCardExpiry(
  expMonth?: string,
  expYear?: string,
  target?: FormFieldElement
): string {
  const monthDigits = (expMonth ?? '').replace(/\D/g, '');
  const yearDigits = (expYear ?? '').replace(/\D/g, '');
  if (!monthDigits || !yearDigits) return '';

  const paddedMonth = monthDigits.padStart(2, '0').slice(-2);
  const fullYear = yearDigits.length === 2 ? `20${yearDigits}` : yearDigits.slice(0, 4);
  const shortYear = fullYear.slice(-2);

  const placeholder = target && 'placeholder' in target ? target.placeholder.toLowerCase() : '';
  const maxLength = target && 'maxLength' in target ? target.maxLength : -1;
  const wantsFullYear = placeholder.includes('yyyy') || maxLength === 7 || maxLength === 9;

  return wantsFullYear ? `${paddedMonth}/${fullYear}` : `${paddedMonth}/${shortYear}`;
}

export function fillCardForm(
  anchor: FormFieldElement,
  card: CardPayload,
  options?: { includeCvv?: boolean }
): { filledFields: CardInputKind[] } {
  const fields = findCardFormFields(anchor);
  const filledFields: CardInputKind[] = [];

  if (fields['cc-name'] && card.cardholderName) {
    if (setFieldValue(fields['cc-name'], card.cardholderName, 'cc-name')) {
      filledFields.push('cc-name');
    }
  }

  if (fields['cc-number'] && card.number) {
    if (setFieldValue(fields['cc-number'], card.number, 'cc-number')) {
      filledFields.push('cc-number');
    }
  }

  if (fields['cc-exp'] && card.expMonth && card.expYear) {
    const formatted = formatCardExpiry(card.expMonth, card.expYear, fields['cc-exp']);
    if (formatted && setFieldValue(fields['cc-exp'], formatted, 'cc-exp')) {
      filledFields.push('cc-exp');
    }
  }

  if (fields['cc-exp-month'] && card.expMonth) {
    const monthNum = Number.parseInt(card.expMonth, 10);
    const val = monthNum >= 1 && monthNum <= 12 ? String(monthNum).padStart(2, '0') : card.expMonth;
    if (setFieldValue(fields['cc-exp-month'], val, 'cc-exp-month')) {
      filledFields.push('cc-exp-month');
    }
  }

  if (fields['cc-exp-year'] && card.expYear) {
    if (setFieldValue(fields['cc-exp-year'], card.expYear, 'cc-exp-year')) {
      filledFields.push('cc-exp-year');
    }
  }

  if (fields['cc-type']) {
    const brand = card.brand?.trim() || inferCardBrand(card.number);
    if (brand && setFieldValue(fields['cc-type'], brand, 'cc-type')) {
      filledFields.push('cc-type');
    }
  }

  // Never auto-fill CVV unless explicitly requested by user click
  if (options?.includeCvv === true && fields['cc-csc'] && card.cvv) {
    if (setFieldValue(fields['cc-csc'], card.cvv, 'cc-csc')) {
      filledFields.push('cc-csc');
    }
  }

  return { filledFields };
}

export function fillCardCvv(anchor: FormFieldElement, cvv?: string): boolean {
  const cleanCvv = cvv?.trim();
  if (!cleanCvv) return false;

  const detected = detectInputTarget(anchor);
  if (detected?.kind === 'cc-csc') {
    return setFieldValue(anchor, cleanCvv, 'cc-csc');
  }

  const fields = findCardFormFields(anchor);
  if (fields['cc-csc']) {
    return setFieldValue(fields['cc-csc'], cleanCvv, 'cc-csc');
  }
  return false;
}

function splitFullName(fullName?: string): { first?: string; last?: string } {
  const clean = fullName?.trim();
  if (!clean) return {};
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return {
    first: parts.slice(0, -1).join(' '),
    last: parts[parts.length - 1],
  };
}

export function fillIdentityForm(
  anchor: FormFieldElement,
  identity: IdentityPayload
): { filledFields: IdentityInputKind[] } {
  const fields = findIdentityFormFields(anchor);
  const filledFields: IdentityInputKind[] = [];

  const derivedFullName =
    identity.fullName?.trim() ||
    [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim() ||
    undefined;
  const split = splitFullName(identity.fullName);
  const derivedFirst = identity.firstName?.trim() || split.first;
  const derivedLast = identity.lastName?.trim() || split.last;

  const pairs: Array<[IdentityInputKind, string | undefined]> = [
    ['identity-name', derivedFullName],
    ['identity-given-name', derivedFirst],
    ['identity-family-name', derivedLast],
    ['identity-email', identity.email],
    ['identity-phone', identity.phone],
    ['identity-company', identity.company],
    ['identity-address1', identity.address1],
    ['identity-address2', identity.address2],
    ['identity-city', identity.city],
    ['identity-state', identity.state],
    ['identity-postal', identity.postalCode],
    ['identity-country', identity.country],
  ];

  for (const [kind, val] of pairs) {
    const el = fields[kind];
    if (el && val) {
      if (setFieldValue(el, val, kind)) {
        filledFields.push(kind);
      }
    }
  }

  return { filledFields };
}

export function fillLoginCredentials(
  anchor: HTMLInputElement,
  username?: string,
  password?: string
): { filledUsername: boolean; filledPassword: boolean } {
  const { usernameInput, passwordInput } = findFormFields(anchor);
  let filledUsername = false;
  let filledPassword = false;

  if (usernameInput && username !== undefined) {
    usernameInput.focus();
    setNativeInputValue(usernameInput, username);
    filledUsername = true;
  }
  if (passwordInput && password !== undefined) {
    passwordInput.focus();
    setNativeInputValue(passwordInput, password);
    filledPassword = true;
  }
  return { filledUsername, filledPassword };
}

export function fillOtpTarget(target: DetectedTarget, rawCode: string): boolean {
  const code = rawCode.trim();
  if (!code) return false;

  if (target.kind === 'otp-single') {
    target.anchor.focus();
    setNativeInputValue(target.anchor, code);
    return true;
  }

  if (target.kind !== 'otp-split') {
    return false;
  }

  const boxes = target.boxes;
  if (boxes.length === 0) return false;

  const digitsOnly = code.replace(/[\s-]+/g, '');
  const chars = digitsOnly.slice(0, boxes.length).split('');
  const win = boxes[0].ownerDocument.defaultView;

  // Attempt synthetic paste event on box[0] first if browser supports DataTransfer
  try {
    if (win && typeof win.ClipboardEvent === 'function' && typeof win.DataTransfer === 'function') {
      const dt = new win.DataTransfer();
      dt.setData('text/plain', digitsOnly);
      const pasteEvent = new win.ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      boxes[0].focus();
      boxes[0].dispatchEvent(pasteEvent);
    }
  } catch {
    // Ignore unsupported synthetic ClipboardEvent
  }

  // Verify whether every box is already populated; if not, fill sequentially via native setter
  const alreadyPopulated = chars.every((ch, idx) => boxes[idx]?.value === ch);
  if (!alreadyPopulated) {
    const KeyboardEventCtor = win?.KeyboardEvent ?? KeyboardEvent;
    for (let i = 0; i < chars.length; i++) {
      const box = boxes[i];
      box.focus();
      box.dispatchEvent(new KeyboardEventCtor('keydown', { key: chars[i], bubbles: true }));
      setNativeInputValue(box, chars[i]);
      box.dispatchEvent(new KeyboardEventCtor('keyup', { key: chars[i], bubbles: true }));
    }
    boxes[Math.min(boxes.length - 1, chars.length - 1)].focus();
  }

  return true;
}
