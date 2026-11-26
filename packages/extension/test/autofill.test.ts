import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { classifyCapturedCredential, urlsMatchWithLocalhost } from '../src/capture.js';
import { POPOVER_CSS } from '../src/content.js';
import {
  detectInputTarget,
  extractSubmittedLogin,
  findFormFields,
  isVisibleElement,
} from '../src/detector.js';
import {
  fillCardCvv,
  fillCardForm,
  fillIdentityForm,
  fillLoginCredentials,
  fillOtpTarget,
  formatCardDisplay,
} from '../src/filler.js';
import {
  loadInlineBadgeHidden,
  loadPopupActiveTab,
  loadUnlockDuration,
  nextThemePreference,
  normalizeThemePreference,
  resolveIsDark,
  saveInlineBadgeHidden,
  savePopupActiveTab,
  saveUnlockDuration,
  unlockDurationToMs,
} from '../src/theme.js';

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

  it('detects and fills credit card forms with <select> month/year and never auto-fills CVV without click', () => {
    const dom = new JSDOM(`
      <form id="cc-form">
        <input id="cc-name" autocomplete="cc-name" />
        <input id="cc-num" autocomplete="cc-number" />
        <select id="cc-month" autocomplete="cc-exp-month">
          <option value="">Month</option>
          <option value="01">01</option>
          <option value="04">04 - April</option>
          <option value="12">12</option>
        </select>
        <select id="cc-year" autocomplete="cc-exp-year">
          <option value="">Year</option>
          <option value="2027">2027</option>
          <option value="2028">2028</option>
        </select>
        <select id="cc-type" autocomplete="cc-type">
          <option value="">Type</option>
          <option value="visa">Visa</option>
          <option value="mastercard">Mastercard</option>
        </select>
        <input id="cc-cvv" autocomplete="cc-csc" />
      </form>
    `);
    const doc = dom.window.document;
    const ccName = doc.getElementById('cc-name') as HTMLInputElement;
    const ccNum = doc.getElementById('cc-num') as HTMLInputElement;
    const ccMonth = doc.getElementById('cc-month') as HTMLSelectElement;
    const ccYear = doc.getElementById('cc-year') as HTMLSelectElement;
    const ccType = doc.getElementById('cc-type') as HTMLSelectElement;
    const ccCvv = doc.getElementById('cc-cvv') as HTMLInputElement;

    expect(detectInputTarget(ccName)?.kind).toBe('cc-name');
    expect(detectInputTarget(ccNum)?.kind).toBe('cc-number');
    expect(detectInputTarget(ccMonth)?.kind).toBe('cc-exp-month');
    expect(detectInputTarget(ccYear)?.kind).toBe('cc-exp-year');
    expect(detectInputTarget(ccType)?.kind).toBe('cc-type');
    expect(detectInputTarget(ccCvv)?.kind).toBe('cc-csc');

    const events: string[] = [];
    ccNum.addEventListener('input', () => events.push('num:input'));
    ccMonth.addEventListener('change', () => events.push('month:change'));
    ccYear.addEventListener('change', () => events.push('year:change'));

    const card = {
      cardholderName: 'ZHANG SAN',
      number: '4111 1111 1111 4242',
      expMonth: '4',
      expYear: '2028',
      cvv: '789',
      brand: 'Visa',
    };

    expect(formatCardDisplay(card).label).toBe('Visa •••• 4242');

    const res = fillCardForm(ccNum, card);
    expect(res.filledFields).toContain('cc-name');
    expect(res.filledFields).toContain('cc-number');
    expect(res.filledFields).toContain('cc-exp-month');
    expect(res.filledFields).toContain('cc-exp-year');
    expect(res.filledFields).toContain('cc-type');
    expect(res.filledFields).not.toContain('cc-csc');

    expect(ccName.value).toBe('ZHANG SAN');
    expect(ccNum.value).toBe('4111 1111 1111 4242');
    expect(ccMonth.value).toBe('04');
    expect(ccYear.value).toBe('2028');
    expect(ccType.value).toBe('visa');
    expect(ccCvv.value).toBe('');
    expect(events).toEqual(['num:input', 'month:change', 'year:change']);

    // Explicit click-initiated CVV fill
    expect(fillCardCvv(ccCvv, card.cvv)).toBe(true);
    expect(ccCvv.value).toBe('789');
  });

  it('detects Chinese credit card heuristics & combined MM/YY expiry', () => {
    const dom = new JSDOM(`
      <form>
        <input id="holder" placeholder="持卡人姓名" />
        <input id="num" placeholder="请输入银行卡号" />
        <input id="exp" placeholder="有效期 MM/YY" />
        <input id="csc" placeholder="背面三位安全码" />
      </form>
    `);
    const doc = dom.window.document;
    const holder = doc.getElementById('holder') as HTMLInputElement;
    const num = doc.getElementById('num') as HTMLInputElement;
    const exp = doc.getElementById('exp') as HTMLInputElement;
    const csc = doc.getElementById('csc') as HTMLInputElement;

    expect(detectInputTarget(holder)?.kind).toBe('cc-name');
    expect(detectInputTarget(num)?.kind).toBe('cc-number');
    expect(detectInputTarget(exp)?.kind).toBe('cc-exp');
    expect(detectInputTarget(csc)?.kind).toBe('cc-csc');

    fillCardForm(num, {
      cardholderName: 'LI SI',
      number: '5500000000001234',
      expMonth: '09',
      expYear: '2029',
      cvv: '321',
    });

    expect(holder.value).toBe('LI SI');
    expect(num.value).toBe('5500000000001234');
    expect(exp.value).toBe('09/29');
    expect(csc.value).toBe('');
  });

  it('detects unlabeled month/year <select> inside card form and supports MM/YYYY expiry', () => {
    const dom = new JSDOM(`
      <form>
        <input id="num" name="cardNumber" />
        <select id="m">
          <option value="">MM</option>
          <option value="1">01</option>
          <option value="2">02</option>
          <option value="3">03</option>
          <option value="4">04</option>
          <option value="5">05</option>
          <option value="6">06</option>
          <option value="7">07</option>
          <option value="8">08</option>
          <option value="9">09</option>
          <option value="10">10</option>
          <option value="11">11</option>
          <option value="12">12</option>
        </select>
        <select id="y">
          <option value="">YYYY</option>
          <option value="2026">2026</option>
          <option value="2027">2027</option>
          <option value="2028">2028</option>
          <option value="2029">2029</option>
        </select>
        <input id="exp-full" name="expiry" placeholder="MM/YYYY" />
      </form>
    `);
    const doc = dom.window.document;
    const num = doc.getElementById('num') as HTMLInputElement;
    const m = doc.getElementById('m') as HTMLSelectElement;
    const y = doc.getElementById('y') as HTMLSelectElement;
    const expFull = doc.getElementById('exp-full') as HTMLInputElement;

    expect(detectInputTarget(m)?.kind).toBe('cc-exp-month');
    expect(detectInputTarget(y)?.kind).toBe('cc-exp-year');

    fillCardForm(num, {
      number: '6222000000008888',
      expMonth: '04',
      expYear: '2028',
    });

    expect(m.value).toBe('4');
    expect(y.value).toBe('2028');
    expect(expFull.value).toBe('04/2028');
  });

  it('detects and fills English autocomplete address/identity forms including <select>', () => {
    const dom = new JSDOM(`
      <form id="shipping">
        <input id="fn" autocomplete="given-name" />
        <input id="ln" autocomplete="family-name" />
        <input id="em" type="email" autocomplete="email" />
        <input id="ph" type="tel" autocomplete="tel" />
        <input id="co" autocomplete="organization" />
        <input id="a1" autocomplete="address-line1" />
        <input id="a2" autocomplete="address-line2" />
        <input id="ct" autocomplete="address-level2" />
        <input id="st" autocomplete="address-level1" />
        <input id="zp" autocomplete="postal-code" />
        <select id="cn" autocomplete="country">
          <option value="">Select country</option>
          <option value="US">United States</option>
          <option value="CN">China</option>
        </select>
      </form>
    `);
    const doc = dom.window.document;
    const fn = doc.getElementById('fn') as HTMLInputElement;
    const ln = doc.getElementById('ln') as HTMLInputElement;
    const em = doc.getElementById('em') as HTMLInputElement;
    const ph = doc.getElementById('ph') as HTMLInputElement;
    const co = doc.getElementById('co') as HTMLInputElement;
    const a1 = doc.getElementById('a1') as HTMLInputElement;
    const a2 = doc.getElementById('a2') as HTMLInputElement;
    const ct = doc.getElementById('ct') as HTMLInputElement;
    const st = doc.getElementById('st') as HTMLInputElement;
    const zp = doc.getElementById('zp') as HTMLInputElement;
    const cn = doc.getElementById('cn') as HTMLSelectElement;

    expect(detectInputTarget(fn)?.kind).toBe('identity-given-name');
    expect(detectInputTarget(ln)?.kind).toBe('identity-family-name');
    expect(detectInputTarget(em)?.kind).toBe('identity-email');
    expect(detectInputTarget(ph)?.kind).toBe('identity-phone');
    expect(detectInputTarget(co)?.kind).toBe('identity-company');
    expect(detectInputTarget(a1)?.kind).toBe('identity-address1');
    expect(detectInputTarget(a2)?.kind).toBe('identity-address2');
    expect(detectInputTarget(ct)?.kind).toBe('identity-city');
    expect(detectInputTarget(st)?.kind).toBe('identity-state');
    expect(detectInputTarget(zp)?.kind).toBe('identity-postal');
    expect(detectInputTarget(cn)?.kind).toBe('identity-country');

    let countryChangeCount = 0;
    cn.addEventListener('change', () => countryChangeCount++);

    fillIdentityForm(a1, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+86 13800138000',
      company: 'Analytical Engine Co',
      address1: '88 Jianguo Road',
      address2: 'Suite 402',
      city: 'Beijing',
      state: 'Beijing',
      postalCode: '100022',
      country: '中国',
    });

    expect(fn.value).toBe('Ada');
    expect(ln.value).toBe('Lovelace');
    expect(em.value).toBe('ada@example.com');
    expect(ph.value).toBe('+86 13800138000');
    expect(co.value).toBe('Analytical Engine Co');
    expect(a1.value).toBe('88 Jianguo Road');
    expect(a2.value).toBe('Suite 402');
    expect(ct.value).toBe('Beijing');
    expect(st.value).toBe('Beijing');
    expect(zp.value).toBe('100022');
    expect(cn.value).toBe('CN');
    expect(countryChangeCount).toBe(1);
  });

  it('detects and fills Chinese address forms (姓名/手机/省/市/区/详细地址/邮编)', () => {
    const dom = new JSDOM(`
      <form>
        <input id="zh-name" placeholder="姓名" />
        <input id="zh-phone" placeholder="手机" />
        <select id="zh-prov" name="province">
          <option value="">省</option>
          <option value="北京市">北京市</option>
          <option value="上海市">上海市</option>
        </select>
        <input id="zh-city" placeholder="市" />
        <input id="zh-dist" placeholder="区" />
        <input id="zh-addr" placeholder="详细地址" />
        <input id="zh-zip" placeholder="邮编" />
      </form>
    `);
    const doc = dom.window.document;
    const nameEl = doc.getElementById('zh-name') as HTMLInputElement;
    const phoneEl = doc.getElementById('zh-phone') as HTMLInputElement;
    const provEl = doc.getElementById('zh-prov') as HTMLSelectElement;
    const cityEl = doc.getElementById('zh-city') as HTMLInputElement;
    const distEl = doc.getElementById('zh-dist') as HTMLInputElement;
    const addrEl = doc.getElementById('zh-addr') as HTMLInputElement;
    const zipEl = doc.getElementById('zh-zip') as HTMLInputElement;

    expect(detectInputTarget(nameEl)?.kind).toBe('identity-name');
    expect(detectInputTarget(phoneEl)?.kind).toBe('identity-phone');
    expect(detectInputTarget(provEl)?.kind).toBe('identity-state');
    expect(detectInputTarget(cityEl)?.kind).toBe('identity-city');
    expect(detectInputTarget(distEl)?.kind).toBe('identity-address2');
    expect(detectInputTarget(addrEl)?.kind).toBe('identity-address1');
    expect(detectInputTarget(zipEl)?.kind).toBe('identity-postal');

    fillIdentityForm(nameEl, {
      fullName: '张三',
      phone: '13912345678',
      state: '上海',
      city: '上海市',
      address2: '浦东新区',
      address1: '世纪大道 100 号',
      postalCode: '200120',
    });

    expect(nameEl.value).toBe('张三');
    expect(phoneEl.value).toBe('13912345678');
    expect(provEl.value).toBe('上海市');
    expect(cityEl.value).toBe('上海市');
    expect(distEl.value).toBe('浦东新区');
    expect(addrEl.value).toBe('世纪大道 100 号');
    expect(zipEl.value).toBe('200120');
  });

  it('defaults theme to light, cycles light/dark/system, and provides CSS variables for both themes', () => {
    expect(normalizeThemePreference(undefined)).toBe('light');
    expect(resolveIsDark('light')).toBe(false);
    expect(resolveIsDark('dark')).toBe(true);
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
    expect(nextThemePreference('system')).toBe('light');

    expect(POPOVER_CSS).toContain('--np-bg: #ffffff');
    expect(POPOVER_CSS).toContain(':host([data-theme="dark"])');
    expect(POPOVER_CSS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('extracts submitted login credentials, handles 2-step fallback usernames, prefers new-password, and ignores CVV', () => {
    const dom = new JSDOM(`
      <form id="login-form">
        <input id="u" type="email" autocomplete="username" />
        <input id="p" type="password" autocomplete="current-password" />
      </form>
      <form id="pw-change">
        <input id="cur-pw" type="password" autocomplete="current-password" />
        <input id="new-pw" type="password" autocomplete="new-password" />
      </form>
      <form id="two-step">
        <input id="step2-pw" type="password" autocomplete="current-password" />
      </form>
      <form id="card-form">
        <input id="cvv" type="password" autocomplete="cc-csc" />
      </form>
    `);
    const doc = dom.window.document;

    (doc.getElementById('u') as HTMLInputElement).value = 'alice@example.com';
    (doc.getElementById('p') as HTMLInputElement).value = 'FirstPass!123';
    expect(extractSubmittedLogin(doc.getElementById('login-form')!)).toEqual({
      username: 'alice@example.com',
      password: 'FirstPass!123',
    });

    (doc.getElementById('cur-pw') as HTMLInputElement).value = 'OldPass!123';
    (doc.getElementById('new-pw') as HTMLInputElement).value = 'BrandNew!999';
    expect(extractSubmittedLogin(doc.getElementById('pw-change')!, 'alice@example.com')).toEqual({
      username: 'alice@example.com',
      password: 'BrandNew!999',
    });

    (doc.getElementById('step2-pw') as HTMLInputElement).value = 'StepTwoPass!';
    expect(extractSubmittedLogin(doc.getElementById('two-step')!, 'step1@example.com')).toEqual({
      username: 'step1@example.com',
      password: 'StepTwoPass!',
    });

    (doc.getElementById('cvv') as HTMLInputElement).value = '482';
    expect(extractSubmittedLogin(doc.getElementById('card-form')!)).toBeNull();
  });

  it('classifies captured credentials as create, update, or skip accurately', () => {
    const items = [
      {
        id: 'item-1',
        vaultId: 'v-1',
        category: 'login' as const,
        title: 'Example',
        favorite: false,
        tags: [],
        urls: ['https://app.example.com/login'],
        username: 'alice@example.com',
        password: 'SavedPassword!1',
        customFields: [],
        createdAt: '2026-11-17T00:00:00Z',
        updatedAt: '2026-11-17T00:00:00Z',
      },
    ];

    expect(
      classifyCapturedCredential({
        url: 'https://login.example.com/auth',
        username: 'alice@example.com',
        password: 'SavedPassword!1',
        items,
      }).action
    ).toBe('skip');

    const updateRes = classifyCapturedCredential({
      url: 'https://example.com/settings',
      username: 'Alice@Example.com',
      password: 'RotatedPassword!2',
      items,
    });
    expect(updateRes.action).toBe('update');
    if (updateRes.action === 'update') {
      expect(updateRes.existingItem.id).toBe('item-1');
    }

    const createRes = classifyCapturedCredential({
      url: 'https://brandnew.dev/signup',
      username: 'bob@brandnew.dev',
      password: 'BrandNewPass!3',
      items,
    });
    expect(createRes.action).toBe('create');
    if (createRes.action === 'create') {
      expect(createRes.host).toBe('brandnew.dev');
      expect(createRes.originUrl).toBe('https://brandnew.dev');
    }

    expect(
      classifyCapturedCredential({
        url: 'https://ignored.site/login',
        username: 'bob',
        password: 'Secret!',
        items,
        neverSaveDomains: ['ignored.site'],
      }).action
    ).toBe('skip');
  });

  it('uses borderless pill CSS on overlay inputs/buttons and persists inline badge visibility preference', async () => {
    expect(POPOVER_CSS).toContain('.np-badge-wrap');
    expect(POPOVER_CSS).toContain('.np-badge-close');
    expect(POPOVER_CSS).toMatch(/\.np-save-input[\s\S]*border-radius:\s*999px/);
    expect(POPOVER_CSS).toMatch(/\.np-save-input:focus[\s\S]*box-shadow:\s*none/);
    expect(POPOVER_CSS).toMatch(/\.np-save-btn[\s\S]*border-radius:\s*999px/);

    const store: Record<string, unknown> = {};
    const prevChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          },
        },
      },
    };
    try {
      expect(await loadInlineBadgeHidden()).toBe(false);
      await saveInlineBadgeHidden(true);
      expect(await loadInlineBadgeHidden()).toBe(true);
      await saveInlineBadgeHidden(false);
      expect(await loadInlineBadgeHidden()).toBe(false);

      expect(await loadPopupActiveTab()).toBeNull();
      await savePopupActiveTab('2fa');
      expect(await loadPopupActiveTab()).toBe('2fa');
      await savePopupActiveTab('site');
      expect(await loadPopupActiveTab()).toBe('site');

      expect(unlockDurationToMs('3h')).toBe(3 * 3600_000);
      expect(unlockDurationToMs('24h')).toBe(24 * 3600_000);
      expect(unlockDurationToMs('7d')).toBe(7 * 86400_000);
      expect(unlockDurationToMs('session')).toBeNull();
      expect(await loadUnlockDuration()).toBe('24h');
      await saveUnlockDuration('3h');
      expect(await loadUnlockDuration()).toBe('3h');
      await saveUnlockDuration('session');
      expect(await loadUnlockDuration()).toBe('session');
    } finally {
      (globalThis as { chrome?: unknown }).chrome = prevChrome;
    }
  });

  it('enforces port isolation on localhost/127.0.0.1 and rejects HTTPS -> HTTP downgrades in urlsMatchWithLocalhost', () => {
    // HTTPS -> HTTP downgrade must be rejected
    expect(urlsMatchWithLocalhost('http://example.com/login', 'https://example.com/login')).toBe(
      false
    );
    expect(urlsMatchWithLocalhost('http://localhost:8787', 'https://localhost:8787')).toBe(false);

    // Same HTTPS protocol or HTTP -> HTTPS upgrade continues to match
    expect(urlsMatchWithLocalhost('https://app.example.com/login', 'https://example.com')).toBe(
      true
    );
    expect(urlsMatchWithLocalhost('https://example.com/login', 'http://example.com/login')).toBe(
      true
    );
    // Stored bare domain (e.g. email senderDomain) still matches
    expect(urlsMatchWithLocalhost('http://example.com/login', 'example.com')).toBe(true);

    // Localhost/127.0.0.1 port isolation when stored URL specifies an explicit port
    expect(urlsMatchWithLocalhost('http://localhost:3000', 'http://127.0.0.1:8787')).toBe(false);
    expect(urlsMatchWithLocalhost('http://localhost', 'http://127.0.0.1:8787')).toBe(false);
    expect(urlsMatchWithLocalhost('http://localhost:8787', 'http://127.0.0.1:8787')).toBe(true);
    expect(urlsMatchWithLocalhost('http://127.0.0.1:8787/auth', 'http://localhost:8787/login')).toBe(
      true
    );
    // Localhost never matches non-localhost
    expect(urlsMatchWithLocalhost('http://localhost:8787', 'http://example.com:8787')).toBe(false);
  });

  it('rejects invisible or near-transparent inputs and tiny elements while preserving JSDOM 0x0 fallback', () => {
    const dom = new JSDOM(`
      <form>
        <input id="normal" type="password" autocomplete="current-password" />
        <input id="zero-opacity" type="password" autocomplete="current-password" style="opacity: 0" />
        <input id="faint-opacity" type="password" autocomplete="current-password" style="opacity: 0.05" />
        <input id="visible-opacity" type="password" autocomplete="current-password" style="opacity: 0.5" />
        <input id="tiny" type="password" autocomplete="current-password" />
        <input id="sized" type="password" autocomplete="current-password" />
      </form>
    `);
    const doc = dom.window.document;
    const normal = doc.getElementById('normal') as HTMLInputElement;
    const zeroOpacity = doc.getElementById('zero-opacity') as HTMLInputElement;
    const faintOpacity = doc.getElementById('faint-opacity') as HTMLInputElement;
    const visibleOpacity = doc.getElementById('visible-opacity') as HTMLInputElement;
    const tiny = doc.getElementById('tiny') as HTMLInputElement;
    const sized = doc.getElementById('sized') as HTMLInputElement;

    // JSDOM default 0x0 rect fallback still considered visible
    expect(isVisibleElement(normal)).toBe(true);
    expect(detectInputTarget(normal)?.kind).toBe('password');

    // opacity <= 0.05 must be rejected
    expect(isVisibleElement(zeroOpacity)).toBe(false);
    expect(detectInputTarget(zeroOpacity)).toBeNull();
    expect(isVisibleElement(faintOpacity)).toBe(false);
    expect(detectInputTarget(faintOpacity)).toBeNull();

    // opacity > 0.05 is allowed
    expect(isVisibleElement(visibleOpacity)).toBe(true);
    expect(detectInputTarget(visibleOpacity)?.kind).toBe('password');

    // Non-zero bounding rect smaller than 20x12 is rejected
    tiny.getBoundingClientRect = () =>
      ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(isVisibleElement(tiny)).toBe(false);
    expect(detectInputTarget(tiny)).toBeNull();

    // Non-zero bounding rect >= 20x12 is accepted
    sized.getBoundingClientRect = () =>
      ({ width: 160, height: 32, top: 0, left: 0, right: 160, bottom: 32, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(isVisibleElement(sized)).toBe(true);
    expect(detectInputTarget(sized)?.kind).toBe('password');
  });
});
