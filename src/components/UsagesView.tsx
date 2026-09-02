import { useMemo, useState } from "react";
import type { Reference } from "../lib/api";

export interface UsagesResult {
  symbol: string;
  refs: Reference[];
}

interface Props {
  result: UsagesResult | null;
  root: string | null;
  onJump: (path: string, line: number, character: number) => void;
}

const CATEGORY: { kind: Reference["kind"]; label: string }[] = [
  { kind: "decl", label: "Declaration" },
  { kind: "write", label: "Value write" },
  { kind: "read", label: "Value read" },
];

function rel(path: string, root: string | null): string {
  if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  return path.split("/").slice(-2).join("/");
}

export default function UsagesView({ result, root, onJump }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Group by category → file, preserving line order within a file.
  const grouped = useMemo(() => {
    const out: { kind: Reference["kind"]; label: string; files: { path: string; refs: Reference[] }[] }[] = [];
    for (const { kind, label } of CATEGORY) {
      const inCat = (result?.refs ?? []).filter((r) => r.kind === kind);
      if (inCat.length === 0) continue;
      const byFile = new Map<string, Reference[]>();
      for (const r of inCat) {
        const list = byFile.get(r.path) ?? [];
        list.push(r);
        byFile.set(r.path, list);
      }
      const files = [...byFile.entries()]
        .map(([path, refs]) => ({ path, refs: [...refs].sort((a, b) => a.line - b.line) }))
        .sort((a, b) => rel(a.path, root).localeCompare(rel(b.path, root)));
      out.push({ kind, label, files });
    }
    return out;
  }, [result, root]);

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[var(--text-tertiary)]">
        Right-click a symbol → <span className="mx-1 text-[var(--text-secondary)]">Find Usages</span> to see results here.
      </div>
    );
  }

  const total = result.refs.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[color:var(--line)] px-3 py-1.5 text-[11px]">
        <span className="font-semibold text-[var(--accent-strong)]">{total}</span>{" "}
        <span className="text-[var(--text-secondary)]">
          usage{total === 1 ? "" : "s"} of <span className="font-medium text-[var(--text-primary)]">{result.symbol}</span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
        {total === 0 && <p className="px-3 py-4 text-center text-[var(--text-tertiary)]">No usages found.</p>}
        {grouped.map((cat) => {
          const catKey = `cat:${cat.kind}`;
          const catOpen = !collapsed.has(catKey);
          const catCount = cat.files.reduce((n, f) => n + f.refs.length, 0);
          return (
            <div key={cat.kind} className="mb-0.5">
              <button
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[color:var(--hover)]"
                onClick={() => toggle(catKey)}
              >
                <Caret open={catOpen} />
                <span className="font-semibold text-[var(--text-primary)]">{cat.label}</span>
                <span className="text-[11px] text-[var(--text-tertiary)]">{catCount}</span>
              </button>
              {catOpen &&
                cat.files.map((file) => {
                  const fileKey = `${cat.kind}:${file.path}`;
                  const fileOpen = !collapsed.has(fileKey);
                  return (
                    <div key={fileKey}>
                      <button
                        className="flex w-full items-center gap-1.5 py-0.5 pr-2 pl-5 text-left hover:bg-[color:var(--hover)]"
                        onClick={() => toggle(fileKey)}
                      >
                        <Caret open={fileOpen} />
                        <span className="truncate text-[var(--text-secondary)]">{rel(file.path, root)}</span>
                        <span className="text-[11px] text-[var(--text-tertiary)]">{file.refs.length}</span>
                      </button>
                      {fileOpen &&
                        file.refs.map((r, i) => (
                          <button
                            key={i}
                            className="flex w-full items-center gap-2 py-0.5 pr-2 pl-10 text-left hover:bg-[color:var(--accent-soft)]"
                            onClick={() => onJump(r.path, r.line + 1, r.character + 1)}
                            title={`${rel(r.path, root)}:${r.line + 1}`}
                          >
                            <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--text-tertiary)]">{r.line + 1}</span>
                            <span className="truncate font-[var(--code-font-family)] text-[var(--text-secondary)]" style={{ fontFamily: "var(--code-font-family, monospace)" }}>
                              {r.preview}
                            </span>
                          </button>
                        ))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? "" : "-rotate-90"}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
