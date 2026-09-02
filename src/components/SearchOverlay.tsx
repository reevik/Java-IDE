import { useEffect, useMemo, useRef, useState } from "react";
import { searchInFiles } from "../lib/api";
import type { SearchMatch } from "../lib/types";

interface Props {
  root: string;
  onJump: (file: string, line: number, column: number) => void;
  onClose: () => void;
}

interface FileGroup {
  file: string;
  rel: string;
  matches: SearchMatch[];
}

/** VS Code-style Find in Files: a query, results grouped by file, click to jump. */
export default function SearchOverlay({ root, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const seq = useRef(0);

  // Debounced search as the user types.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    setStatus("searching");
    const id = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        const r = await searchInFiles(root, q, caseSensitive);
        if (seq.current === id) {
          setResults(r);
          setStatus("done");
        }
      } catch (e) {
        console.error(e);
        if (seq.current === id) setStatus("done");
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, caseSensitive, root]);

  const groups: FileGroup[] = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of results) {
      (map.get(m.file) ?? map.set(m.file, []).get(m.file)!).push(m);
    }
    return [...map.entries()].map(([file, matches]) => ({
      file,
      rel: file.startsWith(root) ? file.slice(root.length + 1) : file,
      matches,
    }));
  }, [results, root]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[8vh]" onClick={onClose}>
      <div
        className="content-pane rise flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center gap-2 border-b border-[color:var(--line)] px-4 py-3">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in files…"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <button
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match case"
            className={`rounded px-1.5 py-0.5 font-mono text-[12px] ${
              caseSensitive ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-tertiary)] hover:bg-[var(--hover)]"
            }`}
          >
            Aa
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {status === "idle" && query.trim().length < 2 && (
            <p className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">Type at least 2 characters.</p>
          )}
          {status === "searching" && (
            <p className="px-4 py-4 text-center text-[12px] text-[var(--text-tertiary)]">Searching…</p>
          )}
          {status === "done" && results.length === 0 && (
            <p className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">No matches.</p>
          )}

          {groups.map((g) => (
            <div key={g.file} className="mb-1">
              <div className="sticky top-0 flex items-center gap-2 bg-[var(--control-bg)] px-4 py-1 text-[11px] text-[var(--text-secondary)] backdrop-blur">
                <span className="min-w-0 truncate font-medium">{g.rel}</span>
                <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 text-[10px] tabular-nums text-[var(--text-tertiary)]">
                  {g.matches.length}
                </span>
              </div>
              {g.matches.map((m, i) => (
                <button
                  key={i}
                  onClick={() => {
                    onClose();
                    onJump(m.file, m.line, m.column);
                  }}
                  className="flex w-full items-baseline gap-3 px-4 py-1 text-left hover:bg-[var(--accent-soft)]"
                >
                  <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--text-tertiary)]">{m.line}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-primary)]">
                    {m.text.slice(0, m.match_start)}
                    <mark className="rounded-sm bg-yellow-300/60 text-inherit">
                      {m.text.slice(m.match_start, m.match_start + m.match_len)}
                    </mark>
                    {m.text.slice(m.match_start + m.match_len)}
                  </span>
                </button>
              ))}
            </div>
          ))}

          {status === "done" && results.length >= 800 && (
            <p className="px-4 py-2 text-center text-[11px] text-[var(--text-tertiary)]">Showing the first 800 matches.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-[var(--text-tertiary)]">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
