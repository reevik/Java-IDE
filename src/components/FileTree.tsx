import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../lib/types";
import { isPackageRoot, relOf, type RootKind, type SourceRoots } from "../lib/sourceRoots";

/** Persisted per-project set of collapsed directory paths (survives restart). */
const COLLAPSE_KEY = (root: string) => `tree.collapsed:${root}`;
function loadCollapsed(root: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY(root));
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
/** Whether this project has a remembered expand/collapse state yet. */
function hasSavedCollapse(root: string): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY(root)) != null;
  } catch {
    return false;
  }
}
function saveCollapsed(root: string, set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_KEY(root), JSON.stringify([...set]));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export type NewKind = "file" | "java" | "dir";

/** A tree node augmented for display: source-root role + flattened-package flag. */
type UiNode = TreeNode & { rootKind?: RootKind; isPackage?: boolean; children?: UiNode[] | null };

interface Props {
  tree: TreeNode[];
  /** True while the initial tree is still loading (shows a spinner). */
  loading?: boolean;
  /** Project root — the target when right-clicking empty space. */
  rootPath: string;
  selectedPath: string | null;
  /** Paths with at least one diagnostic, for the dot in the tree. */
  problemPaths: Set<string>;
  /** Directory → role, driving source-root icons and package flattening. */
  sourceRoots: SourceRoots;
  onOpen: (path: string) => void;
  /** Create a file/module/dir in `dir`; throws with a message on failure. */
  onCreate: (dir: string, name: string, kind: NewKind) => Promise<void>;
  /** Delete the given paths; throws with a message on failure. */
  onDelete: (paths: string[]) => Promise<void>;
  /** Move the given paths into `dir`; throws with a message on failure. */
  onMove: (paths: string[], dir: string) => Promise<void>;
  /** Copy the given paths into `dir`; throws with a message on failure. */
  onCopy: (paths: string[], dir: string) => Promise<void>;
  /** Undo the last move/copy (bound to ⌘Z while the explorer is focused). */
  onUndo: () => void;
  /** Open the Project Structure dialog (mark source/resource/test roots). */
  onOpenStructure: () => void;
  /** Whether normally-hidden entries (build dirs, dotfiles) are shown. */
  showHidden?: boolean;
  /** Toggle showing hidden entries. */
  onToggleHidden?: () => void;
}

/** Every directory node path in the (already decorated) tree — for "Collapse all". */
function allDirPaths(nodes: UiNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: UiNode[]) => {
    for (const n of ns) {
      if (n.kind === "dir") {
        out.push(n.path);
        walk((n.children ?? []) as UiNode[]);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Collapse a package directory's single-subdirectory chain into one `a.b.c`
 *  node (IntelliJ "compact middle packages"), recursing into what remains. */
function flattenPackage(node: UiNode): UiNode {
  let cur: UiNode = { ...node, isPackage: true };
  for (;;) {
    const kids = cur.children ?? [];
    const dirs = kids.filter((k) => k.kind === "dir");
    const files = kids.filter((k) => k.kind === "file");
    if (dirs.length === 1 && files.length === 0) {
      const child = dirs[0];
      cur = { ...child, name: `${cur.name}.${child.name}`, isPackage: true };
    } else {
      break;
    }
  }
  const children = (cur.children ?? []).map((c) => (c.kind === "dir" ? flattenPackage(c) : c));
  return { ...cur, children };
}

/** Tag source roots, flatten packages beneath source/test roots, and drop
 *  directories marked Excluded. */
function decorateTree(nodes: TreeNode[], rootPath: string, roots: SourceRoots): UiNode[] {
  const walk = (n: TreeNode): UiNode | null => {
    if (n.kind !== "dir") return n;
    const kind = roots[relOf(rootPath, n.path)];
    if (kind === "excluded") return null; // hidden from the tree
    const children = n.children ?? [];
    if (kind && isPackageRoot(kind)) {
      // Directly-nested directories are top-level packages → flatten each.
      const flat = children.map((c) => (c.kind === "dir" ? flattenPackage(c as UiNode) : (c as UiNode)));
      return { ...n, rootKind: kind, children: flat };
    }
    return { ...n, rootKind: kind, children: children.map(walk).filter((x): x is UiNode => x !== null) };
  };
  return nodes.map(walk).filter((x): x is UiNode => x !== null);
}

function parentDir(p: string) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}
function basename(p: string) {
  return p.split("/").pop() || p;
}

const MENU: { kind: NewKind; label: string }[] = [
  { kind: "java", label: "New Java Class" },
  { kind: "file", label: "New File" },
  { kind: "dir", label: "New Directory" },
];

const PROMPT: Record<NewKind, { title: string; placeholder: string; hint?: string }> = {
  java: { title: "New Java class", placeholder: "Widget", hint: "“.java” is added automatically" },
  file: { title: "New file", placeholder: "notes.md" },
  dir: { title: "New directory", placeholder: "assets" },
};

interface Menu { x: number; y: number; dir: string; targets: string[] }

export default function FileTree({ tree, loading, rootPath, selectedPath, problemPaths, sourceRoots, onOpen, onCreate, onDelete, onMove, onCopy, onUndo, onOpenStructure, showHidden, onToggleHidden }: Props) {
  const navRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(rootPath));
  // Restore the saved expand/collapse state when switching projects.
  useEffect(() => setCollapsed(loadCollapsed(rootPath)), [rootPath]);
  // Set + persist in one step so the tree state survives a restart.
  const writeCollapsed = (next: Set<string>) => { setCollapsed(next); saveCollapsed(rootPath, next); };
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [clip, setClip] = useState<{ mode: "cut" | "copy"; paths: string[] } | null>(null);
  const [prompt, setPrompt] = useState<{ dir: string; kind: NewKind } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Multi-selection of files/dirs (for delete etc.).
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const filtering = filter.trim() !== "";
  const decorated = useMemo(() => decorateTree(tree, rootPath, sourceRoots), [tree, rootPath, sourceRoots]);

  // A freshly-opened project starts fully collapsed instead of expanding the
  // whole hierarchy (which is slow on large trees) — the user expands what they
  // need, and that choice is then remembered.
  useEffect(() => {
    if (!decorated.length || hasSavedCollapse(rootPath)) return;
    writeCollapsed(new Set(allDirPaths(decorated)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decorated, rootPath]);
  const shown = useMemo(() => (filtering ? filterTree(decorated, filter.trim()) : decorated), [decorated, filter, filtering]);

  // Flattened order of currently-visible rows, for shift-click range selection.
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n.path);
        const open = n.kind === "dir" && (filtering || !collapsed.has(n.path));
        if (open && n.children) walk(n.children);
      }
    };
    walk(shown);
    return out;
  }, [shown, collapsed, filtering]);

  // For a contiguous multi-selection, mark each selected row's position in its
  // run so the rows render as one merged cluster (rounded top/bottom, seamless
  // between) instead of separate pills.
  const clusterEdges = useMemo(() => {
    const m = new Map<string, { top: boolean; bottom: boolean }>();
    if (sel.size === 0) return m;
    for (let i = 0; i < visiblePaths.length; i++) {
      const p = visiblePaths[i];
      if (!sel.has(p)) continue;
      const prev = visiblePaths[i - 1];
      const next = visiblePaths[i + 1];
      m.set(p, { top: !prev || !sel.has(prev), bottom: !next || !sel.has(next) });
    }
    return m;
  }, [visiblePaths, sel]);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    writeCollapsed(next);
  };

  const onRowClick = (e: React.MouseEvent, node: TreeNode) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setSel((prev) => {
        const next = new Set(prev);
        next.has(node.path) ? next.delete(node.path) : next.add(node.path);
        return next;
      });
      setAnchor(node.path);
      return;
    }
    if (e.shiftKey && anchor) {
      e.preventDefault();
      const a = visiblePaths.indexOf(anchor);
      const b = visiblePaths.indexOf(node.path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSel(new Set(visiblePaths.slice(lo, hi + 1)));
      }
      return;
    }
    setSel(new Set([node.path]));
    setAnchor(node.path);
    if (node.kind === "dir") toggle(node.path);
    else onOpen(node.path);
  };

  const openMenu = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    const dir = node ? (node.kind === "dir" ? node.path : parentDir(node.path)) : rootPath;
    let targets: string[] = [];
    if (node) {
      if (sel.has(node.path) && sel.size > 0) {
        targets = [...sel];
      } else {
        targets = [node.path];
        setSel(new Set([node.path]));
        setAnchor(node.path);
      }
    }
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: e.clientY, dir, targets });
  };

  const startCreate = (kind: NewKind) => {
    if (!menu) return;
    setPrompt({ dir: menu.dir, kind });
    setName("");
    setErr(null);
    setMenu(null);
  };

  // Palette / native-menu "New File/Folder/Class": open the create prompt at the
  // selected node's directory (a folder → itself; a file → its parent), else root.
  useEffect(() => {
    const dirForNew = (): string => {
      const findNode = (nodes: TreeNode[]): TreeNode | null => {
        for (const n of nodes) {
          if (n.path === selectedPath) return n;
          const c = n.children ? findNode(n.children) : null;
          if (c) return c;
        }
        return null;
      };
      const node = selectedPath ? findNode(tree) : null;
      if (!node) return rootPath;
      return node.kind === "dir" ? node.path : parentDir(node.path);
    };
    const handler = (e: Event) => {
      const kind = (e as CustomEvent).detail as NewKind;
      setPrompt({ dir: dirForNew(), kind });
      setName("");
      setErr(null);
      setMenu(null);
    };
    window.addEventListener("rustade:new", handler);
    return () => window.removeEventListener("rustade:new", handler);
  }, [tree, selectedPath, rootPath]);

  const cutCopy = (mode: "cut" | "copy") => {
    if (!menu || menu.targets.length === 0) return;
    setClip({ mode, paths: menu.targets });
    setMenu(null);
  };

  // Move/copy `paths` into `dir` (from paste or drag-and-drop). Skips no-ops
  // (already in `dir`) and refuses to drop a folder into its own descendant.
  const dropInto = async (paths: string[], dir: string, mode: "cut" | "copy") => {
    const moving = paths.filter((p) => p !== dir && parentDir(p) !== dir && !dir.startsWith(`${p}/`));
    if (moving.length === 0) return;
    try {
      if (mode === "cut") await onMove(moving, dir);
      else await onCopy(moving, dir);
      const next = new Set(collapsed);
      next.delete(dir);
      writeCollapsed(next);
      setSel(new Set());
      navRef.current?.focus(); // so ⌘Z can immediately undo the operation
    } catch (e) {
      alert(String(e));
    }
  };

  // Drag-and-drop: the paths being dragged (set on dragstart, read on drop).
  const dragPathsRef = useRef<string[]>([]);
  const beginDrag = (node: TreeNode): string[] => {
    const paths = sel.has(node.path) && sel.size > 0 ? [...sel] : [node.path];
    dragPathsRef.current = paths;
    return paths;
  };
  const canDropInto = (dir: string): boolean =>
    dragPathsRef.current.length > 0 &&
    dragPathsRef.current.every((p) => p !== dir && parentDir(p) !== dir && !dir.startsWith(`${p}/`));
  const dropOnDir = (dir: string, copy: boolean) => {
    const paths = dragPathsRef.current;
    dragPathsRef.current = [];
    if (paths.length) void dropInto(paths, dir, copy ? "copy" : "cut");
  };

  const paste = async () => {
    if (!menu || !clip) return;
    const dir = menu.dir;
    const { mode, paths } = clip;
    setMenu(null);
    if (mode === "cut") setClip(null);
    await dropInto(paths, dir, mode);
  };

  const submit = async () => {
    if (!prompt || busy) return;
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate(prompt.dir, n, prompt.kind);
      const next = new Set(collapsed);
      next.delete(prompt.dir);
      writeCollapsed(next);
      setPrompt(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onDelete(confirmDelete);
      setSel(new Set());
      setConfirmDelete(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const rel = (dir: string) => (dir === rootPath ? "project root" : dir.slice(rootPath.length + 1) || "project root");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          placeholder="Filter files…"
          className="field min-w-0 flex-1 px-2 py-1 text-[12px]"
        />
        <button
          onClick={onOpenStructure}
          title="Project Settings — sources, dependencies, about"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M9 13.829A3.004 3.004 0 0 0 11 11a3.003 3.003 0 0 0-2-2.829V0H7v8.171A3.004 3.004 0 0 0 5 11c0 1.306.836 2.417 2 2.829V16h2v-2.171zm-5-6A3.004 3.004 0 0 0 6 5a3.003 3.003 0 0 0-2-2.829V0H2v2.171A3.004 3.004 0 0 0 0 5c0 1.306.836 2.417 2 2.829V16h2V7.829zm10 0A3.004 3.004 0 0 0 16 5a3.003 3.003 0 0 0-2-2.829V0h-2v2.171A3.004 3.004 0 0 0 10 5c0 1.306.836 2.417 2 2.829V16h2V7.829zM12 6V4h2v2h-2zM2 6V4h2v2H2zm5 6v-2h2v2H7z" />
          </svg>
        </button>
      </div>
      <nav
        ref={navRef}
        tabIndex={0}
        onContextMenu={(e) => openMenu(e, null)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
            e.preventDefault();
            onUndo();
            return;
          }
          if ((e.key === "Delete" || e.key === "Backspace") && sel.size > 0) {
            e.preventDefault();
            setConfirmDelete([...sel]);
          }
        }}
        onDragOver={(e) => { if (canDropInto(rootPath)) e.preventDefault(); }}
        onDrop={(e) => { if (canDropInto(rootPath)) { e.preventDefault(); dropOnDir(rootPath, e.altKey); } }}
        className="min-h-0 flex-1 select-none overflow-auto pb-3 pl-2 pr-0.5 outline-none [scrollbar-gutter:stable]"
      >
        {loading && shown.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-6 text-[12px] text-[var(--text-tertiary)]">
            <Spinner /> Loading project…
          </div>
        ) : (
          <>
            {shown.map((n) => (
              <Row
                key={n.path}
                node={n}
                depth={0}
                collapsed={collapsed}
                forceOpen={filtering}
                selectedPath={selectedPath}
                sel={sel}
                clusterEdges={clusterEdges}
                problemPaths={problemPaths}
                onClickRow={onRowClick}
                onContext={openMenu}
                onBeginDrag={beginDrag}
                onDropOnDir={dropOnDir}
                canDropInto={canDropInto}
              />
            ))}
            {shown.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
                {filtering ? "No matching files." : "Empty project."}
              </p>
            )}
          </>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-1 border-t border-[color:var(--line)] px-2 py-1.5">
        <button
          onClick={() => writeCollapsed(new Set())}
          title="Expand all"
          aria-label="Expand all"
          className="grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--hover)]"
        >
          <ExpandGlyph expanded />
        </button>
        <button
          onClick={() => writeCollapsed(new Set(allDirPaths(decorated)))}
          title="Collapse all"
          aria-label="Collapse all"
          className="grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--hover)]"
        >
          <ExpandGlyph />
        </button>
        {onToggleHidden && (
          <button
            onClick={onToggleHidden}
            title={showHidden ? "Hide build/tooling files (target, dotfiles…)" : "Show hidden files (target, dotfiles…)"}
            aria-label="Toggle hidden files"
            aria-pressed={showHidden}
            className={`ml-auto grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--hover)] ${showHidden ? "text-[var(--accent-strong)]" : "text-[var(--text-secondary)]"}`}
          >
            <EyeGlyph off={!showHidden} />
          </button>
        )}
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="context-menu fixed z-50 py-1" style={{ left: menu.x, top: menu.y }}>
            {MENU.map((m) => (
              <button key={m.kind} onClick={() => startCreate(m.kind)} className="context-item">
                {m.label}
              </button>
            ))}
            {(menu.targets.length > 0 || clip) && (
              <>
                <div className="my-1 h-px bg-[var(--surface-2)]" />
                {menu.targets.length > 0 && (
                  <>
                    <button onClick={() => cutCopy("cut")} className="context-item">
                      {menu.targets.length > 1 ? `Cut ${menu.targets.length} items` : "Cut"}
                    </button>
                    <button onClick={() => cutCopy("copy")} className="context-item">
                      {menu.targets.length > 1 ? `Copy ${menu.targets.length} items` : "Copy"}
                    </button>
                  </>
                )}
                {clip && (
                  <button onClick={() => void paste()} className="context-item">
                    Paste{clip.paths.length > 1 ? ` ${clip.paths.length} items` : ""} into {basename(menu.dir)}
                  </button>
                )}
              </>
            )}
            {menu.targets.length > 0 && (
              <>
                <div className="my-1 h-px bg-[var(--surface-2)]" />
                <button
                  onClick={() => { setConfirmDelete(menu.targets); setMenu(null); }}
                  className="context-item text-red-600"
                >
                  {menu.targets.length > 1 ? `Delete ${menu.targets.length} items` : "Delete"}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {prompt && (
        <>
          <div className="fixed inset-0 z-40 bg-black/10" onClick={() => setPrompt(null)} />
          <div className="context-menu fixed left-1/2 top-1/3 z-50 w-[min(340px,80vw)] -translate-x-1/2 p-3.5">
            <div className="mb-2 text-[13px] font-semibold text-[var(--text-primary)]">{PROMPT[prompt.kind].title}</div>
            <div className="mb-2 truncate text-[11px] text-[var(--text-tertiary)]">in {rel(prompt.dir)}</div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
                if (e.key === "Escape") setPrompt(null);
              }}
              placeholder={PROMPT[prompt.kind].placeholder}
              className="field w-full px-2.5 py-2 text-[12.5px]"
            />
            {PROMPT[prompt.kind].hint && !err && (
              <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">{PROMPT[prompt.kind].hint}</p>
            )}
            {err && <p className="mt-1.5 text-[11px] text-red-600">{err}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setPrompt(null)} className="btn-bezel px-3 py-1.5 text-[12px]">Cancel</button>
              <button onClick={() => void submit()} disabled={!name.trim() || busy} className="btn-accent px-3 py-1.5 text-[12px] disabled:opacity-50">
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </>
      )}

      {confirmDelete && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setConfirmDelete(null)} />
          <div className="context-menu fixed left-1/2 top-1/3 z-50 w-[min(380px,82vw)] -translate-x-1/2 p-4">
            <div className="mb-1 text-[13px] font-semibold text-[var(--text-primary)]">
              Delete {confirmDelete.length > 1 ? `${confirmDelete.length} items` : `“${basename(confirmDelete[0])}”`}?
            </div>
            {confirmDelete.length > 1 && (
              <ul className="mb-1 max-h-40 overflow-auto rounded border border-[color:var(--line)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)]">
                {confirmDelete.map((p) => (
                  <li key={p} className="truncate font-mono">{rel(p)}</li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-[11.5px] text-[var(--text-tertiary)]">This permanently deletes the file(s) and any contents. It can’t be undone.</p>
            {err && <p className="mt-1.5 text-[11px] text-red-600">{err}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="btn-bezel px-3 py-1.5 text-[12px]">Cancel</button>
              <button
                onClick={() => void doDelete()}
                disabled={busy}
                className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function filterTree(nodes: UiNode[], q: string): UiNode[] {
  const lower = q.toLowerCase();
  const walk = (n: UiNode): UiNode | null => {
    if (n.kind === "file") return n.name.toLowerCase().includes(lower) ? n : null;
    const children = (n.children ?? []).map(walk).filter((x): x is UiNode => x !== null);
    return children.length > 0 || n.name.toLowerCase().includes(lower) ? { ...n, children } : null;
  };
  return nodes.map(walk).filter((x): x is UiNode => x !== null);
}

function Row({
  node,
  depth,
  collapsed,
  forceOpen,
  selectedPath,
  sel,
  clusterEdges,
  problemPaths,
  onClickRow,
  onContext,
  onBeginDrag,
  onDropOnDir,
  canDropInto,
}: {
  node: UiNode;
  depth: number;
  collapsed: Set<string>;
  forceOpen: boolean;
  selectedPath: string | null;
  sel: Set<string>;
  clusterEdges: Map<string, { top: boolean; bottom: boolean }>;
  problemPaths: Set<string>;
  onClickRow: (e: React.MouseEvent, node: TreeNode) => void;
  onContext: (e: React.MouseEvent, node: TreeNode) => void;
  onBeginDrag: (node: TreeNode) => string[];
  onDropOnDir: (dir: string, copy: boolean) => void;
  canDropInto: (dir: string) => boolean;
}) {
  const isDir = node.kind === "dir";
  const open = isDir && (forceOpen || !collapsed.has(node.path));
  const selected = sel.has(node.path);
  const active = selected || (sel.size === 0 && selectedPath === node.path);
  const hasProblem = problemPaths.has(node.path);
  const [dropOver, setDropOver] = useState(false);
  // A row's drop target: a folder drops into itself, a file into its parent.
  const dropDir = isDir ? node.path : parentDir(node.path);

  // Cluster rendering: a contiguous run of selected rows draws as one shape.
  const edge = clusterEdges.get(node.path);
  const activeCls = !active
    ? "text-[var(--text-primary)]"
    : !edge || (edge.top && edge.bottom)
      ? "nav-row-active"
      : `nav-row-active nav-cluster ${edge.top ? "nav-cluster-top" : edge.bottom ? "nav-cluster-bottom" : "nav-cluster-mid"}`;

  return (
    <>
      <div
        draggable
        onDragStart={(e) => { const paths = onBeginDrag(node); e.dataTransfer.effectAllowed = "copyMove"; try { e.dataTransfer.setData("text/plain", paths.join("\n")); } catch { /* ignore */ } }}
        onDragOver={(e) => { if (canDropInto(dropDir)) { e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? "copy" : "move"; if (!dropOver) setDropOver(true); } }}
        onDragLeave={() => dropOver && setDropOver(false)}
        onDrop={(e) => { if (canDropInto(dropDir)) { e.preventDefault(); e.stopPropagation(); setDropOver(false); onDropOnDir(dropDir, e.altKey); } }}
        onClick={(e) => onClickRow(e, node)}
        onContextMenu={(e) => onContext(e, node)}
        style={{ paddingLeft: 6 + depth * 12 }}
        className={`nav-row flex items-center gap-1.5 py-[3px] pr-1.5 text-[12.5px] ${activeCls} ${dropOver ? "nav-row-drop" : ""}`}
      >
        {isDir ? <Chevron open={open} /> : <span className="w-3 shrink-0" />}
        {node.rootKind ? <RootIcon kind={node.rootKind} /> : node.isPackage ? <PackageIcon /> : <FileIcon name={node.name} isDir={isDir} javaKind={node.javaKind} />}
        <span className={`min-w-0 flex-1 truncate ${node.isPackage ? "text-[var(--text-secondary)]" : ""}`}>{node.name}</span>
        {node.rootKind && (
          <span className="shrink-0 rounded bg-[var(--surface-2)] px-1 text-[9.5px] uppercase tracking-wide text-[var(--text-tertiary)]">
            {node.rootKind === "sources" ? "src" : node.rootKind === "tests" ? "test" : node.rootKind === "resources" ? "res" : "test-res"}
          </span>
        )}
        {hasProblem && <span className="shrink-0 text-[10px] text-red-500">●</span>}
      </div>
      {isDir &&
        open &&
        (node.children ?? []).map((c) => (
          <Row
            key={c.path}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            forceOpen={forceOpen}
            selectedPath={selectedPath}
            sel={sel}
            clusterEdges={clusterEdges}
            problemPaths={problemPaths}
            onClickRow={onClickRow}
            onContext={onContext}
            onBeginDrag={onBeginDrag}
            onDropOnDir={onDropOnDir}
            canDropInto={canDropInto}
          />
        ))}
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
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
      className={`shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** A small spinning ring for the loading state. */
function Spinner() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="shrink-0 animate-spin text-[var(--text-tertiary)]">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
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

/** Eye icon; a slash through it when hidden files are off. */
function EyeGlyph({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

/** A flattened package (`com.foo.bar`): a small square-grid glyph. */
function PackageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M12 3v18M4 7.5l8 4.5 8-4.5" />
    </svg>
  );
}

/** A marked source root — colour-coded by role (sources/tests green-ish, etc.). */
function RootIcon({ kind }: { kind: RootKind }) {
  const color =
    kind === "sources" ? "text-[var(--accent)]"
    : kind === "tests" ? "text-green-600"
    : kind === "resources" ? "text-amber-500"
    : "text-teal-500";
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" className={`shrink-0 ${color}`}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <circle cx="12" cy="13" r="2.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Java files get the accent; folders and build files stay neutral. */
/** Type badge for a Java file: a filled circle with a letter (IntelliJ-style,
 *  in the app's red-orange family). Colour varies subtly by kind. */
const JAVA_BADGE: Record<NonNullable<TreeNode["javaKind"]>, { letter: string; fill: string }> = {
  class: { letter: "C", fill: "#e4551f" },
  interface: { letter: "I", fill: "#c2410c" },
  enum: { letter: "E", fill: "#b45309" },
  record: { letter: "R", fill: "#d1451b" },
  annotation: { letter: "@", fill: "#9a3412" },
};

function JavaBadge({ kind }: { kind: NonNullable<TreeNode["javaKind"]> }) {
  const { letter, fill } = JAVA_BADGE[kind];
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" className="shrink-0" aria-label={kind}>
      <circle cx="12" cy="12" r="9" fill={fill} />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fontFamily="ui-sans-serif, system-ui, sans-serif" fill="#fff">{letter}</text>
    </svg>
  );
}

function FileIcon({ name, isDir, javaKind }: { name: string; isDir: boolean; javaKind?: TreeNode["javaKind"] }) {
  if (isDir) {
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0 text-[var(--text-tertiary)]">
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </svg>
    );
  }
  if (javaKind) return <JavaBadge kind={javaKind} />;
  const java = name.endsWith(".java");
  const build = name === "pom.xml" || name.endsWith(".gradle") || name.endsWith(".gradle.kts");
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={`shrink-0 ${java ? "text-[var(--accent)]" : build ? "text-orange-500" : "text-[var(--text-tertiary)]"}`}
    >
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
