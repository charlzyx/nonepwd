import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { detectInputTarget, findFormFields } from '../src/detector.js';
import { fillLoginCredentials, fillOtpTarget } from '../src/filler.js';

describe('@nonepwd/extension DOM detection & autofill', () => {
  it('detects username/password pairs and fires native input/change events for React controlled forms', () => {
    const dom = new JSDOM(`
      <form id="login">
        <label for="user">Email</label>
        <input id="user" name="username" type="email" autocomplete="username" />
        <label for="pass">Password</label>
        <input id="pass" name="password" type="password" autocomplete="current-password" />
      </form>
    `);
    const doc = dom.window.document;
    const userInput = doc.getElementById('user') as HTMLInputElement;
    const passInput = doc.getElementById('pass') as HTMLInputElement;

    expect(detectInputTarget(userInput)?.kind).toBe('username');
    expect(detectInputTarget(passInput)?.kind).toBe('password');

    const pair = findFormFields(passInput);
    expect(pair.usernameInput).toBe(userInput);
    expect(pair.passwordInput).toBe(passInput);

    let inputEvents = 0;
    let changeEvents = 0;
    userInput.addEventListener('input', () => inputEvents++);
    passInput.addEventListener('change', () => changeEvents++);

    const filled = fillLoginCredentials(userInput, 'alex@example.com', 'S3cr3tPass!');
    expect(filled).toEqual({ filledUsername: true, filledPassword: true });
    expect(userInput.value).toBe('alex@example.com');
    expect(passInput.value).toBe('S3cr3tPass!');
    expect(inputEvents).toBe(1);
    expect(changeEvents).toBe(1);
  });

  it('detects new-password signup fields and single-field OTP inputs', () => {
    const dom = new JSDOM(`
      <form>
        <input id="reg-pw" type="password" autocomplete="new-password" />
        <input id="otp-single" type="text" autocomplete="one-time-code" />
      </form>
    `);
    const regPw = dom.window.document.getElementById('reg-pw') as HTMLInputElement;
    const otpSingle = dom.window.document.getElementById('otp-single') as HTMLInputElement;

    expect(detectInputTarget(regPw)?.kind).toBe('new-password');
    const otpTarget = detectInputTarget(otpSingle)!;
    expect(otpTarget.kind).toBe('otp-single');
    expect(fillOtpTarget(otpTarget, '482910')).toBe(true);
    expect(otpSingle.value).toBe('482910');
  });

  it('detects 6-box <input maxlength="1"> split OTP grids and populates every cell cleanly', () => {
    const dom = new JSDOM(`
      <form id="otp-form">
        <div class="otp-grid">
          <input class="otp-box" maxlength="1" inputmode="numeric" />
          <input class="otp-box" maxlength="1" inputmode="numeric" />
          <input class="otp-box" maxlength="1" inputmode="numeric" />
          <input class="otp-box" maxlength="1" inputmode="numeric" />
          <input class="otp-box" maxlength="1" inputmode="numeric" />
          <input class="otp-box" maxlength="1" inputmode="numeric" />
        </div>
      </form>
    `);
    const boxes = Array.from(dom.window.document.querySelectorAll('.otp-box')) as HTMLInputElement[];
    const target = detectInputTarget(boxes[0])!;
    expect(target.kind).toBe('otp-split');
    if (target.kind === 'otp-split') {
      expect(target.boxes).toHaveLength(6);
    }

    const boxEvents: string[] = [];
    boxes.forEach((b, idx) => {
      b.addEventListener('input', () => boxEvents.push(`${idx}:${b.value}`));
    });

    expect(fillOtpTarget(target, '839-204')).toBe(true);
    expect(boxes.map((b) => b.value).join('')).toBe('839204');
    expect(boxEvents).toEqual(['0:8', '1:3', '2:9', '3:2', '4:0', '5:4']);
  });
});
