import React from 'react';

interface BrandMarkProps {
  className?: string;
}

const KEYS = [
  { x: 20.5, y: 22.5, color: '#F5CC2E' },
  { x: 32, y: 26, color: '#3DCC61' },
  { x: 43.5, y: 22.5, color: '#3D8AF9' },
] as const;

export const BrandMark: React.FC<BrandMarkProps> = ({ className = 'size-8' }) => (
  <span
    className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[22.5%] ring-1 ring-black/10 dark:ring-white/10 ${className}`}
    aria-hidden="true"
  >
    <svg viewBox="0 0 64 64" className="size-full" fill="none">
      <rect width="64" height="64" rx="14.5" fill="#1C1C1F" />
      {KEYS.map((k) => (
        <g key={`${k.x}-${k.y}`} transform={`translate(${k.x}, ${k.y})`}>
          <circle cx="0" cy="0" r="8.2" fill={k.color} />
          <path
            d="M-3.1 5.5 L-3.1 19.3 L-0.4 22.0 Q0 22.5 0.5 22.0 L3.3 19.2 L3.3 17.6 L5.6 15.3 Q6.2 14.7 5.6 14.1 L3.6 12.1 L3.6 11.4 L5.8 9.2 Q6.4 8.6 5.8 8.0 L3.1 5.3 Z"
            fill={k.color}
            stroke={k.color}
            strokeWidth="0.6"
            strokeLinejoin="round"
          />
          <circle cx="0" cy="-2.2" r="2.2" fill="#1C1C1F" />
        </g>
      ))}
    </svg>
  </span>
);
