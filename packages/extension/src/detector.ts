export type CardInputKind =
  | 'cc-name'
  | 'cc-number'
  | 'cc-exp'
  | 'cc-exp-month'
  | 'cc-exp-year'
  | 'cc-csc'
  | 'cc-type';

export type IdentityInputKind =
  | 'identity-name'
  | 'identity-given-name'
  | 'identity-family-name'
  | 'identity-email'
  | 'identity-phone'
  | 'identity-company'
  | 'identity-address1'
  | 'identity-address2'
  | 'identity-city'
  | 'identity-state'
  | 'identity-postal'
  | 'identity-country';

export type DetectedInputKind =
  | 'otp-split'
  | 'otp-single'
  | 'new-password'
  | 'password'
  | 'username'
  | CardInputKind
  | IdentityInputKind;

export type FormFieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export type DetectedTarget =
  | { kind: 'otp-split'; anchor: HTMLInputElement; boxes: HTMLInputElement[] }
  | { kind: 'otp-single' | 'new-password' | 'password' | 'username'; anchor: HTMLInputElement }
  | { kind: CardInputKind | IdentityInputKind; anchor: FormFieldElement };

const NON_TEXT_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'reset',
  'checkbox',
  'radio',
  'file',
  'image',
  'range',
  'color',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

export function isCardKind(kind: DetectedInputKind): kind is CardInputKind {
  return kind.startsWith('cc-');
}

export function isIdentityKind(kind: DetectedInputKind): kind is IdentityInputKind {
  return kind.startsWith('identity-');
}

function isInputElement(el: Element): el is HTMLInputElement {
  const win = el.ownerDocument.defaultView;
  return win?.HTMLInputElement ? el instanceof win.HTMLInputElement : el.tagName === 'INPUT';
}

function isSelectElement(el: Element): el is HTMLSelectElement {
  const win = el.ownerDocument.defaultView;
  return win?.HTMLSelectElement ? el instanceof win.HTMLSelectElement : el.tagName === 'SELECT';
}

function isTextAreaElement(el: Element): el is HTMLTextAreaElement {
  const win = el.ownerDocument.defaultView;
  return win?.HTMLTextAreaElement ? el instanceof win.HTMLTextAreaElement : el.tagName === 'TEXTAREA';
}

export function isVisibleElement(el: HTMLElement): boolean {
  try {
    const win = el.ownerDocument.defaultView;
    if (win) {
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      const opacity = Number.parseFloat(style.opacity || '1');
      if (Number.isFinite(opacity) && opacity <= 0.05) {
        return false;
      }
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if ((rect.width > 0 || rect.height > 0) && (rect.width < 20 || rect.height < 12)) {
        return false;
      }
    }
  } catch {
    // ignore style lookup failure
  }
  return true;
}

export function isEligibleInput(input: HTMLInputElement): boolean {
  const type = (input.type || 'text').toLowerCase();
  if (NON_TEXT_INPUT_TYPES.has(type)) return false;
  if (input.disabled || input.readOnly) return false;
  return isVisibleElement(input);
}

export function isEligibleField(el: Element): el is FormFieldElement {
  if (isInputElement(el)) return isEligibleInput(el);
  if (isSelectElement(el)) return !el.disabled && isVisibleElement(el);
  if (isTextAreaElement(el)) return !el.disabled && !el.readOnly && isVisibleElement(el);
  return false;
}

function getAutocompleteTokens(el: FormFieldElement): string[] {
  const raw = (el.getAttribute('autocomplete') || ('autocomplete' in el ? el.autocomplete : '') || '')
    .trim()
    .toLowerCase();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function getFieldSignalText(el: FormFieldElement): string {
  const doc = el.ownerDocument;
  let labelText = '';
  if (el.id) {
    try {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.textContent) labelText = lbl.textContent;
    } catch {
      // ignore CSS.escape fallback
    }
  }
  if (!labelText) {
    const wrappingLabel = el.closest('label');
    if (wrappingLabel && wrappingLabel.querySelectorAll('input, select, textarea').length <= 1) {
      labelText = wrappingLabel.textContent ?? '';
    }
  }

  return [
    el.name,
    el.id,
    el.getAttribute('autocomplete'),
    'placeholder' in el ? el.placeholder : '',
    el.getAttribute('aria-label'),
    el.className,
    labelText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function findSplitOtpBoxes(input: HTMLInputElement): HTMLInputElement[] | null {
  const maxLenAttr = input.getAttribute('maxlength');
  const isSingleChar = input.maxLength === 1 || maxLenAttr === '1';
  if (!isSingleChar) return null;

  const containers = [input.parentElement, input.parentElement?.parentElement, input.closest('form')];
  for (const container of containers) {
    if (!container) continue;
    const candidates = Array.from(container.querySelectorAll('input')).filter(
      (el): el is HTMLInputElement => isInputElement(el) && isEligibleInput(el) && (el.maxLength === 1 || el.getAttribute('maxlength') === '1')
    );
    if (candidates.length >= 4 && candidates.length <= 8 && candidates.includes(input)) {
      return candidates;
    }
  }
  return null;
}

export function findFormScope(anchor: FormFieldElement): ParentNode {
  const form = anchor.closest('form');
  if (form) return form;

  let cur: HTMLElement | null = anchor.parentElement;
  let best: HTMLElement | null = null;
  for (let depth = 0; depth < 4 && cur && cur !== anchor.ownerDocument.body; depth++) {
    const count = cur.querySelectorAll('input, select, textarea').length;
    if (count >= 2) {
      best = cur;
      if (count >= 3) break;
    }
    cur = cur.parentElement;
  }
  return best ?? anchor.parentElement?.parentElement ?? anchor.ownerDocument.body ?? anchor.ownerDocument;
}

const OTP_PATTERN =
  /\b(otp|totp|2fa|mfa|one-time-code|passcode|pin|auth.?code|verif(y|ication)?[\s_-]*(code|pin)?)\b|验证码|校验码|动态码/;
const USERNAME_PATTERN =
  /\b(user(name)?|login|account|identifier|handle)\b|账号|用户名/;
const EMAIL_PATTERN = /\b(e-?mail)\b|邮箱/;

const CC_CSC_PATTERN =
  /\b(cc[-_\s]?csc|cvv2?|cvc2?|csc|cid|card[-_\s]?security[-_\s]?code|security[-_\s]?code)\b|安全码|背面三位|卡背面/i;
const CC_NUMBER_PATTERN =
  /\b(card[-_\s]?num(ber)?|cc[-_\s]?num(ber)?|credit[-_\s]?card[-_\s]?num(ber)?|debit[-_\s]?card[-_\s]?num(ber)?)\b|卡号|银行卡号|信用卡号/i;
const CC_EXP_MONTH_PATTERN =
  /\b(cc[-_\s]?exp[-_\s]?month|exp(iry|iration)?[-_\s]?month|card[-_\s]?month)\b|有效期.*月|到期月/i;
const CC_EXP_YEAR_PATTERN =
  /\b(cc[-_\s]?exp[-_\s]?year|exp(iry|iration)?[-_\s]?year|card[-_\s]?year)\b|有效期.*年|到期年/i;
const CC_EXP_PATTERN =
  /\b(cc[-_\s]?exp(iry|iration)?|exp(iry|iration)?[-_\s]?date|valid[-_\s]?thru|mm\s*\/\s*yy(yy)?)\b|有效期|到期日|截止日期/i;
const CC_NAME_PATTERN =
  /\b(card[-_\s]?holder|cardholder|name[-_\s]?on[-_\s]?card|cc[-_\s]?name|card[-_\s]?name)\b|持卡人|持卡人姓名/i;
const CC_TYPE_PATTERN = /\b(cc[-_\s]?type|card[-_\s]?type|card[-_\s]?brand)\b|卡种|发卡行|卡品牌/i;

const IDENTITY_GIVEN_NAME_PATTERN = /\b(first[-_\s]?name|given[-_\s]?name|fname)\b/i;
const IDENTITY_FAMILY_NAME_PATTERN = /\b(last[-_\s]?name|family[-_\s]?name|surname|lname)\b|姓氏/i;
const IDENTITY_NAME_PATTERN =
  /\b(full[-_\s]?name|recipient|contact[-_\s]?name|your[-_\s]?name)\b|姓名|收件人|联系人/i;
const IDENTITY_PHONE_PATTERN = /\b(phone|mobile|tel(ephone)?|cell)\b|手机|手机号|手机号码|电话|联系电话/i;
const IDENTITY_COMPANY_PATTERN = /\b(company|organization|org)\b|公司|公司名称|单位/i;
const IDENTITY_ADDRESS2_PATTERN =
  /\b(address[-_\s]?line[-_\s]?2|address[-_\s]?2|addr2|apt|suite|unit|floor|building|district)\b|门牌|楼层|单元|补充地址|地址2|区\/?县|行政区|所在区|(?<![\u4e00-\u9fa5])区(?![\u4e00-\u9fa5])/i;
const IDENTITY_ADDRESS1_PATTERN =
  /\b(street[-_\s]?address|address[-_\s]?line[-_\s]?1|address[-_\s]?1|addr1|street)\b|详细地址|街道地址|收货地址|通信地址|地址1|(?<![\u4e00-\u9fa5])地址(?![\u4e00-\u9fa5])/i;
const IDENTITY_POSTAL_PATTERN = /\b(postal[-_\s]?code|post[-_\s]?code|zip[-_\s]?code|zip)\b|邮编|邮政编码/i;
const IDENTITY_STATE_PATTERN =
  /\b(state|province|region|prefecture|address[-_\s]?level[-_\s]?1)\b|省份|所在省|省\/?直辖市|(?<![\u4e00-\u9fa5])省(?![\u4e00-\u9fa5])/i;
const IDENTITY_CITY_PATTERN =
  /\b(city|town|locality|address[-_\s]?level[-_\s]?2)\b|城市|所在市|地级市|(?<![\u4e00-\u9fa5])市(?![\u4e00-\u9fa5])/i;
const IDENTITY_COUNTRY_PATTERN = /\b(country|country[-_\s]?name|nation)\b|国家\/地区|国家/i;

function detectCardByAutocomplete(acTokens: string[]): CardInputKind | null {
  if (acTokens.includes('cc-csc')) return 'cc-csc';
  if (acTokens.includes('cc-number')) return 'cc-number';
  if (acTokens.includes('cc-exp-month')) return 'cc-exp-month';
  if (acTokens.includes('cc-exp-year')) return 'cc-exp-year';
  if (acTokens.includes('cc-exp')) return 'cc-exp';
  if (
    acTokens.includes('cc-name') ||
    acTokens.includes('cc-given-name') ||
    acTokens.includes('cc-family-name') ||
    acTokens.includes('cc-additional-name')
  ) {
    return 'cc-name';
  }
  if (acTokens.includes('cc-type')) return 'cc-type';
  return null;
}

function detectIdentityByAutocomplete(acTokens: string[]): IdentityInputKind | null {
  if (acTokens.includes('given-name')) return 'identity-given-name';
  if (acTokens.includes('family-name')) return 'identity-family-name';
  if (acTokens.includes('name')) return 'identity-name';
  if (acTokens.includes('tel') || acTokens.includes('tel-national') || acTokens.includes('tel-local')) {
    return 'identity-phone';
  }
  if (acTokens.includes('organization')) return 'identity-company';
  if (acTokens.includes('address-line2')) return 'identity-address2';
  if (acTokens.includes('street-address') || acTokens.includes('address-line1')) return 'identity-address1';
  if (acTokens.includes('address-level2')) return 'identity-city';
  if (acTokens.includes('address-level1')) return 'identity-state';
  if (acTokens.includes('postal-code')) return 'identity-postal';
  if (acTokens.includes('country') || acTokens.includes('country-name')) return 'identity-country';
  return null;
}

function detectCardByHeuristics(signals: string): CardInputKind | null {
  if (CC_CSC_PATTERN.test(signals) && !/\b(otp|totp|2fa|mfa)\b|验证码|动态码/.test(signals)) {
    return 'cc-csc';
  }
  if (CC_NUMBER_PATTERN.test(signals)) return 'cc-number';
  if (CC_EXP_MONTH_PATTERN.test(signals)) return 'cc-exp-month';
  if (CC_EXP_YEAR_PATTERN.test(signals)) return 'cc-exp-year';
  if (CC_EXP_PATTERN.test(signals)) return 'cc-exp';
  if (CC_NAME_PATTERN.test(signals)) return 'cc-name';
  if (CC_TYPE_PATTERN.test(signals)) return 'cc-type';
  return null;
}

function detectIdentityByHeuristics(
  el: FormFieldElement,
  signals: string,
  hasPasswordField: boolean
): IdentityInputKind | null {
  const type = isInputElement(el) ? (el.type || 'text').toLowerCase() : '';

  if (type === 'tel' || IDENTITY_PHONE_PATTERN.test(signals)) return 'identity-phone';
  if (IDENTITY_COMPANY_PATTERN.test(signals)) return 'identity-company';
  if (IDENTITY_ADDRESS2_PATTERN.test(signals)) return 'identity-address2';
  if (
    IDENTITY_ADDRESS1_PATTERN.test(signals) &&
    !/邮箱地址|邮件地址|网址|服务器地址|ip地址/.test(signals)
  ) {
    return 'identity-address1';
  }
  if (IDENTITY_POSTAL_PATTERN.test(signals)) return 'identity-postal';
  if (IDENTITY_COUNTRY_PATTERN.test(signals)) return 'identity-country';
  if (IDENTITY_STATE_PATTERN.test(signals)) return 'identity-state';
  if (IDENTITY_CITY_PATTERN.test(signals)) return 'identity-city';
  if (IDENTITY_GIVEN_NAME_PATTERN.test(signals)) return 'identity-given-name';
  if (IDENTITY_FAMILY_NAME_PATTERN.test(signals)) return 'identity-family-name';
  if (IDENTITY_NAME_PATTERN.test(signals)) return 'identity-name';

  if (!hasPasswordField && !USERNAME_PATTERN.test(signals)) {
    const cleanName = (el.name || '').trim().toLowerCase();
    const cleanId = (el.id || '').trim().toLowerCase();
    if (cleanName === 'name' || cleanId === 'name' || cleanName === 'full_name' || cleanName === 'fullname') {
      return 'identity-name';
    }
  }
  return null;
}

function detectSelectExpiryFallback(select: HTMLSelectElement): 'cc-exp-month' | 'cc-exp-year' | null {
  const options = Array.from(select.options)
    .map((o) => o.value.trim() || (o.textContent || '').trim())
    .filter((v) => v.length > 0 && !/^(month|year|mm|yy|yyyy|月|年|请选择)/i.test(v));

  if (options.length === 12) {
    const nums = options.map((v) => Number.parseInt(v, 10));
    if (nums.every((n, i) => n === i + 1)) {
      return 'cc-exp-month';
    }
  }
  if (options.length >= 4 && options.length <= 30) {
    const allYears = options.every((v) => /^(20\d{2}|[2-5]\d)$/.test(v));
    if (allYears) {
      return 'cc-exp-year';
    }
  }
  return null;
}

function scopeHasCardSignal(scope: ParentNode, exclude: Element): boolean {
  const fields = Array.from(scope.querySelectorAll('input, select'));
  for (const f of fields) {
    if (f === exclude || !isEligibleField(f)) continue;
    const ac = getAutocompleteTokens(f);
    if (detectCardByAutocomplete(ac)) return true;
    const sig = getFieldSignalText(f);
    if (detectCardByHeuristics(sig)) return true;
  }
  return false;
}

function scopeHasNonEmailIdentitySignal(scope: ParentNode, exclude: Element): boolean {
  const fields = Array.from(scope.querySelectorAll('input, select, textarea'));
  for (const f of fields) {
    if (f === exclude || !isEligibleField(f)) continue;
    const ac = getAutocompleteTokens(f);
    if (detectIdentityByAutocomplete(ac)) return true;
    const sig = getFieldSignalText(f);
    if (detectIdentityByHeuristics(f, sig, false)) return true;
  }
  return false;
}

export function detectInputTarget(el: FormFieldElement): DetectedTarget | null {
  if (!isEligibleField(el)) return null;

  if (isInputElement(el)) {
    const splitBoxes = findSplitOtpBoxes(el);
    if (splitBoxes) {
      return { kind: 'otp-split', anchor: el, boxes: splitBoxes };
    }
  }

  const type = isInputElement(el) ? (el.type || 'text').toLowerCase() : '';
  const acTokens = getAutocompleteTokens(el);
  const signals = getFieldSignalText(el);

  if (isInputElement(el) && acTokens.includes('one-time-code')) {
    return { kind: 'otp-single', anchor: el };
  }

  // 1. Credit card autocomplete & heuristics (before OTP/password so cc-csc / 安全码 isn't misclassified)
  const ccByAc = detectCardByAutocomplete(acTokens);
  if (ccByAc) {
    return { kind: ccByAc, anchor: el };
  }

  const ccByHeuristic = detectCardByHeuristics(signals);
  if (ccByHeuristic) {
    return { kind: ccByHeuristic, anchor: el };
  }

  // 2. OTP single field
  if (isInputElement(el) && OTP_PATTERN.test(signals)) {
    return { kind: 'otp-single', anchor: el };
  }

  // 3. Password fields
  if (isInputElement(el) && type === 'password') {
    if (acTokens.includes('new-password') || /new[-_\s]?pass|confirm|repeat/i.test(signals)) {
      return { kind: 'new-password', anchor: el };
    }
    return { kind: 'password', anchor: el };
  }

  // 4. Explicit identity autocomplete tokens
  const idByAc = detectIdentityByAutocomplete(acTokens);
  if (idByAc) {
    return { kind: idByAc, anchor: el };
  }

  const scope = findFormScope(el);
  const hasPasswordField = Boolean(scope.querySelector('input[type="password"]'));

  // 5. Select expiry month/year fallback when inside a card form
  if (isSelectElement(el) && scopeHasCardSignal(scope, el)) {
    const selectKind = detectSelectExpiryFallback(el);
    if (selectKind) {
      return { kind: selectKind, anchor: el };
    }
  }

  // 6. Explicit username autocomplete
  if (isInputElement(el) && acTokens.includes('username')) {
    return { kind: 'username', anchor: el };
  }

  // 7. Identity/address heuristics
  const idByHeuristic = detectIdentityByHeuristics(el, signals, hasPasswordField);
  if (idByHeuristic) {
    return { kind: idByHeuristic, anchor: el };
  }

  // 8. Email / Username disambiguation
  if (isInputElement(el)) {
    const isEmailSignal = type === 'email' || acTokens.includes('email') || EMAIL_PATTERN.test(signals);
    if (isEmailSignal || USERNAME_PATTERN.test(signals)) {
      if (
        isEmailSignal &&
        !hasPasswordField &&
        !USERNAME_PATTERN.test(signals) &&
        (scopeHasNonEmailIdentitySignal(scope, el) ||
          /\b(billing|shipping|contact)[-_.\s]?e?mail\b|联系邮箱|收件人邮箱/i.test(signals))
      ) {
        return { kind: 'identity-email', anchor: el };
      }
      return { kind: 'username', anchor: el };
    }

    // Fallback: if inside a form that has a password input, treat text/tel input as username
    const loginForm = el.closest('form') ?? el.parentElement?.parentElement;
    if (loginForm && (type === 'text' || type === 'tel')) {
      const pw = loginForm.querySelector('input[type="password"]');
      if (pw) {
        return { kind: 'username', anchor: el };
      }
    }
  }

  return null;
}

export function findFormFields(anchor: HTMLInputElement): {
  usernameInput: HTMLInputElement | null;
  passwordInput: HTMLInputElement | null;
} {
  const scope = anchor.closest('form') ?? anchor.parentElement?.parentElement ?? anchor.ownerDocument.body;
  const allInputs = Array.from(scope.querySelectorAll('input')).filter(isEligibleInput);

  let usernameInput: HTMLInputElement | null = null;
  let passwordInput: HTMLInputElement | null = null;

  for (const el of allInputs) {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'password' && !passwordInput) {
      const target = detectInputTarget(el);
      if (!target || target.kind === 'password' || target.kind === 'new-password') {
        passwordInput = el;
      }
    } else if (!usernameInput) {
      const target = detectInputTarget(el);
      if (target?.kind === 'username') {
        usernameInput = el;
      }
    }
  }

  if (!usernameInput && anchor.type.toLowerCase() !== 'password') {
    usernameInput = anchor;
  }
  if (!passwordInput && anchor.type.toLowerCase() === 'password') {
    passwordInput = anchor;
  }

  return { usernameInput, passwordInput };
}

export function extractSubmittedLogin(
  scope: ParentNode,
  fallbackUsername?: string
): { username: string; password: string } | null {
  const inputs = Array.from(scope.querySelectorAll('input')).filter(isInputElement);
  const candidates = inputs.filter((el) => {
    const type = (el.type || '').toLowerCase();
    if (type !== 'password') return false;
    if (el.disabled || el.readOnly || !el.value) return false;
    const detected = detectInputTarget(el);
    if (
      detected &&
      (detected.kind === 'cc-csc' ||
        detected.kind === 'otp-single' ||
        detected.kind === 'otp-split')
    ) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  const chosenPwInput =
    candidates.find((el) => detectInputTarget(el)?.kind === 'new-password') ?? candidates[0];

  let { usernameInput } = findFormFields(chosenPwInput);
  if (!usernameInput || !usernameInput.value.trim()) {
    const scopeUser = inputs.find((el) => {
      if (el === chosenPwInput || el.disabled || el.readOnly || !el.value.trim()) return false;
      const t = detectInputTarget(el);
      return t?.kind === 'username' || t?.kind === 'identity-email';
    });
    if (scopeUser) {
      usernameInput = scopeUser;
    }
  }

  const username = (usernameInput?.value ?? '').trim() || (fallbackUsername ?? '').trim();
  return { username, password: chosenPwInput.value };
}

export function findCardFormFields(
  anchor: FormFieldElement
): Partial<Record<CardInputKind, FormFieldElement>> {
  const scope = findFormScope(anchor);
  const allFields = Array.from(scope.querySelectorAll('input, select, textarea')).filter(isEligibleField);
  const result: Partial<Record<CardInputKind, FormFieldElement>> = {};

  for (const el of allFields) {
    const target = detectInputTarget(el);
    if (target && isCardKind(target.kind) && !result[target.kind]) {
      result[target.kind] = el;
    }
  }

  const anchorTarget = detectInputTarget(anchor);
  if (anchorTarget && isCardKind(anchorTarget.kind) && !result[anchorTarget.kind]) {
    result[anchorTarget.kind] = anchor;
  }

  return result;
}

export function findIdentityFormFields(
  anchor: FormFieldElement
): Partial<Record<IdentityInputKind, FormFieldElement>> {
  const scope = findFormScope(anchor);
  const allFields = Array.from(scope.querySelectorAll('input, select, textarea')).filter(isEligibleField);
  const result: Partial<Record<IdentityInputKind, FormFieldElement>> = {};
  const hasPasswordField = Boolean(scope.querySelector('input[type="password"]'));

  for (const el of allFields) {
    const target = detectInputTarget(el);
    if (target && isIdentityKind(target.kind) && !result[target.kind]) {
      result[target.kind] = el;
    } else if (
      !hasPasswordField &&
      !result['identity-email'] &&
      target?.kind === 'username' &&
      isInputElement(el) &&
      ((el.type || '').toLowerCase() === 'email' ||
        getAutocompleteTokens(el).includes('email') ||
        EMAIL_PATTERN.test(getFieldSignalText(el)))
    ) {
      result['identity-email'] = el;
    }
  }

  const anchorTarget = detectInputTarget(anchor);
  if (anchorTarget && isIdentityKind(anchorTarget.kind) && !result[anchorTarget.kind]) {
    result[anchorTarget.kind] = anchor;
  }

  return result;
}
