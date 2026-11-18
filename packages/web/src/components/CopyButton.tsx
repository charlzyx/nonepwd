import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLocale } from '../state/locale';

interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  variant?: 'default' | 'minimal';
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for non-HTTPS origins (e.g. http://<IP>) or restricted clipboard permissions
    }
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
    if (activeEl && typeof activeEl.focus === 'function') {
      activeEl.focus({ preventScroll: true });
    }
  }
  return ok;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  value,
  label,
  copiedLabel,
  className = '',
  variant = 'default',
}) => {
  const { isZh } = useLocale();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyTextWithFallback(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
        variant === 'minimal' ? 'px-2 py-1' : 'px-2.5 py-1'
      } ${className}`}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-foreground" />
          <span className="text-foreground">{copiedLabel ?? (isZh ? '已复制' : 'Copied')}</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          {label ? <span>{label}</span> : null}
        </>
      )}
    </button>
  );
};
