import React, { useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, KeyRound, Lock, Upload, X } from 'lucide-react';
import {
  detectImportFormat,
  parseAuthenticatorExport,
  parsePasswordCsv,
  planTotpImport,
  type CsvImportedEntry,
  type ImportFormat,
  type TotpImportEntry,
} from '@nonepwd/core';
import { useVault } from '../state/VaultContext';

interface ImportCsvModalProps {
  defaultVaultId: string;
  onClose: () => void;
}

type ImportSummary =
  | { kind: 'csv'; total: number; imported: number; skipped: number }
  | { kind: 'totp'; total: number; attached: number; created: number; skipped: number };

export const ImportCsvModal: React.FC<ImportCsvModalProps> = ({ defaultVaultId, onClose }) => {
  const { vaults, items, importCsvItems, importTotpItems } = useVault();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initialVaultId = useMemo(() => {
    if (defaultVaultId !== 'all' && vaults.some((v) => v.id === defaultVaultId)) {
      return defaultVaultId;
    }
    return (
      vaults.find((v) => v.metadata.name.toLowerCase() === 'personal')?.id ?? vaults[0]?.id ?? ''
    );
  }, [defaultVaultId, vaults]);

  const [mode, setMode] = useState<ImportFormat>('csv');
  const [vaultId, setVaultId] = useState(initialVaultId);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [csvEntries, setCsvEntries] = useState<CsvImportedEntry[]>([]);
  const [totpEntries, setTotpEntries] = useState<TotpImportEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);

  const resetParsed = () => {
    setRawText(null);
    setCsvEntries([]);
    setTotpEntries([]);
    setErr(null);
    setResult(null);
  };

  const handleModeChange = (next: ImportFormat) => {
    setMode(next);
    setFileName(null);
    setPasteText('');
    resetParsed();
  };

  const parseContent = (text: string, targetMode: ImportFormat, name?: string) => {
    setErr(null);
    setResult(null);
    if (targetMode === 'csv') {
      const entries = parsePasswordCsv(text);
      if (entries.length === 0) {
        setFileName(name ?? null);
        setRawText(null);
        setCsvEntries([]);
        setTotpEntries([]);
        setErr('未在 CSV 中检测到有效的账号密码条目。');
        return;
      }
      setFileName(name ?? null);
      setRawText(text);
      setCsvEntries(entries);
      setTotpEntries([]);
    } else {
      const entries = parseAuthenticatorExport(text);
      if (entries.length === 0) {
        setFileName(name ?? null);
        setRawText(null);
        setCsvEntries([]);
        setTotpEntries([]);
        setErr('未检测到有效的 2FA 验证器条目（支持 otpauth://、Google 迁移码或 Aegis/2FAS JSON）。');
        return;
      }
      setFileName(name ?? null);
      setRawText(text);
      setTotpEntries(entries);
      setCsvEntries([]);
    }
  };

  const loadFile = async (file: File) => {
    setErr(null);
    setResult(null);
    try {
      const text = await file.text();
      const lowerName = file.name.toLowerCase();
      let targetMode: ImportFormat = mode;
      if (lowerName.endsWith('.txt') || lowerName.endsWith('.json')) {
        targetMode = 'totp';
      } else if (lowerName.endsWith('.csv')) {
        targetMode = 'csv';
      } else {
        targetMode = detectImportFormat(text);
      }
      setMode(targetMode);
      setPasteText('');
      parseContent(text, targetMode, file.name);
    } catch (error) {
      setFileName(file.name);
      setRawText(null);
      setCsvEntries([]);
      setTotpEntries([]);
      setErr(error instanceof Error ? error.message : '文件解析失败');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void loadFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void loadFile(file);
    }
  };

  const handlePasteChange = (next: string) => {
    setPasteText(next);
    setFileName(null);
    if (!next.trim()) {
      resetParsed();
      return;
    }
    try {
      parseContent(next, 'totp');
    } catch (error) {
      setRawText(null);
      setTotpEntries([]);
      setErr(error instanceof Error ? error.message : '2FA 内容解析失败');
    }
  };

  const totpPlanPreview = useMemo(() => {
    if (mode !== 'totp' || totpEntries.length === 0 || !vaultId) return [];
    const vaultItems = items.filter((i) => i.vaultId === vaultId);
    try {
      return planTotpImport(vaultItems, totpEntries);
    } catch {
      return totpEntries.map((entry) => ({
        entry,
        action: 'create' as const,
        title: entry.issuer || entry.account || '2FA',
        username: entry.account,
        totp: entry.otpauthUri,
      }));
    }
  }, [items, mode, totpEntries, vaultId]);

  const handleImport = async () => {
    if (!vaultId || !rawText) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'csv') {
        if (csvEntries.length === 0) return;
        const summary = await importCsvItems({
          vaultId,
          csvText: rawText,
          skipDuplicates,
        });
        setResult({ kind: 'csv', ...summary });
      } else {
        if (totpEntries.length === 0) return;
        const summary = await importTotpItems({
          vaultId,
          text: rawText,
        });
        setResult({ kind: 'totp', ...summary });
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const readyCount = mode === 'csv' ? csvEntries.length : totpEntries.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl border border-border bg-card text-foreground shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            {mode === 'csv' ? (
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            ) : (
              <KeyRound className="h-4 w-4 text-muted-foreground" />
            )}
            <h3 className="text-base font-semibold text-foreground">
              {mode === 'csv' ? '导入浏览器密码 CSV' : '导入 2FA 验证器'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭导入窗口"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {/* Format tabs */}
          {!result && (
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1">
              <button
                type="button"
                onClick={() => handleModeChange('csv')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'csv'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                浏览器密码 (.csv)
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('totp')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'totp'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                2FA 验证器 (.txt / .json)
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>本地浏览器 WASM 解析并 AES-256-GCM 加密，明文仅在内存处理。</span>
          </div>

          {err && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              {err}
            </div>
          )}

          {result ? (
            <div className="space-y-4 rounded-lg border border-border bg-background p-5 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              {result.kind === 'csv' ? (
                <div>
                  <h4 className="text-sm font-semibold text-foreground">
                    已成功加密导入 {result.imported} 条密码
                  </h4>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    共解析 {result.total} 条 · 跳过重复 {result.skipped} 条
                  </p>
                </div>
              ) : (
                <div>
                  <h4 className="text-sm font-semibold text-foreground">2FA 验证器导入完成</h4>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    共 {result.total} 条 · 已关联 {result.attached} · 新建 {result.created} · 跳过{' '}
                    {result.skipped}
                  </p>
                </div>
              )}
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85"
                >
                  完成
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  目标密码库
                </label>
                <select
                  value={vaultId}
                  onChange={(e) => setVaultId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
                >
                  {vaults.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.metadata.name}
                    </option>
                  ))}
                </select>
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
                  dragging
                    ? 'border-foreground bg-muted/60'
                    : 'border-border bg-background hover:bg-muted/40'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={
                    mode === 'csv'
                      ? '.csv,.txt,.json,text/csv,text/plain,application/json'
                      : '.txt,.json,.csv,text/plain,application/json,text/csv'
                  }
                  onChange={handleFileChange}
                  className="hidden"
                />
                <Upload className="mb-2 h-5 w-5 text-muted-foreground" />
                <div className="text-xs font-medium text-foreground">
                  {fileName
                    ? `已选择：${fileName}`
                    : mode === 'csv'
                      ? '点击选择或拖拽导出的 CSV 文件到此处'
                      : '点击选择或拖拽 2FA 导出文件 (.txt / .json)'}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {mode === 'csv'
                    ? '兼容 Chrome / Brave / Edge / Arc / Safari / Bitwarden / 1Password 导出的 .csv'
                    : '支持 otpauth:// 行文本、Google Authenticator otpauth-migration://、Aegis / 2FAS JSON'}
                </p>
              </div>

              {mode === 'totp' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    或直接粘贴导出文本
                  </label>
                  <textarea
                    rows={3}
                    value={pasteText}
                    onChange={(e) => handlePasteChange(e.target.value)}
                    placeholder="otpauth://totp/... 或 otpauth-migration://offline?data=..."
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                </div>
              )}

              {mode === 'csv' && csvEntries.length > 0 && (
                <div className="space-y-2.5 rounded-lg border border-border bg-background p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-medium text-foreground">
                      预览（共识别 {csvEntries.length} 条）
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      密码已本地遮罩
                    </span>
                  </div>

                  <div className="divide-y divide-border rounded-md border border-border">
                    {csvEntries.slice(0, 5).map((entry, idx) => (
                      <div
                        key={`${entry.title}-${idx}`}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground">{entry.title}</div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">
                            {entry.username || entry.urls[0] || '—'}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {entry.password ? '••••••••' : '(无密码)'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {csvEntries.length > 5 && (
                    <div className="text-right font-mono text-[11px] text-muted-foreground">
                      其余 {csvEntries.length - 5} 条将在确认后一并加密导入
                    </div>
                  )}
                </div>
              )}

              {mode === 'totp' && totpPlanPreview.length > 0 && (
                <div className="space-y-2.5 rounded-lg border border-border bg-background p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-medium text-foreground">
                      预览（共识别 {totpPlanPreview.length} 条 2FA）
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      动态码与密钥已遮罩
                    </span>
                  </div>

                  <div className="divide-y divide-border rounded-md border border-border">
                    {totpPlanPreview.slice(0, 6).map((planItem, idx) => {
                      const label = [planItem.entry.issuer, planItem.entry.account]
                        .filter(Boolean)
                        .join(' · ');
                      const actionBadge =
                        planItem.action === 'attach'
                          ? '关联已有'
                          : planItem.action === 'skip_duplicate'
                            ? '重复跳过'
                            : '新建登录';
                      return (
                        <div
                          key={`${label}-${idx}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-foreground">
                              {label || '未命名 2FA'}
                            </div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {planItem.entry.algorithm} · {planItem.entry.digits} 位 ·{' '}
                              {actionBadge}
                            </div>
                          </div>
                          <span className="shrink-0 font-mono text-[11px] tracking-widest text-muted-foreground">
                            ••••••
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {totpPlanPreview.length > 6 && (
                    <div className="text-right font-mono text-[11px] text-muted-foreground">
                      其余 {totpPlanPreview.length - 6} 条将在确认后一并处理
                    </div>
                  )}
                </div>
              )}

              {mode === 'csv' && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground select-none">
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-input accent-primary"
                  />
                  <span>自动跳过当前密码库中已存在的重复账号密码</span>
                </label>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-border bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-muted"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busy || !vaultId || !rawText || readyCount === 0}
                  onClick={() => void handleImport()}
                  className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy
                    ? '加密导入中...'
                    : readyCount > 0
                      ? mode === 'csv'
                        ? `加密导入 ${readyCount} 条密码`
                        : `加密导入 ${readyCount} 条 2FA`
                      : '请先选择文件'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export { ImportCsvModal as ImportModal };
