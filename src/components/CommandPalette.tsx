import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  title: string;
  group: string;
  /** Shortcut hint shown on the right, e.g. "⌘P". */
  hint?: string;
  /** Disabled commands stay listed but greyed out (with the reason as a tooltip). */
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

/** Subsequence match: "tbl" matches "Table". Returns a score, or -1 for no match. */
function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct; // contiguous matches rank highest
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

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: Math.max(score(query, c.title), score(query, `${c.group} ${c.title}`) - 50) }))
      .filter((x) => x.s >= 0);
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view while arrowing through the list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command) => {
    if (c.disabled) return;
    onClose();
    // Let the overlay unmount before the action steals focus (e.g. the editor).
    setTimeout(() => c.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (matches.length ? (i + 1) % matches.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = matches[active];
      if (c) run(c);
    }
  };

  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[12vh]" onClick={onClose}>
      <div
        className="content-pane rise w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          className="w-full border-b border-[color:var(--line)] bg-transparent px-4 py-3 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
        />

        <div ref={listRef} className="max-h-[46vh] overflow-auto py-1.5">
          {matches.length === 0 && (
            <p className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">No matching command.</p>
          )}

          {matches.map((c, i) => {
            const header = c.group !== lastGroup && !query ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && (
                  <p className="px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                    {header}
                  </p>
                )}
                <div
                  data-active={i === active}
                  title={c.disabled ? c.disabledReason : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={`mx-1.5 flex cursor-default items-center gap-3 rounded-lg px-2.5 py-1.5 text-[13px] ${
                    c.disabled
                      ? "text-[var(--text-tertiary)]"
                      : i === active
                        ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                        : "text-[var(--text-primary)]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {query && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                      {c.group}
                    </span>
                  )}
                  {c.hint && <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
