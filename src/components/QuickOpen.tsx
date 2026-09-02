import { useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "./CommandPalette";

export interface QuickFile {
  path: string;
  name: string;
  /** Path relative to the project root, for display. */
  rel: string;
}

interface Props {
  files: QuickFile[];
  commands: Command[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
  /** Start in command mode (the ">" prefix), e.g. when opened via ⌘K. */
  startInCommands?: boolean;
}

/** Fuzzy subsequence score against a haystack; -1 = no match. Lower gaps rank higher. */
function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (last >= 0) gaps += ti - last - 1;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? 500 - gaps : -1;
}

/**
 * VS Code-style quick open: type to fuzzy-find a file; prefix with ">" to run a
 * command instead. Both share one input and keyboard model.
 */
export default function QuickOpen({ files, commands, onOpenFile, onClose, startInCommands }: Props) {
  const [query, setQuery] = useState(startInCommands ? ">" : "");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commandMode = query.startsWith(">");
  const term = commandMode ? query.slice(1).trim() : query.trim();

  const fileResults = useMemo(() => {
    if (commandMode) return [];
    const scored = files
      .map((f) => ({ f, s: Math.max(score(term, f.name) + 20, score(term, f.rel)) }))
      .filter((x) => x.s >= 0);
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 200).map((x) => x.f);
  }, [files, term, commandMode]);

  const commandResults = useMemo(() => {
    if (!commandMode) return [];
    const scored = commands
      .filter((c) => c.id !== "view.palette" && c.id !== "view.quickopen")
      .map((c) => ({ c, s: score(term, `${c.group} ${c.title}`) }))
      .filter((x) => x.s >= 0);
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c);
  }, [commands, term, commandMode]);

  const count = commandMode ? commandResults.length : fileResults.length;
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    if (commandMode) {
      const c = commandResults[i];
      if (c && !c.disabled) {
        onClose();
        setTimeout(() => c.run(), 0);
      }
    } else {
      const f = fileResults[i];
      if (f) {
        onClose();
        onOpenFile(f.path);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (count ? (i + 1) % count : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (count ? (i - 1 + count) % count : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 pt-[5px]" onClick={onClose}>
      {/* Anchored below the title-bar search box (same centre), so it reads as the
          box expanding into a dropdown rather than a separate modal. */}
      <div
        className="content-pane rise w-[min(640px,66vw)] overflow-hidden rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files by name  (append > for commands)"
          className="w-full border-b border-[color:var(--line)] bg-transparent px-3.5 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
        />
        <div ref={listRef} className="max-h-[52vh] overflow-auto py-1.5">
          {count === 0 && (
            <p className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
              {commandMode ? "No matching command." : "No matching file."}
            </p>
          )}

          {commandMode
            ? commandResults.map((c, i) => (
                <Row key={c.id} active={i === active} onEnter={() => setActive(i)} onClick={() => choose(i)} disabled={c.disabled}>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">{c.group}</span>
                  {c.hint && <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">{c.hint}</span>}
                </Row>
              ))
            : fileResults.map((f, i) => (
                <Row key={f.path} active={i === active} onEnter={() => setActive(i)} onClick={() => choose(i)}>
                  <FileGlyph name={f.name} />
                  <span className="min-w-0 shrink-0 truncate font-medium text-[var(--text-primary)]">{f.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">{f.rel}</span>
                </Row>
              ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  active,
  disabled,
  onEnter,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onEnter: () => void;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      data-active={active}
      onMouseEnter={onEnter}
      onClick={onClick}
      className={`mx-1.5 flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] ${
        disabled ? "text-[var(--text-tertiary)]" : active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-primary)]"
      }`}
    >
      {children}
    </div>
  );
}

function FileGlyph({ name }: { name: string }) {
  const rs = name.endsWith(".rs");
  const toml = name.endsWith(".toml");
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" className={`shrink-0 ${rs ? "text-[var(--accent)]" : toml ? "text-orange-500" : "text-[var(--text-tertiary)]"}`}>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
