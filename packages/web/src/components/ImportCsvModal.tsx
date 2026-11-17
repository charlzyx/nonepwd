import React, { useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, Lock, Upload, X } from 'lucide-react';
import { parsePasswordCsv, type CsvImportedEntry } from '@nonepwd/core';
import { useVault } from '../state/VaultContext';

interface ImportCsvModalProps {
  defaultVaultId: string;
  onClose: () => void;
}

export const ImportCsvModal: React.FC<ImportCsvModalProps> = ({ defaultVaultId, onClose }) => {
  const { vaults, importCsvItems } = useVault();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initialVaultId = useMemo(() => {
    if (defaultVaultId !== 'all' && vaults.some((v) => v.id === defaultVaultId)) {
      return defaultVaultId;
    }
    return (
      vaults.find((v) => v.metadata.name.toLowerCase() === 'personal')?.id ?? vaults[0]?.id ?? ''
    );
  }, [defaultVaultId, vaults]);

  const [vaultId, setVaultId] = useState(initialVaultId);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [parsedEntries, setParsedEntries] = useState<CsvImportedEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    total: number;
    imported: number;
    skipped: number;
  } | null>(null);

  const loadCsvFile = async (file: File) => {
    setErr(null);
    setResult(null);
    try {
      const text = await file.text();
      const entries = parsePasswordCsv(text);
      if (entries.length === 0) {
        setFileName(file.name);
        setCsvText(null);
        setParsedEntries([]);
        setErr('未在 CSV 中检测到有效的账号密码条目。');
        return;
      }
      setFileName(file.name);
      setCsvText(text);
      setParsedEntries(entries);
    } catch (error) {
      setFileName(file.name);
      setCsvText(null);
      setParsedEntries([]);
      setErr(error instanceof Error ? error.message : 'CSV 解析失败');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void loadCsvFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void loadCsvFile(file);
    }
  };

  const handleImport = async () => {
    if (!vaultId || !csvText || parsedEntries.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const summary = await importCsvItems({
        vaultId,
        csvText,
        skipDuplicates,
      });
      setResult(summary);
    } catch (error) {
      setErr(error instanceof Error ? error.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl border border-border bg-card text-foreground shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">导入浏览器密码 CSV</h3>
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
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              本地浏览器 WASM 解析并 AES-256-GCM 加密，CSV 明文只在内存处理，绝不上传服务端。
            </span>
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
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  已成功加密导入 {result.imported} 条密码
                </h4>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  共解析 {result.total} 条 · 跳过重复 {result.skipped} 条
                </p>
              </div>
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
                className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-7 text-center transition-colors ${
                  dragging
                    ? 'border-foreground bg-muted/60'
                    : 'border-border bg-background hover:bg-muted/40'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <Upload className="mb-2 h-5 w-5 text-muted-foreground" />
                <div className="text-xs font-medium text-foreground">
                  {fileName ? `已选择：${fileName}` : '点击选择或拖拽导出的 CSV 文件到此处'}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  兼容 Brave / Chrome / Edge / Arc / Safari / Bitwarden / 1Password 导出的 `.csv`
                </p>
              </div>

              {parsedEntries.length > 0 && (
                <div className="space-y-2.5 rounded-lg border border-border bg-background p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-medium text-foreground">
                      预览（共识别 {parsedEntries.length} 条）
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      密码已本地遮罩
                    </span>
                  </div>

                  <div className="divide-y divide-border rounded-md border border-border">
                    {parsedEntries.slice(0, 5).map((entry, idx) => (
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
                  {parsedEntries.length > 5 && (
                    <div className="text-right font-mono text-[11px] text-muted-foreground">
                      其余 {parsedEntries.length - 5} 条将在确认后一并加密导入
                    </div>
                  )}
                </div>
              )}

              <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground select-none">
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  onChange={(e) => setSkipDuplicates(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input accent-primary"
                />
                <span>自动跳过当前密码库中已存在的重复账号密码</span>
              </label>

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
                  disabled={busy || !vaultId || !csvText || parsedEntries.length === 0}
                  onClick={() => void handleImport()}
                  className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy
                    ? '加密导入中...'
                    : parsedEntries.length > 0
                      ? `加密导入 ${parsedEntries.length} 条密码`
                      : '请先选择 CSV 文件'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
