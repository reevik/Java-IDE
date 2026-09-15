import { useMemo, useState } from "react";
import type { TreeNode } from "../lib/types";
import { detectSourceRoots } from "../lib/api";
import DependenciesView from "./DependenciesView";
import {
  DEFAULT_ROOTS,
  ROOT_COLOR,
  ROOT_GROUP,
  ROOT_LABEL,
  relOf,
  type RootKind,
  type SourceRoots,
} from "../lib/sourceRoots";

interface About {
  name: string;
  version?: string;
  languageLevel?: string;
  buildTool?: string;
  workspace?: boolean;
  members?: string[];
}

interface Props {
  rootPath: string;
  tree: TreeNode[];
  roots: SourceRoots;
  about?: About;
  onSave: (roots: SourceRoots) => void;
  onClose: () => void;
}

type Tab = "sources" | "dependencies" | "about";
const TABS: { id: Tab; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "dependencies", label: "Dependencies" },
  { id: "about", label: "About" },
];

const MARK_ORDER: RootKind[] = ["sources", "tests", "resources", "testResources", "excluded"];

/** Project-level settings, tabbed: Sources (editable roots), Dependencies, About. */
export default function ProjectSettingsDialog({ rootPath, tree, roots, about, onSave, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("sources");
  const [draft, setDraft] = useState<SourceRoots>({ ...roots });
  const [detecting, setDetecting] = useState(false);
  // Detected roots awaiting the user's confirmation to replace the current ones.
  const [detected, setDetected] = useState<SourceRoots | null>(null);
  const [detectNote, setDetectNote] = useState<string | null>(null);

  const runDetect = async () => {
    setDetectNote(null);
    setDetecting(true);
    try {
      const found = (await detectSourceRoots(rootPath)) as SourceRoots;
      if (Object.keys(found).length === 0) {
        setDetectNote("No source or resource paths found in the build files.");
      } else {
        setDetected(found); // ask before replacing
      }
    } catch (e) {
      setDetectNote(`Detection failed: ${String(e)}`);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="switch-dialog flex h-[580px] w-[880px] flex-col rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--line)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Project Settings</h2>
          <span className="max-w-[420px] truncate text-[11px] text-[var(--text-tertiary)]" title={rootPath}>{about?.name ?? shortRoot(rootPath)}</span>
        </div>

        {/* Top tab bar */}
        <div className="flex shrink-0 items-center gap-1 border-b border-[color:var(--line)] px-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium ${
                tab === t.id
                  ? "border-[var(--accent)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "sources" && (
            <SourcesTab rootPath={rootPath} tree={tree} draft={draft} setDraft={setDraft} languageLevel={about?.languageLevel} />
          )}
          {tab === "dependencies" && (
            <div className="h-full overflow-auto">
              <DependenciesView root={rootPath} />
            </div>
          )}
          {tab === "about" && <AboutTab rootPath={rootPath} about={about} />}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[color:var(--line)] px-4 py-3">
          {tab === "sources" ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => void runDetect()}
                disabled={detecting}
                title="Detect source & resource roots from the project's build files"
                className="btn-bezel flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] disabled:opacity-50"
              >
                {detecting ? <MiniSpinner /> : <WandGlyph />}
                {detecting ? "Detecting…" : "Detect source paths"}
              </button>
              <button onClick={() => setDraft({ ...DEFAULT_ROOTS })} className="btn-bezel px-2.5 py-1.5 text-[11.5px]">
                Reset to defaults
              </button>
              {detectNote && <span className="text-[11px] text-[var(--text-tertiary)]">{detectNote}</span>}
            </div>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12.5px]">Cancel</button>
            <button onClick={() => onSave(draft)} className="btn-accent px-3 py-1.5 text-[12.5px]">Save</button>
          </div>
        </div>
      </div>

      {detected && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onClick={(e) => { e.stopPropagation(); setDetected(null); }}>
          <div className="switch-dialog w-[420px] rounded-xl p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-[13.5px] font-semibold text-[var(--text-primary)]">Replace source roots?</h3>
            <p className="mb-3 text-[12px] text-[var(--text-secondary)]">
              Detected {Object.keys(detected).length} source/resource {Object.keys(detected).length === 1 ? "path" : "paths"} from the build files. This will
              replace your current configuration.
            </p>
            <div className="mb-4 max-h-40 overflow-auto rounded-md border border-[color:var(--line)] p-2">
              {Object.entries(detected).sort().map(([path, kind]) => (
                <div key={path} className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
                  <span className={`shrink-0 ${ROOT_COLOR[kind as RootKind]}`}>{ROOT_LABEL[kind as RootKind]}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={path}>{path}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDetected(null)} className="btn-bezel px-3 py-1.5 text-[12.5px]">Cancel</button>
              <button
                onClick={() => { setDraft({ ...detected }); setDetected(null); }}
                className="btn-accent px-3 py-1.5 text-[12.5px]"
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Sources tab ------------------------------------------------------------

function SourcesTab({
  rootPath,
  tree,
  draft,
  setDraft,
  languageLevel,
}: {
  rootPath: string;
  tree: TreeNode[];
  draft: SourceRoots;
  setDraft: React.Dispatch<React.SetStateAction<SourceRoots>>;
  languageLevel?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const dirTree = useMemo(() => onlyDirs(tree), [tree]);
  const selKind = selected !== null ? draft[selected] : undefined;

  const mark = (kind: RootKind | null) => {
    if (selected === null) return;
    setDraft((prev) => {
      const next = { ...prev };
      if (kind === null) delete next[selected];
      else next[selected] = kind;
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[color:var(--line)] px-4 py-2">
        <span className="mr-1 text-[11.5px] text-[var(--text-tertiary)]">Mark as:</span>
        {MARK_ORDER.map((k) => (
          <button
            key={k}
            disabled={selected === null}
            onClick={() => mark(selKind === k ? null : k)}
            title={selected === null ? "Select a directory first" : `Mark “${selected || "project root"}” as ${ROOT_LABEL[k]}`}
            className={`rounded-md px-2 py-1 text-[11.5px] font-medium disabled:opacity-40 ${
              selKind === k ? "bg-[var(--accent-soft)] " + ROOT_COLOR[k] : "hover:bg-[var(--hover)] text-[var(--text-secondary)]"
            }`}
          >
            {ROOT_LABEL[k]}
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-[var(--line)]" />
        <button
          disabled={selected === null || selKind === undefined}
          onClick={() => mark(null)}
          className="rounded-md px-2 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)] disabled:opacity-40"
        >
          Unmark
        </button>
        <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
          Language level: <span className="text-[var(--text-secondary)]">{languageLevel || "detected from build file"}</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto border-r border-[color:var(--line)] p-2">
          {dirTree.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--text-tertiary)]">No directories in this project.</p>
          ) : (
            dirTree.map((n) => (
              <DirRow key={n.path} node={n} depth={0} rootPath={rootPath} draft={draft} selected={selected} onSelect={setSelected} />
            ))
          )}
        </div>

        <div className="w-[320px] shrink-0 overflow-auto p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-primary)]">
            <FolderGlyph className="text-[var(--text-secondary)]" />
            <span className="truncate" title={rootPath}>{shortRoot(rootPath)}</span>
          </div>
          {MARK_ORDER.map((k) => {
            const items = Object.keys(draft).filter((d) => draft[d] === k).sort();
            if (items.length === 0) return null;
            return (
              <div key={k} className="mb-3">
                <div className={`mb-1 text-[11.5px] font-semibold ${ROOT_COLOR[k]}`}>{ROOT_GROUP[k]}</div>
                {items.map((d) => (
                  <div key={d} className="group flex items-center gap-1.5 py-0.5">
                    <FolderGlyph className={ROOT_COLOR[k]} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-primary)]" title={d}>{d || "(root)"}</span>
                    <button
                      onClick={() => setDraft((prev) => { const n = { ...prev }; delete n[d]; return n; })}
                      className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--hover)] hover:text-red-600 group-hover:opacity-100"
                      title="Unmark"
                    >
                      <XGlyph />
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
          {Object.keys(draft).length === 0 && (
            <p className="text-[11.5px] text-[var(--text-tertiary)]">Nothing marked yet. Select a directory and use “Mark as”.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- About tab --------------------------------------------------------------

function AboutTab({ rootPath, about }: { rootPath: string; about?: About }) {
  const rows: [string, string][] = [
    ["Name", about?.name ?? "—"],
    ["Version", about?.version || "—"],
    ["Language level", about?.languageLevel || "—"],
    ["Build tool", about?.buildTool || "—"],
    ["Location", rootPath],
  ];
  if (about?.workspace) rows.push(["Modules", (about.members ?? []).join(", ") || "—"]);
  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-[560px]">
        {rows.map(([k, v]) => (
          <div key={k} className="mb-2 flex items-baseline gap-3">
            <span className="w-[120px] shrink-0 text-[12px] text-[var(--text-secondary)]">{k}</span>
            <span className="min-w-0 flex-1 break-all text-[12px] text-[var(--text-primary)]">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- shared bits ------------------------------------------------------------

function onlyDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter((n) => n.kind === "dir").map((n) => ({ ...n, children: onlyDirs(n.children ?? []) }));
}

function DirRow({
  node,
  depth,
  rootPath,
  draft,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  rootPath: string;
  draft: SourceRoots;
  selected: string | null;
  onSelect: (rel: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const rel = relOf(rootPath, node.path);
  const kind = draft[rel];
  const isSel = selected === rel;
  const kids = node.children ?? [];
  return (
    <div>
      <div
        onClick={() => onSelect(rel)}
        style={{ paddingLeft: 4 + depth * 14 }}
        className={`flex cursor-pointer items-center gap-1 rounded py-[3px] pr-1.5 text-[12.5px] ${
          isSel ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--hover)]"
        }`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="grid h-4 w-4 shrink-0 place-items-center text-[var(--text-tertiary)]"
        >
          {kids.length > 0 ? (open ? "▾" : "▸") : ""}
        </button>
        <FolderGlyph className={kind ? ROOT_COLOR[kind] : "text-[var(--text-tertiary)]"} />
        <span className={`min-w-0 flex-1 truncate ${kind ? ROOT_COLOR[kind] : "text-[var(--text-primary)]"}`}>{node.name}</span>
        {kind && <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{ROOT_LABEL[kind]}</span>}
      </div>
      {open && kids.map((c) => (
        <DirRow key={c.path} node={c} depth={depth + 1} rootPath={rootPath} draft={draft} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function shortRoot(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts.slice(-2).join("/");
}

function FolderGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" className={`shrink-0 ${className}`}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}
function XGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function WandGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M15 4V2M15 10V8M11 6H9M21 6h-2M18.5 3.5l-1.4 1.4M18.5 8.5l-1.4-1.4M3 21l9-9M12.5 8.5l3 3" />
    </svg>
  );
}
function MiniSpinner() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="shrink-0 animate-spin">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
