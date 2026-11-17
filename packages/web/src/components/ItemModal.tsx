import React, { useState } from 'react';
import { Dices, MailPlus, Plus, Trash2, X } from 'lucide-react';
import {
  generatePassphrase,
  generatePassword,
  randomId,
  type CardDetails,
  type CustomField,
  type IdentityDetails,
  type ItemCategory,
  type VaultItemPayload,
} from '@nonepwd/core';
import { useVault } from '../state/VaultContext';

interface ItemModalProps {
  initialItem: VaultItemPayload | null;
  defaultVaultId: string;
  onClose: () => void;
  onSaved: (item: VaultItemPayload) => void;
}

function cleanCard(card: CardDetails): CardDetails | undefined {
  const cleaned: CardDetails = {
    cardholderName: card.cardholderName?.trim() || undefined,
    number: card.number?.trim() || undefined,
    expMonth: card.expMonth?.trim() || undefined,
    expYear: card.expYear?.trim() || undefined,
    cvv: card.cvv?.trim() || undefined,
    brand: card.brand?.trim() || undefined,
  };
  return Object.values(cleaned).some(Boolean) ? cleaned : undefined;
}

function cleanIdentity(identity: IdentityDetails): IdentityDetails | undefined {
  const cleaned: IdentityDetails = {
    fullName: identity.fullName?.trim() || undefined,
    firstName: identity.firstName?.trim() || undefined,
    lastName: identity.lastName?.trim() || undefined,
    email: identity.email?.trim() || undefined,
    phone: identity.phone?.trim() || undefined,
    company: identity.company?.trim() || undefined,
    address1: identity.address1?.trim() || undefined,
    address2: identity.address2?.trim() || undefined,
    city: identity.city?.trim() || undefined,
    state: identity.state?.trim() || undefined,
    postalCode: identity.postalCode?.trim() || undefined,
    country: identity.country?.trim() || undefined,
  };
  return Object.values(cleaned).some(Boolean) ? cleaned : undefined;
}

export const ItemModal: React.FC<ItemModalProps> = ({
  initialItem,
  defaultVaultId,
  onClose,
  onSaved,
}) => {
  const { vaults, account, saveItem, createAlias } = useVault();
  const isNew = !initialItem;

  const [vaultId, setVaultId] = useState(
    initialItem?.vaultId ?? (defaultVaultId !== 'all' ? defaultVaultId : vaults[0]?.id ?? '')
  );
  const [category, setCategory] = useState<ItemCategory>(initialItem?.category ?? 'login');
  const [title, setTitle] = useState(initialItem?.title ?? '');
  const [urlText, setUrlText] = useState(initialItem?.urls.join('\n') ?? '');
  const [username, setUsername] = useState(initialItem?.username ?? '');
  const [password, setPassword] = useState(initialItem?.password ?? '');
  const [totp, setTotp] = useState(initialItem?.totp ?? '');
  const [emailAlias, setEmailAlias] = useState(initialItem?.emailAlias ?? '');
  const [notes, setNotes] = useState(initialItem?.notes ?? '');
  const [customFields, setCustomFields] = useState<CustomField[]>(initialItem?.customFields ?? []);

  const [card, setCard] = useState<CardDetails>(() => ({
    cardholderName: initialItem?.card?.cardholderName ?? '',
    number: initialItem?.card?.number ?? '',
    expMonth: initialItem?.card?.expMonth ?? '',
    expYear: initialItem?.card?.expYear ?? '',
    cvv: initialItem?.card?.cvv ?? '',
    brand: initialItem?.card?.brand ?? '',
  }));

  const [identity, setIdentity] = useState<IdentityDetails>(() => ({
    fullName: initialItem?.identity?.fullName ?? '',
    firstName: initialItem?.identity?.firstName ?? '',
    lastName: initialItem?.identity?.lastName ?? '',
    email: initialItem?.identity?.email ?? '',
    phone: initialItem?.identity?.phone ?? '',
    company: initialItem?.identity?.company ?? '',
    address1: initialItem?.identity?.address1 ?? '',
    address2: initialItem?.identity?.address2 ?? '',
    city: initialItem?.identity?.city ?? '',
    state: initialItem?.identity?.state ?? '',
    postalCode: initialItem?.identity?.postalCode ?? '',
    country: initialItem?.identity?.country ?? '',
  }));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleGenerateAlias = async () => {
    setErr(null);
    try {
      const site = urlText.split('\n')[0]?.trim() || title.trim() || 'site';
      const alias = await createAlias({
        siteDomain: site,
        vaultId,
      });
      setEmailAlias(alias.address);
      if (!username) setUsername(alias.address);
    } catch (error) {
      setErr(error instanceof Error ? error.message : '生成别名失败，请先在设置中配置别名域名');
    }
  };

  const handleAddField = () => {
    setCustomFields((prev) => [
      ...prev,
      { id: randomId(), label: '', value: '', type: 'concealed' },
    ]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !vaultId) return;
    setBusy(true);
    setErr(null);
    try {
      const now = new Date().toISOString();
      const isCard = category === 'card';
      const isIdentity = category === 'identity';

      const payload: VaultItemPayload = {
        id: initialItem?.id ?? randomId(),
        vaultId,
        category,
        title: title.trim(),
        favorite: initialItem?.favorite ?? false,
        tags: initialItem?.tags ?? [],
        urls:
          isCard || isIdentity
            ? []
            : urlText
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
        username: isCard || isIdentity ? undefined : username.trim() || undefined,
        password: isCard || isIdentity ? undefined : password || undefined,
        totp: isCard || isIdentity ? undefined : totp.trim() || undefined,
        emailAlias: isCard || isIdentity ? undefined : emailAlias.trim() || undefined,
        notes: notes.trim() || undefined,
        card: isCard ? cleanCard(card) : undefined,
        identity: isIdentity ? cleanIdentity(identity) : undefined,
        customFields: customFields.filter((f) => f.label.trim()),
        createdAt: initialItem?.createdAt ?? now,
        updatedAt: now,
      };
      const saved = await saveItem(payload, isNew);
      onSaved(saved);
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl border border-border bg-card text-foreground shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h3 className="text-base font-semibold text-foreground">
            {isNew ? '新建条目' : `编辑条目：${initialItem?.title}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭窗口"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 space-y-4 overflow-y-auto p-6">
          {err && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-600 dark:text-rose-400">
              {err}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                所属密码库
              </label>
              <select
                value={vaultId}
                disabled={!isNew}
                onChange={(e) => setVaultId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring disabled:opacity-60"
              >
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.metadata.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                条目类型
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ItemCategory)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              >
                <option value="login">网站登录 (Login)</option>
                <option value="card">银行卡 (Card)</option>
                <option value="identity">地址身份 (Identity)</option>
                <option value="api_credential">API 密钥 (API Credential)</option>
                <option value="secure_note">安全笔记 (Secure Note)</option>
                <option value="ssh_key">SSH 密钥</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">标题</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                category === 'card'
                  ? '例如 招商银行 Visa'
                  : category === 'identity'
                    ? '例如 家庭收货地址 / 公司信息'
                    : '例如 GitHub / OpenAI / Postgres'
              }
              className="w-full rounded-md border border-input bg-background px-3.5 py-2 text-sm text-foreground outline-none focus:border-ring"
            />
          </div>

          {category === 'card' ? (
            <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">持卡人姓名</label>
                  <input
                    type="text"
                    value={card.cardholderName ?? ''}
                    onChange={(e) => setCard((c) => ({ ...c, cardholderName: e.target.value }))}
                    placeholder="ZHANG SAN"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">发卡组织 / 品牌</label>
                  <input
                    type="text"
                    value={card.brand ?? ''}
                    onChange={(e) => setCard((c) => ({ ...c, brand: e.target.value }))}
                    placeholder="Visa / Mastercard / UnionPay"
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">卡号</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={card.number ?? ''}
                  onChange={(e) => setCard((c) => ({ ...c, number: e.target.value }))}
                  placeholder="4242 4242 4242 4242"
                  className={`${inputClass} font-mono`}
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">有效期月 (MM)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={2}
                    value={card.expMonth ?? ''}
                    onChange={(e) => setCard((c) => ({ ...c, expMonth: e.target.value }))}
                    placeholder="08"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">有效期年 (YYYY)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={card.expYear ?? ''}
                    onChange={(e) => setCard((c) => ({ ...c, expYear: e.target.value }))}
                    placeholder="2028"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">安全码 (CVV)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={card.cvv ?? ''}
                    onChange={(e) => setCard((c) => ({ ...c, cvv: e.target.value }))}
                    placeholder="123"
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>
            </div>
          ) : category === 'identity' ? (
            <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">全名</label>
                  <input
                    type="text"
                    value={identity.fullName ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, fullName: e.target.value }))}
                    placeholder="张三"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">名 (First)</label>
                  <input
                    type="text"
                    value={identity.firstName ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, firstName: e.target.value }))}
                    placeholder="San"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">姓 (Last)</label>
                  <input
                    type="text"
                    value={identity.lastName ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, lastName: e.target.value }))}
                    placeholder="Zhang"
                    className={inputClass}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">邮箱</label>
                  <input
                    type="email"
                    value={identity.email ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, email: e.target.value }))}
                    placeholder="name@example.com"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">电话</label>
                  <input
                    type="tel"
                    value={identity.phone ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, phone: e.target.value }))}
                    placeholder="+86 13800138000"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">公司</label>
                  <input
                    type="text"
                    value={identity.company ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, company: e.target.value }))}
                    placeholder="可选"
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">地址行 1</label>
                <input
                  type="text"
                  value={identity.address1 ?? ''}
                  onChange={(e) => setIdentity((d) => ({ ...d, address1: e.target.value }))}
                  placeholder="街道、门牌号"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">地址行 2</label>
                <input
                  type="text"
                  value={identity.address2 ?? ''}
                  onChange={(e) => setIdentity((d) => ({ ...d, address2: e.target.value }))}
                  placeholder="楼栋、单元、室（可选）"
                  className={inputClass}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">城市</label>
                  <input
                    type="text"
                    value={identity.city ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, city: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">省 / 州</label>
                  <input
                    type="text"
                    value={identity.state ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, state: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">邮编</label>
                  <input
                    type="text"
                    value={identity.postalCode ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, postalCode: e.target.value }))}
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">国家 / 地区</label>
                  <input
                    type="text"
                    value={identity.country ?? ''}
                    onChange={(e) => setIdentity((d) => ({ ...d, country: e.target.value }))}
                    placeholder="CN / US"
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    用户名 / 邮箱
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="alex@example.com"
                    className="w-full rounded-md border border-input bg-background px-3.5 py-2 text-sm text-foreground outline-none focus:border-ring"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">域名邮箱别名</label>
                    {account?.aliasDomain && (
                      <button
                        type="button"
                        onClick={handleGenerateAlias}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground underline underline-offset-4 hover:opacity-75"
                      >
                        <MailPlus className="h-3 w-3" /> 一键生成别名
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={emailAlias}
                    onChange={(e) => setEmailAlias(e.target.value)}
                    placeholder={
                      account?.aliasDomain ? `site.xxxxx@${account.aliasDomain}` : '可选'
                    }
                    className="w-full rounded-md border border-input bg-background px-3.5 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">密码 / 密钥</label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setPassword(generatePassword({ length: 20 }))}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground underline underline-offset-4 hover:opacity-75"
                    >
                      <Dices className="h-3 w-3" /> 随机强密码
                    </button>
                    <button
                      type="button"
                      onClick={() => setPassword(generatePassphrase({ words: 4 }))}
                      className="text-[11px] font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    >
                      易记短语
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入或点击右上角生成"
                  className="w-full rounded-md border border-input bg-background px-3.5 py-2 font-mono text-sm text-foreground outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  2FA TOTP 密钥或 otpauth:// URI
                </label>
                <input
                  type="text"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  placeholder="JBSWY3DPEHPK3PXP 或 otpauth://totp/..."
                  className="w-full rounded-md border border-input bg-background px-3.5 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  网址 URL（每行一个，用于站点匹配）
                </label>
                <textarea
                  rows={2}
                  value={urlText}
                  onChange={(e) => setUrlText(e.target.value)}
                  placeholder="https://github.com/login"
                  className="w-full rounded-md border border-input bg-background px-3.5 py-2 text-xs text-foreground outline-none focus:border-ring"
                />
              </div>
            </>
          )}

          {/* Custom Fields */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">自定义字段</label>
              <button
                type="button"
                onClick={handleAddField}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground underline underline-offset-4 hover:opacity-75"
              >
                <Plus className="h-3 w-3" /> 添加字段
              </button>
            </div>
            <div className="space-y-2">
              {customFields.map((cf, idx) => (
                <div key={cf.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="字段名 (如 api_key)"
                    value={cf.label}
                    onChange={(e) => {
                      const next = [...customFields];
                      next[idx] = { ...cf, label: e.target.value };
                      setCustomFields(next);
                    }}
                    className="w-1/3 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-ring"
                  />
                  <input
                    type="text"
                    placeholder="值"
                    value={cf.value}
                    onChange={(e) => {
                      const next = [...customFields];
                      next[idx] = { ...cf, value: e.target.value };
                      setCustomFields(next);
                    }}
                    className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomFields((p) => p.filter((x) => x.id !== cf.id))}
                    className="rounded-md p-1.5 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">备注</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3.5 py-2 text-xs text-foreground outline-none focus:border-ring"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-muted"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-primary px-5 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
            >
              {busy ? '正在加密保存...' : '保存条目'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
