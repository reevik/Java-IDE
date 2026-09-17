import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createModule, fileSymbols, projectModules, type CodeSymbol, type ModuleNode } from "../lib/api";

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (absPath: string, line?: number) => void;
}

/** Find the module backed by `file`, searching the tree depth-first. */
function findModuleByFile(nodes: ModuleNode[], file: string): ModuleNode | null {
  for (const n of nodes) {
    if (n.file === file) return n;
    const found = findModuleByFile(n.children, file);
    if (found) return found;
  }
  return null;
}

/** Recursively keep modules whose name/path matches, plus their ancestors. */
function filterModules(nodes: ModuleNode[], q: string): ModuleNode[] {
  const out: ModuleNode[] = [];
  for (const n of nodes) {
    const kids = filterModules(n.children, q);
    if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q) || kids.length) {
      out.push({ ...n, children: kids });
    }
  }
  return out;
}

/** Left-sidebar "Modules" tab: the project's Java package tree, with filter + add. */
export default function ModulesView({ root, activePath, onOpen }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["modules", root], queryFn: () => projectModules(root) });
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Expand/collapse-all: bumping the epoch remounts the tree with a forced
  // initial open state (per-row expansion is local, so a remount applies it).
  const [epoch, setEpoch] = useState(0);
  const [allMode, setAllMode] = useState<boolean | null>(null);
  const expandAll = () => { setAllMode(true); setEpoch((e) => e + 1); };
  const collapseAll = () => { setAllMode(false); setEpoch((e) => e + 1); };

  // The module to nest the new one under: the selected (active) module, else the
  // crate root. Inline modules and non-file entries fall back to the crate root.
  const target = ((): { file: string | null; label: string } => {
    if (!data || !activePath) return { file: null, label: "default package" };
    if (activePath === data.root_file) return { file: data.root_file, label: data.crate_name };
    const m = findModuleByFile(data.modules, activePath);
    if (m && m.file && !m.inline) return { file: m.file, label: m.name };
    return { file: null, label: "default package" };
  })();

  const submitNew = async () => {
    const name = newName.trim();
    if (!name) { setAdding(false); setErr(null); return; }
    try {
      const file = await createModule(root, name, target.file);
      setAdding(false);
      setNewName("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["modules", root] });
      qc.invalidateQueries({ queryKey: ["tree", root] });
      onOpen(file);
    } catch (e) {
      setErr(String(e));
    }
  };

  if (isLoading) return <Center>Loading packages…</Center>;
  if (!data) return <Center>No project.</Center>;

  const q = filter.trim().toLowerCase();
  const shown = q ? filterModules(data.modules, q) : data.modules;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          placeholder="Filter packages…"
          className="field min-w-0 flex-1 px-2 py-1 text-[12px]"
        />
        <button
          onClick={() => { setAdding((a) => !a); setErr(null); }}
          title={`Add class in ${target.label}`}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--hover)]"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      {adding && (
        <div className="shrink-0 px-2 pb-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setErr(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNew();
              else if (e.key === "Escape") { setAdding(false); setNewName(""); setErr(null); }
            }}
            placeholder="class name (e.g. com.example.Foo)"
            className="field w-full px-2 py-1 font-mono text-[12px]"
          />
          {err ? (
            <p className="mt-1 text-[10.5px] text-red-600">{err}</p>
          ) : (
            <p className="mt-1 text-[10.5px] text-[var(--text-tertiary)]">
              New class in <span className="font-medium text-[var(--text-secondary)]">{target.label}</span>. Select a class first to place it in that package.
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto pb-4 text-[12.5px]">
        <ModuleRow
          key={epoch}
          node={{ name: data.crate_name, path: "crate", file: data.root_file, inline: false, children: shown }}
          depth={0}
          activePath={activePath}
          onOpen={onOpen}
          filtering={!!q}
          defaultOpen={allMode}
          isCrate
        />
        {q && shown.length === 0 && (
          <p className="px-3 py-1 text-[11.5px] text-[var(--text-tertiary)]">No matching packages.</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-[color:var(--line)] px-2 py-1.5">
        <button onClick={expandAll} title="Expand all" aria-label="Expand all" className="grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--hover)]"><ExpandGlyph expanded /></button>
        <button onClick={collapseAll} title="Collapse all" aria-label="Collapse all" className="grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--hover)]"><ExpandGlyph /></button>
      </div>
    </div>
  );
}

/** Chevrons pointing apart (expand) or together (collapse). */
function ExpandGlyph({ expanded }: { expanded?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {expanded ? <path d="M8 4l-4 4 4 4M16 20l4-4-4-4" /> : <path d="M4 8l4-4 4 4M20 16l-4 4-4-4" />}
    </svg>
  );
}

function ModuleRow({
  node,
  depth,
  activePath,
  onOpen,
  filtering,
  defaultOpen,
  isCrate,
}: {
  node: ModuleNode;
  depth: number;
  activePath: string | null;
  onOpen: (p: string, line?: number) => void;
  filtering?: boolean;
  defaultOpen?: boolean | null;
  isCrate?: boolean;
}) {
  // Expand-all forces open; collapse-all (or default) leaves only the roots open.
  const [openState, setOpen] = useState(defaultOpen === true ? true : depth === 0);
  const open = filtering || openState;
  const hasFile = !!node.file && !node.inline;
  const expandable = node.children.length > 0 || hasFile;
  const isActive = node.file && activePath === node.file;
  return (
    <div>
      <div
        className={`group flex w-full items-center hover:bg-[var(--hover)] ${isActive ? "bg-[var(--accent-soft)]" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          onClick={() => expandable && setOpen((o) => !o)}
          className="grid h-5 w-4 shrink-0 place-items-center text-[var(--text-tertiary)]"
        >
          {expandable ? (open ? "▾" : "▸") : ""}
        </button>
        <button
          onClick={() => node.file && onOpen(node.file)}
          title={node.path}
          disabled={!node.file}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left disabled:cursor-default"
        >
          {isCrate ? <CrateIcon /> : <ModIcon inline={node.inline} />}
          <span className={`truncate ${isCrate ? "font-medium " : ""}${node.file ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{node.name}</span>
          {isCrate && <span className="text-[10px] text-[var(--text-tertiary)]">project</span>}
          {node.inline && <span className="text-[10px] text-[var(--text-tertiary)]">inline</span>}
        </button>
      </div>
      {open && (
        <>
          {hasFile && !filtering && <SymbolTree file={node.file!} depth={depth + 1} onOpen={onOpen} />}
          {node.children.map((c) => (
            <ModuleRow key={c.path} node={c} depth={depth + 1} activePath={activePath} onOpen={onOpen} filtering={filtering} defaultOpen={defaultOpen} />
          ))}
        </>
      )}
    </div>
  );
}

/** The functions/structs/etc. declared in a module's file (fetched lazily). */
function SymbolTree({ file, depth, onOpen }: { file: string; depth: number; onOpen: (p: string, line?: number) => void }) {
  const { data } = useQuery({ queryKey: ["symbols", file], queryFn: () => fileSymbols(file) });
  if (!data || data.length === 0) return null;
  return (
    <>
      {data.map((s, i) => <SymbolRow key={`${s.line}-${s.name}-${i}`} sym={s} depth={depth} file={file} onOpen={onOpen} />)}
    </>
  );
}

function SymbolRow({ sym, depth, file, onOpen }: { sym: CodeSymbol; depth: number; file: string; onOpen: (p: string, line?: number) => void }) {
  const [open, setOpen] = useState(false);
  const has = sym.children.length > 0;
  return (
    <div>
      <div className="group flex items-center hover:bg-[var(--hover)]" style={{ paddingLeft: 8 + depth * 12 }}>
        <button onClick={() => has && setOpen((o) => !o)} className="grid h-5 w-4 shrink-0 place-items-center text-[var(--text-tertiary)]">
          {has ? (open ? "▾" : "▸") : ""}
        </button>
        <button onClick={() => onOpen(file, sym.line)} title={`${sym.kind} · line ${sym.line}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] pr-2 text-left">
          <SymbolIcon kind={sym.kind} />
          <span className="truncate text-[12px] text-[var(--text-primary)]">{sym.name}</span>
        </button>
      </div>
      {open && sym.children.map((c, i) => <SymbolRow key={`${c.line}-${c.name}-${i}`} sym={c} depth={depth + 1} file={file} onOpen={onOpen} />)}
    </div>
  );
}

const KIND_STYLE: Record<string, { ch: string; cls: string }> = {
  // Java
  class: { ch: "C", cls: "text-blue-500" },
  interface: { ch: "I", cls: "text-green-600" },
  enum: { ch: "E", cls: "text-orange-500" },
  record: { ch: "R", cls: "text-teal-500" },
  annotation: { ch: "@", cls: "text-pink-500" },
  method: { ch: "ƒ", cls: "text-purple-500" },
  constructor: { ch: "ⓒ", cls: "text-purple-400" },
  field: { ch: "•", cls: "text-[var(--text-tertiary)]" },
  // Rust (legacy — harmless leftovers)
  fn: { ch: "ƒ", cls: "text-purple-500" },
  struct: { ch: "S", cls: "text-blue-500" },
  trait: { ch: "T", cls: "text-green-600" },
  type: { ch: "T", cls: "text-teal-500" },
  const: { ch: "C", cls: "text-[var(--text-tertiary)]" },
};

function SymbolIcon({ kind }: { kind: string }) {
  const s = KIND_STYLE[kind] ?? { ch: "•", cls: "text-[var(--text-tertiary)]" };
  return <span className={`grid h-4 w-4 shrink-0 place-items-center rounded font-mono text-[10.5px] font-bold ${s.cls}`}>{s.ch}</span>;
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center px-4 text-center text-[12px] text-[var(--text-tertiary)]">{children}</div>;
}

function CrateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent)]">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.3 7l8.7 5 8.7-5M12 22V12" />
    </svg>
  );
}
function ModIcon({ inline }: { inline: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${inline ? "text-[var(--text-tertiary)]" : "text-[var(--text-secondary)]"}`}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 9h6v6H9z" />
    </svg>
  );
}
