import React, { useState } from 'react';
import { ExternalLink, Mail, MailPlus, Play, Power, Trash2 } from 'lucide-react';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

const PRESETS = [
  {
    label: 'GitHub 登录验证码',
    from: 'GitHub <noreply@github.com>',
    subject: '[GitHub] Please verify your device',
    text: 'Your GitHub verification code is: 849201\nThis code expires in 10 minutes.',
  },
  {
    label: 'Cursor 邮箱登录码',
    from: 'Cursor <no-reply@cursor.com>',
    subject: 'Sign in to Cursor',
    text: 'Enter this one-time passcode to sign in:\n\n519382\n\nOr open: https://cursor.com/auth/magic?token=demo123',
  },
  {
    label: 'Steam 中文安全码',
    from: 'Steam <noreply@steampowered.com>',
    subject: '您的 Steam 令牌安全验证码',
    text: '您好，您本次登录的验证码为：649-102，请在 5 分钟内输入。',
  },
];

export const EmailOtpView: React.FC = () => {
  const { account, emails, aliases, createAlias, toggleAlias, deleteAlias, simulateEmail, deleteEmail } =
    useVault();
  const [siteInput, setSiteInput] = useState('github.com');
  const [explicitAddr, setExplicitAddr] = useState('');
  const [simFrom, setSimFrom] = useState(PRESETS[0].from);
  const [simTo, setSimTo] = useState(account?.email ?? 'me@example.com');
  const [simSubject, setSimSubject] = useState(PRESETS[0].subject);
  const [simText, setSimText] = useState(PRESETS[0].text);
  const [simResult, setSimResult] = useState<string | null>(null);

  const handleCreateAlias = async (e: React.FormEvent) => {
    e.preventDefault();
    await createAlias({
      siteDomain: siteInput,
      address: explicitAddr.trim() || undefined,
    });
    setExplicitAddr('');
  };

  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSimResult(null);
    const res = await simulateEmail({
      from: simFrom,
      to: simTo,
      subject: simSubject,
      text: simText,
    });
    setSimResult(
      res.accepted
        ? '已通过 X25519 零知识密封入库并通过 WebSocket 实时推送！'
        : `邮件已拦截（原因：${res.reason}）`
    );
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#0b0e14] p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white">邮箱验证码实时中心 & 域名别名</h2>
          <p className="mt-1 text-xs text-slate-400">
            来自 IMAP IDLE 或 Cloudflare Email Worker 的验证码邮件经 X25519 公钥密封存储，仅在本地内存解密展示。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Live Email OTP Stream */}
          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Mail className="h-4 w-4 text-indigo-400" />
                  实时收件流（共 {emails.length} 封）
                </h3>
              </div>

              {emails.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-500">
                  暂无加密邮件。配置右侧 IMAP / Cloudflare Worker，或使用下方模拟器发送测试验证码邮件。
                </div>
              ) : (
                <div className="space-y-3">
                  {emails.map((em) => (
                    <div
                      key={em.id}
                      className="rounded-xl border border-slate-800 bg-[#0d111a] p-4 transition hover:border-slate-700"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 uppercase text-slate-300">
                              {em.source}
                            </span>
                            <span className="font-medium text-slate-200">{em.from}</span>
                            {em.to && <span>→ {em.to}</span>}
                          </div>
                          <div className="mt-1 text-sm font-medium text-white">{em.subject}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void deleteEmail(em.id)}
                          className="rounded p-1 text-slate-500 hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {em.otpCode && (
                        <div className="mt-3 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2">
                          <div>
                            <span className="text-[11px] text-emerald-300">
                              提取验证码 (置信度 {Math.round(em.confidence * 100)}%)
                            </span>
                            <div className="font-mono text-xl font-bold tracking-widest text-white">
                              {em.otpCode}
                            </div>
                          </div>
                          <CopyButton value={em.otpCode} label="复制验证码" />
                        </div>
                      )}

                      {em.magicLink && (
                        <div className="mt-2">
                          <a
                            href={em.magicLink}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:underline"
                          >
                            <span>打开 Magic Link 登录链接</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      )}

                      <p className="mt-2 line-clamp-2 text-xs text-slate-400">{em.snippet}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Simulator */}
            <form
              onSubmit={handleSimulate}
              className="space-y-3 rounded-2xl border border-slate-800 bg-[#121622] p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Play className="h-4 w-4 text-emerald-400" />
                  验证码提取 & WebSocket 推送模拟器
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        setSimFrom(p.from);
                        setSimSubject(p.subject);
                        setSimText(p.text);
                      }}
                      className="rounded-lg border border-slate-700 bg-slate-800/70 px-2 py-1 text-[11px] text-slate-300 hover:border-indigo-500/50"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={simFrom}
                  onChange={(e) => setSimFrom(e.target.value)}
                  placeholder="发件人 From"
                  className="rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none"
                />
                <input
                  type="text"
                  value={simTo}
                  onChange={(e) => setSimTo(e.target.value)}
                  placeholder="收件人 To（可填别名以测试屏蔽开关）"
                  className="rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none"
                />
              </div>
              <input
                type="text"
                value={simSubject}
                onChange={(e) => setSimSubject(e.target.value)}
                placeholder="邮件主题 Subject"
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none"
              />
              <textarea
                rows={3}
                value={simText}
                onChange={(e) => setSimText(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-emerald-300">{simResult}</span>
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  模拟发送并实时推送
                </button>
              </div>
            </form>
          </div>

          {/* Masked Aliases Column */}
          <div className="space-y-4">
            <form
              onSubmit={handleCreateAlias}
              className="space-y-3 rounded-2xl border border-slate-800 bg-[#121622] p-5"
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <MailPlus className="h-4 w-4 text-indigo-400" />
                生成域名邮箱别名
              </h3>
              <input
                type="text"
                value={siteInput}
                onChange={(e) => setSiteInput(e.target.value)}
                placeholder="目标站点域名 (如 cursor.com)"
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none"
              />
              <input
                type="text"
                value={explicitAddr}
                onChange={(e) => setExplicitAddr(e.target.value)}
                placeholder={
                  account?.aliasDomain
                    ? `留空将自动生成 @${account.aliasDomain}`
                    : '输入完整别名地址 (或先配置 aliasDomain)'
                }
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 font-mono text-xs text-white outline-none"
              />
              <button
                type="submit"
                className="w-full rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                创建别名
              </button>
            </form>

            <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
              <h3 className="mb-3 text-sm font-semibold text-white">
                已创建别名 ({aliases.length})
              </h3>
              <div className="space-y-2">
                {aliases.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-xl border border-slate-800 bg-[#0d111a] p-3 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-slate-100">{a.address}</span>
                      <CopyButton value={a.address} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                      <span>收信 {a.receivedCount} 次</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void toggleAlias(a.id, !a.enabled)}
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium ${
                            a.enabled
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-rose-500/15 text-rose-300'
                          }`}
                        >
                          <Power className="h-3 w-3" />
                          {a.enabled ? '接收中' : '已屏蔽'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteAlias(a.id)}
                          className="text-slate-500 hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {aliases.length === 0 && (
                  <p className="text-xs text-slate-500">尚未生成邮箱别名。</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
