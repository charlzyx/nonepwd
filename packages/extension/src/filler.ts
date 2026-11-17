import { findFormFields, type DetectedTarget } from './detector.js';

export function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const win = input.ownerDocument.defaultView;
  const proto = win ? win.HTMLInputElement.prototype : HTMLInputElement.prototype;
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
