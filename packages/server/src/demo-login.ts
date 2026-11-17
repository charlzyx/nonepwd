export const DEMO_LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>nonepwd 多步登录与 6 宫格验证码测试沙盒</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0e14;
      --card: #141925;
      --border: #263044;
      --accent: #6366f1;
      --text: #eef2ff;
      --muted: #94a3b8;
      --ok: #10b981;
    }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
    body {
      margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #182036 0%, var(--bg) 60%);
      color: var(--text); display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border);
      border-radius: 16px; padding: 28px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-block; font-size: 12px; padding: 4px 10px; border-radius: 999px;
      background: rgba(99, 102, 241, 0.16); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.35);
      margin-bottom: 12px;
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p.sub { font-size: 13px; color: var(--muted); margin: 0 0 20px; line-height: 1.5; }
    label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
    input[type="text"], input[type="email"], input[type="password"] {
      width: 100%; padding: 11px 13px; border-radius: 10px; border: 1px solid var(--border);
      background: #0d111a; color: var(--text); font-size: 14px; outline: none; margin-bottom: 14px;
    }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); }
    .btn {
      width: 100%; padding: 11px 16px; border: 0; border-radius: 10px; background: var(--accent);
      color: white; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 6px;
    }
    .btn:hover { background: #5558e6; }
    .btn.secondary {
      background: transparent; border: 1px solid var(--border); color: var(--muted); margin-top: 10px;
    }
    .otp-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 14px 0 18px; }
    .otp-box {
      height: 52px; text-align: center; font-size: 22px; font-weight: 700; letter-spacing: 1px;
      border-radius: 10px; border: 1px solid var(--border); background: #0d111a; color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; outline: none;
    }
    .otp-box:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); }
    .hidden { display: none; }
    .success-box {
      padding: 16px; border-radius: 12px; background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.35); color: #6ee7b7; font-size: 14px; line-height: 1.5;
    }
    .hint { font-size: 12px; color: var(--muted); margin-top: 16px; border-top: 1px solid var(--border); padding-top: 14px; }
    code { background: #0d111a; padding: 2px 6px; border-radius: 6px; color: #c7d2fe; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">nonepwd Autofill Playground</span>
    <div id="step-1">
      <h1>第 1 步：账号密码登录</h1>
      <p class="sub">先在 nonepwd 中保存一条 URL 为当前地址（例如 <code>http://localhost:8787</code>）的登录条目，点击下方输入框体验闭合 Shadow DOM 内联自动填充。</p>
      <form id="login-form">
        <label for="email">邮箱 / 用户名</label>
        <input id="email" name="username" type="email" autocomplete="username" placeholder="alex@example.com" required />

        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="输入或通过 nonepwd 自动填充" required />

        <button class="btn" type="submit">继续下一步验证 →</button>
      </form>
      <button class="btn secondary" id="jump-signup" type="button">切换到注册页（测试密码生成 + 别名填充）</button>
    </div>

    <div id="step-signup" class="hidden">
      <h1>注册新账号（新密码 + 邮箱别名）</h1>
      <p class="sub">聚焦下方「新密码」框，点击浮窗中的一键生成强密码与邮箱别名。</p>
      <form id="signup-form">
        <label for="reg-email">邮箱 / 别名</label>
        <input id="reg-email" name="email" type="email" autocomplete="email" placeholder="自动填入生成的别名邮箱" required />

        <label for="reg-password">新密码</label>
        <input id="reg-password" name="new-password" type="password" autocomplete="new-password" placeholder="点击 nonepwd 生成并保存" required />

        <button class="btn" type="submit">创建测试账号</button>
      </form>
      <button class="btn secondary" id="back-login" type="button">← 返回登录页</button>
    </div>

    <div id="step-2" class="hidden">
      <h1>第 2 步：安全验证码（6 宫格接力）</h1>
      <p class="sub">nonepwd 已记录上一步填充的账号。现在可以直接在 6 宫格中填入 TOTP 2FA，或在 Web 端点击「模拟收到验证码邮件」体验实时 WebSocket 推送填充。</p>
      <form id="otp-form">
        <label>6 位动态验证码 / 邮箱验证码</label>
        <div class="otp-grid" id="otp-grid">
          <input class="otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code" aria-label="Digit 1" />
          <input class="otp-box" type="text" inputmode="numeric" maxlength="1" aria-label="Digit 2" />
          <input class="otp-box" type="text" inputmode="numeric" maxlength="1" aria-label="Digit 3" />
          <input class="otp-box" type="text" inputmode="numeric" maxlength="1" aria-label="Digit 4" />
          <input class="otp-box" type="text" inputmode="numeric" maxlength="1" aria-label="Digit 5" />
          <input class="otp-box" type="text" inputmode="numeric" maxlength="1" aria-label="Digit 6" />
        </div>
        <button class="btn" type="submit">验证并完成登录</button>
      </form>
      <button class="btn secondary" id="back-step1" type="button">← 返回第 1 步</button>
    </div>

    <div id="step-done" class="hidden">
      <h1>登录成功</h1>
      <div class="success-box" id="result-msg"></div>
      <button class="btn secondary" id="reset-demo" type="button">重新测试</button>
    </div>

    <div class="hint">
      提示：此页面托管于 <code>/demo-login</code>，可用于离线验证多步登录接力、TOTP 与 6 宫格邮箱验证码自动填充。
    </div>
  </div>

  <script>
    const step1 = document.getElementById('step-1');
    const stepSignup = document.getElementById('step-signup');
    const step2 = document.getElementById('step-2');
    const stepDone = document.getElementById('step-done');
    const boxes = Array.from(document.querySelectorAll('.otp-box'));

    function show(el) {
      [step1, stepSignup, step2, stepDone].forEach(s => s.classList.add('hidden'));
      el.classList.remove('hidden');
    }

    document.getElementById('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      show(step2);
      setTimeout(() => boxes[0].focus(), 50);
    });

    document.getElementById('signup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('reg-email').value;
      document.getElementById('result-msg').textContent = '已模拟完成注册：' + email;
      show(stepDone);
    });

    document.getElementById('otp-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = boxes.map(b => b.value).join('');
      const user = document.getElementById('email').value;
      document.getElementById('result-msg').textContent =
        '账号 ' + user + ' 已通过 2FA/OTP 验证（输入码：' + code + '）！';
      show(stepDone);
    });

    boxes.forEach((box, idx) => {
      box.addEventListener('input', () => {
        if (box.value.length > 1) {
          const chars = box.value.replace(/\\D/g, '').slice(0, 6).split('');
          chars.forEach((ch, cIdx) => { if (boxes[cIdx]) boxes[cIdx].value = ch; });
          boxes[Math.min(5, chars.length - 1)]?.focus();
          return;
        }
        if (box.value && idx < boxes.length - 1) {
          boxes[idx + 1].focus();
        }
      });
      box.addEventListener('paste', (e) => {
        const pasted = (e.clipboardData?.getData('text') || '').replace(/\\D/g, '').slice(0, 6);
        if (pasted) {
          e.preventDefault();
          pasted.split('').forEach((ch, cIdx) => { if (boxes[cIdx]) boxes[cIdx].value = ch; });
          boxes[Math.min(5, pasted.length - 1)]?.focus();
        }
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && idx > 0) {
          boxes[idx - 1].focus();
        }
      });
    });

    document.getElementById('jump-signup').onclick = () => show(stepSignup);
    document.getElementById('back-login').onclick = () => show(step1);
    document.getElementById('back-step1').onclick = () => show(step1);
    document.getElementById('reset-demo').onclick = () => {
      boxes.forEach(b => (b.value = ''));
      show(step1);
    };
  </script>
</body>
</html>`;
