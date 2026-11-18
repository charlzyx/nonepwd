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
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard restrictions
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
