import { useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  /** Classes for the trigger button (sizing/typography to match the context). */
  className?: string;
  /** Align the popup to the right edge of the trigger. */
  alignRight?: boolean;
}

/** A custom dropdown that replaces the native `<select>` so it matches the app's
 *  menus (no OS chrome). Keyboard: ↑/↓ move, Enter/Space open/pick, Esc closes. */
export default function Select({ value, options, onChange, disabled, title, placeholder, className = "", alignRight }: Props) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (v: string) => { onChange(v); setOpen(false); };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(i + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = options[hi]; if (o) pick(o.value); }
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKey}
        disabled={disabled}
        title={title}
        className={`flex items-center gap-1.5 ${className}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? placeholder ?? ""}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={`project-menu absolute top-full z-[80] mt-1 max-h-64 min-w-full max-w-[360px] overflow-auto rounded-lg py-1 text-[12.5px] ${alignRight ? "right-0" : "left-0"}`}>
          {options.length === 0 && <div className="px-3 py-1.5 text-[var(--text-tertiary)]">No options</div>}
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o.value)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${i === hi ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-primary)] hover:bg-[var(--hover)]"}`}
            >
              <span className="w-3 shrink-0 text-[var(--accent-strong)]">{o.value === value ? "✓" : ""}</span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
