export type DetectedInputKind =
  | 'otp-split'
  | 'otp-single'
  | 'new-password'
  | 'password'
  | 'username';

export type DetectedTarget =
  | { kind: 'otp-split'; anchor: HTMLInputElement; boxes: HTMLInputElement[] }
  | { kind: 'otp-single' | 'new-password' | 'password' | 'username'; anchor: HTMLInputElement };

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

export function isEligibleInput(input: HTMLInputElement): boolean {
  const type = (input.type || 'text').toLowerCase();
  if (NON_TEXT_INPUT_TYPES.has(type)) return false;
  if (input.disabled || input.readOnly) return false;
  try {
    const win = input.ownerDocument.defaultView;
    if (win) {
      const style = win.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }
  } catch {
    // ignore style lookup failure
  }
  return true;
}

function getInputSignalText(input: HTMLInputElement): string {
  const doc = input.ownerDocument;
  let labelText = '';
  if (input.id) {
    try {
      const lbl = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lbl?.textContent) labelText = lbl.textContent;
    } catch {
      // ignore CSS.escape fallback
    }
  }
  return [
    input.name,
    input.id,
    input.autocomplete,
    input.placeholder,
    input.getAttribute('aria-label'),
    input.className,
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
      (el): el is HTMLInputElement =>
        el instanceof input.ownerDocument.defaultView!.HTMLInputElement &&
        isEligibleInput(el) &&
        (el.maxLength === 1 || el.getAttribute('maxlength') === '1')
    );
    if (candidates.length >= 4 && candidates.length <= 8 && candidates.includes(input)) {
      return candidates;
    }
  }
  return null;
}

const OTP_PATTERN =
  /\b(otp|totp|2fa|mfa|one-time-code|passcode|pin|auth.?code|verif(y|ication)?[\s_-]*(code|pin)?)\b|验证码|校验码|动态码|安全码/;
const USERNAME_PATTERN =
  /\b(user(name)?|email|e-mail|login|account|identifier|handle)\b|账号|用户名|邮箱/;

export function detectInputTarget(input: HTMLInputElement): DetectedTarget | null {
  if (!isEligibleInput(input)) return null;

  const splitBoxes = findSplitOtpBoxes(input);
  if (splitBoxes) {
    return { kind: 'otp-split', anchor: input, boxes: splitBoxes };
  }

  const type = (input.type || 'text').toLowerCase();
  const ac = (input.autocomplete || '').toLowerCase();
  const signals = getInputSignalText(input);

  if (ac.includes('one-time-code') || OTP_PATTERN.test(signals)) {
    return { kind: 'otp-single', anchor: input };
  }

  if (type === 'password') {
    if (ac.includes('new-password') || /new[-_\s]?pass|confirm|repeat/i.test(signals)) {
      return { kind: 'new-password', anchor: input };
    }
    return { kind: 'password', anchor: input };
  }

  if (type === 'email' || ac.includes('username') || ac === 'email' || USERNAME_PATTERN.test(signals)) {
    return { kind: 'username', anchor: input };
  }

  // Fallback: if inside a form that has a password input, treat first preceding text input as username
  const form = input.closest('form') ?? input.parentElement?.parentElement;
  if (form && (type === 'text' || type === 'tel')) {
    const pw = form.querySelector('input[type="password"]');
    if (pw) {
      return { kind: 'username', anchor: input };
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
      passwordInput = el;
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
