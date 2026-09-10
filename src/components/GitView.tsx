import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  gitBranches,
  gitCheckout,
  gitCherryPick,
  gitCherryPickHead,
  gitCommit,
  gitCommitFiles,
  gitCreateBranch,
  gitReset,
  gitResolve,
  gitRevert,
  gitLog,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitChange,
  type GitCommit,
  type GitFileChange,
} from "../lib/api";
import Resizer from "./Resizer";

interface Props {
  /** Repo/project root. */
  root: string;
  /** Open a commit's diff for a repo-relative file path as an editor tab. */
  onOpenDiff: (hash: string, relPath: string) => void;
  /** Open the working-tree diff for a repo-relative file path as an editor tab. */
  onOpenWorkingDiff: (relPath: string) => void;
  /** Open the actual working file (for manual conflict resolution). */
  onOpenFile: (relPath: string) => void;
}

type Sub = "history" | "changes" | "stage" | "branches";

/** The bottom-panel Git tab: an icon rail on the left switching between commit
 *  history, the current working-tree changes, and a branch graph. */
export default function GitView({ root, onOpenDiff, onOpenWorkingDiff, onOpenFile }: Props) {
  const [sub, setSub] = useState<Sub>("history");
  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[64px] shrink-0 flex-col gap-1 border-r border-[color:var(--line)] py-2">
        <RailTab active={sub === "history"} onClick={() => setSub("history")} label="History" icon={<HistoryIcon />} />
        <RailTab active={sub === "changes"} onClick={() => setSub("changes")} label="Changes" icon={<ChangesIcon />} />
        <RailTab active={sub === "stage"} onClick={() => setSub("stage")} label="Stage" icon={<StageIcon />} />
        <RailTab active={sub === "branches"} onClick={() => setSub("branches")} label="Branches" icon={<BranchIcon />} />
      </nav>
      <div className="min-w-0 flex-1">
        {sub === "history" && <CommitHistory root={root} onOpenDiff={onOpenDiff} />}
        {sub === "changes" && <CurrentChanges root={root} onOpenDiff={onOpenWorkingDiff} onOpenFile={onOpenFile} />}
        {sub === "stage" && <StagePanel root={root} onOpenDiff={onOpenWorkingDiff} />}
        {sub === "branches" && <BranchGraph root={root} />}
      </div>
    </div>
  );
}

function RailTab({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`mx-1.5 flex flex-col items-center gap-1 rounded-md py-2 text-[10px] font-medium transition-colors ${
        active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-tertiary)] hover:bg-[var(--hover)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// --- Commit history ---------------------------------------------------------

function CommitHistory({ root, onOpenDiff }: { root: string; onOpenDiff: (hash: string, relPath: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["git-log", root, false],
    queryFn: () => gitLog(root, false),
  });
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const [detailW, setDetailW] = useState(() => persistedWidth("git.commitDetail", 300));
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return data ?? [];
    return (data ?? []).filter((c) =>
      `${c.subject} ${c.author} ${c.email} ${c.short} ${c.hash} ${c.refs.join(" ")}`.toLowerCase().includes(q),
    );
  }, [data, q]);

  if (isLoading) return <Center>Loading history…</Center>;
  if (!data || data.length === 0) return <Center>No commits.</Center>;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[color:var(--line)] p-1.5">
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
              <SearchMini />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter commits — message, author, hash…"
              className="field w-full py-1 pl-7 pr-6 text-[12px]"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                title="Clear"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--hover)]"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <Empty>No commits match “{query}”.</Empty>
          ) : (
            filtered.map((c) => (
              <button
                key={c.hash}
                onClick={() => setSelected(c)}
                className={`flex w-full items-start gap-2 border-b border-[color:var(--line)] px-3 py-1.5 text-left ${
                  selected?.hash === c.hash ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--hover)]"
                }`}
              >
                <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Refs refs={c.refs} />
                    <span className="truncate text-[12px] text-[var(--text-primary)]">{c.subject}</span>
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-tertiary)]">
                    <span className="font-mono">{c.short}</span> · {c.author} · {relTime(c.time)}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {selected && (
        <>
          <Resizer width={detailW} setWidth={setDetailW} dir={-1} min={220} max={560} onReset={() => setDetailW(300)} />
          <div className="shrink-0 border-l border-[color:var(--line)]" style={{ width: detailW }}>
            <CommitDetail root={root} commit={selected} onClose={() => setSelected(null)} onOpenDiff={onOpenDiff} />
          </div>
        </>
      )}
    </div>
  );
}

function persistedWidth(key: string, fallback: number) {
  const v = Number(localStorage.getItem(`layout.${key}`));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function CommitDetail({
  root,
  commit,
  onClose,
  onOpenDiff,
}: {
  root: string;
  commit: GitCommit;
  onClose: () => void;
  onOpenDiff: (hash: string, relPath: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["git-commit-files", root, commit.hash],
    queryFn: () => gitCommitFiles(root, commit.hash),
  });
  const tree = useMemo(() => (data ? buildTree(data) : null), [data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-[color:var(--line)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{commit.subject}</div>
          <div className="truncate text-[11px] text-[var(--text-tertiary)]">
            <span className="font-mono">{commit.short}</span> · {commit.author} · {relTime(commit.time)}
          </div>
        </div>
        <button onClick={onClose} title="Close" className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--hover)]">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {isLoading ? (
          <Empty>Loading…</Empty>
        ) : !data || data.length === 0 || !tree ? (
          <Empty>No file changes.</Empty>
        ) : (
          <>
            <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {data.length} file{data.length === 1 ? "" : "s"} changed
            </div>
            {tree.children.map((n) => (
              <FileNodeView key={n.path} node={n} depth={0} onPick={(rel) => onOpenDiff(commit.hash, rel)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

type TNode = { name: string; path: string; dir: boolean; status?: string; children: TNode[] };

/** Fold the flat changed-file list into a directory hierarchy. */
function buildTree(files: GitFileChange[]): TNode {
  const root: TNode = { name: "", path: "", dir: true, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.dir === !leaf);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), dir: !leaf, status: leaf ? f.status : undefined, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n: TNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function FileNodeView({
  node,
  depth,
  onPick,
}: {
  node: TNode;
  depth: number;
  onPick: (relPath: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: 8 + depth * 12 };
  if (node.dir) {
    return (
      <div>
        <button onClick={() => setOpen((o) => !o)} style={pad} className="flex w-full items-center gap-1 py-[3px] pr-2 text-left hover:bg-[var(--hover)]">
          <span className="w-2.5 shrink-0 text-[var(--text-tertiary)]">{open ? "▾" : "▸"}</span>
          <FolderMini />
          <span className="truncate text-[12px] text-[var(--text-secondary)]">{node.name}</span>
        </button>
        {open && node.children.map((c) => <FileNodeView key={c.path} node={c} depth={depth + 1} onPick={onPick} />)}
      </div>
    );
  }
  return (
    <button
      onClick={() => onPick(node.path)}
      title={node.path}
      style={pad}
      className="flex w-full items-center gap-1.5 py-[3px] pr-2 text-left hover:bg-[var(--hover)]"
    >
      <span className="w-2.5 shrink-0" />
      <StatusBadge code={node.status ?? "M"} />
      <span className="truncate text-[12px] text-[var(--text-primary)]">{node.name}</span>
    </button>
  );
}

function FolderMini() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// --- Current changes --------------------------------------------------------

/** Porcelain XY codes that mark an unmerged (conflicted) path. */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
function isConflict(c: GitChange): boolean {
  return CONFLICT_CODES.has(`${c.staged}${c.unstaged}`);
}
/** Human phrasing of the two conflict sides for a given XY code. */
function conflictKind(c: GitChange): string {
  return { DD: "both deleted", AU: "added by us", UD: "deleted by them", UA: "added by them", DU: "deleted by us", AA: "both added", UU: "both modified" }[`${c.staged}${c.unstaged}`] ?? "conflict";
}

function CurrentChanges({ root, onOpenDiff, onOpenFile }: { root: string; onOpenDiff: (relPath: string) => void; onOpenFile: (relPath: string) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["git-status", root],
    queryFn: () => gitStatus(root),
    refetchInterval: 3000,
  });
  const [resolving, setResolving] = useState<GitChange | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["git-status", root] });
  const stage = async (paths: string[]) => { try { await gitStage(root, paths); refresh(); } catch (e) { alert(String(e)); } };
  const unstage = async (paths: string[]) => { try { await gitUnstage(root, paths); refresh(); } catch (e) { alert(String(e)); } };

  if (isLoading) return <Center>Loading changes…</Center>;
  if (!data || data.length === 0) return <Center>Working tree clean.</Center>;

  const conflicts = data.filter(isConflict);
  const rest = data.filter((c) => !isConflict(c));
  const staged = rest.filter((c) => c.staged !== " " && c.staged !== "?");
  const unstaged = rest.filter((c) => c.unstaged !== " " && c.unstaged !== "?");
  const untracked = rest.filter((c) => c.staged === "?");
  const unstagedAll = [...unstaged, ...untracked].map((c) => c.path);

  return (
    <div className="h-full overflow-auto py-1">
      {conflicts.length > 0 && (
        <ConflictGroup
          items={conflicts}
          onOpen={onOpenFile}
          onResolve={(c) => setResolving(c)}
        />
      )}
      <ChangeGroup title="Staged" items={staged} pick={(c) => c.staged} onOpen={onOpenDiff} action="unstage" onAction={(p) => unstage([p])}
        bulk={staged.length ? { label: "Unstage all", run: () => unstage(staged.map((c) => c.path)) } : undefined} />
      <ChangeGroup title="Changes" items={unstaged} pick={(c) => c.unstaged} onOpen={onOpenDiff} action="stage" onAction={(p) => stage([p])} />
      <ChangeGroup title="Untracked" items={untracked} pick={() => "?"} onOpen={onOpenDiff} action="stage" onAction={(p) => stage([p])}
        bulk={unstagedAll.length ? { label: "Stage all", run: () => stage(unstagedAll) } : undefined} />

      {resolving && (
        <ConflictResolver
          root={root}
          change={resolving}
          onOpenFile={onOpenFile}
          onDone={() => { setResolving(null); refresh(); }}
          onClose={() => setResolving(null)}
        />
      )}
    </div>
  );
}

/** The conflicted-files group: red entries, each with a Resolve button. */
function ConflictGroup({ items, onOpen, onResolve }: { items: GitChange[]; onOpen: (path: string) => void; onResolve: (c: GitChange) => void }) {
  return (
    <div className="mb-1">
      <div className="flex items-center px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-red-600">
        <ConflictIcon />
        <span className="ml-1">Conflicts <span className="tabular-nums">({items.length})</span></span>
      </div>
      {items.map((c) => (
        <div key={`conflict-${c.path}`} className="group flex w-full items-center bg-red-500/5 hover:bg-red-500/10">
          <button onClick={() => onOpen(c.path)} title="Open file to resolve" className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left">
            <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-red-500/20 text-[10px] font-bold text-red-600">!</span>
            <span className="min-w-0 flex-1 truncate text-[12px]">
              <span className="text-red-500/70">{dir(c.path)}</span>
              <span className="font-medium text-red-600">{base(c.path)}</span>
              <span className="ml-1.5 text-[10.5px] font-normal text-red-500/70">{conflictKind(c)}</span>
            </span>
          </button>
          <button
            onClick={() => onResolve(c)}
            className="mr-2 shrink-0 rounded bg-red-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-red-600 hover:bg-red-500/25"
          >
            Resolve
          </button>
        </div>
      ))}
    </div>
  );
}

/** A small dialog offering ways to resolve one conflicted file. */
function ConflictResolver({ root, change, onOpenFile, onDone, onClose }: {
  root: string;
  change: GitChange;
  onOpenFile: (relPath: string) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const take = async (side: "ours" | "theirs") => {
    setBusy(side); setErr(null);
    try { await gitResolve(root, change.path, side); onDone(); }
    catch (e) { setErr(String(e)); setBusy(null); }
  };
  const markResolved = async () => {
    setBusy("mark"); setErr(null);
    try { await gitStage(root, [change.path]); onDone(); }
    catch (e) { setErr(String(e)); setBusy(null); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="switch-dialog w-[440px] max-w-full rounded-xl p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
          <ConflictIcon /> Resolve conflict
        </div>
        <p className="mb-3 break-all text-[11.5px] text-[var(--text-tertiary)]">{change.path} · {conflictKind(change)}</p>

        <div className="flex flex-col gap-2">
          <ResolveOption
            title="Edit manually"
            detail="Open the file and resolve the <<<<<<< / ======= / >>>>>>> markers yourself, then Mark resolved."
            onClick={() => { onOpenFile(change.path); onClose(); }}
          />
          <ResolveOption title="Use current (ours)" detail="Keep this branch's version and discard the incoming changes for this file." busy={busy === "ours"} onClick={() => void take("ours")} />
          <ResolveOption title="Use incoming (theirs)" detail="Take the incoming version and discard this branch's changes for this file." busy={busy === "theirs"} onClick={() => void take("theirs")} />
          <ResolveOption title="Mark resolved" detail="Stage the file as-is (after you've edited it) to clear the conflict." busy={busy === "mark"} onClick={() => void markResolved()} />
        </div>

        {err && <p className="mt-3 text-[11px] text-red-600">{err}</p>}
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12px]">Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResolveOption({ title, detail, busy, onClick }: { title: string; detail: string; busy?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={busy} className="rounded-lg border border-[color:var(--line)] bg-[var(--control-bg)] p-2.5 text-left hover:border-[color:var(--accent-soft)] disabled:opacity-50">
      <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{busy ? "Working…" : title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">{detail}</div>
    </button>
  );
}

function ConflictIcon() {
  return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-red-600"><path d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>;
}

function ChangeGroup({
  title,
  items,
  pick,
  onOpen,
  action,
  onAction,
  bulk,
}: {
  title: string;
  items: GitChange[];
  pick: (c: GitChange) => string;
  onOpen: (path: string) => void;
  action: "stage" | "unstage";
  onAction: (path: string) => void;
  bulk?: { label: string; run: () => void };
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="flex items-center px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        <span>{title} <span className="tabular-nums">({items.length})</span></span>
        {bulk && (
          <button onClick={bulk.run} className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium normal-case text-[var(--accent-strong)] hover:bg-[var(--hover)]">
            {bulk.label}
          </button>
        )}
      </div>
      {items.map((c) => (
        <div key={`${title}-${c.path}`} className="group flex w-full items-center hover:bg-[var(--hover)]">
          <button onClick={() => onOpen(c.path)} title="Open diff" className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left">
            <StatusBadge code={pick(c)} />
            <span className="min-w-0 flex-1 truncate text-[12px]">
              <span className="text-[var(--text-tertiary)]">{dir(c.path)}</span>
              <span className="text-[var(--text-primary)]">{base(c.path)}</span>
            </span>
          </button>
          <button
            onClick={() => onAction(c.path)}
            title={action === "stage" ? "Stage" : "Unstage"}
            className="mr-2 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-primary)] group-hover:flex"
          >
            {action === "stage" ? "+" : "−"}
          </button>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ code }: { code: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    M: { label: "M", cls: "bg-yellow-500/20 text-yellow-700" },
    A: { label: "A", cls: "bg-green-500/20 text-green-700" },
    D: { label: "D", cls: "bg-red-500/15 text-red-600" },
    R: { label: "R", cls: "bg-blue-500/15 text-blue-600" },
    C: { label: "C", cls: "bg-blue-500/15 text-blue-600" },
    "?": { label: "U", cls: "bg-black/10 text-[var(--text-tertiary)]" },
  };
  const m = map[code] ?? { label: code.trim() || "•", cls: "bg-black/10 text-[var(--text-tertiary)]" };
  return <span className={`grid h-4 w-4 shrink-0 place-items-center rounded text-[10px] font-bold ${m.cls}`}>{m.label}</span>;
}

// --- Stage / commit ---------------------------------------------------------

function StagePanel({ root, onOpenDiff }: { root: string; onOpenDiff: (relPath: string) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["git-status", root],
    queryFn: () => gitStatus(root),
    refetchInterval: 3000,
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staged = (data ?? []).filter((c) => c.staged !== " " && c.staged !== "?");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["git-status", root] });
    qc.invalidateQueries({ queryKey: ["git-log", root] });
  };

  const unstage = async (paths: string[]) => {
    setError(null);
    try {
      await gitUnstage(root, paths);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const commit = async () => {
    if (!message.trim() || staged.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await gitCommit(root, message.trim());
      setMessage("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        <span>Staged <span className="tabular-nums">({staged.length})</span></span>
        {staged.length > 0 && (
          <button onClick={() => unstage(staged.map((c) => c.path))} className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium normal-case text-[var(--accent-strong)] hover:bg-[var(--hover)]">
            Unstage all
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <Empty>Loading…</Empty>
        ) : staged.length === 0 ? (
          <Empty>Nothing staged. Stage files from the Changes tab (hover a file → +).</Empty>
        ) : (
          staged.map((c) => (
            <div key={c.path} className="group flex w-full items-center hover:bg-[var(--hover)]">
              <button onClick={() => onOpenDiff(c.path)} title="Open diff" className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left">
                <StatusBadge code={c.staged} />
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  <span className="text-[var(--text-tertiary)]">{dir(c.path)}</span>
                  <span className="text-[var(--text-primary)]">{base(c.path)}</span>
                </span>
              </button>
              <button
                onClick={() => unstage([c.path])}
                title="Unstage"
                className="mr-2 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-primary)] group-hover:flex"
              >
                −
              </button>
            </div>
          ))
        )}
      </div>

      {error && (
        <div className="mx-3 mb-2 shrink-0 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-700">
          {error}
        </div>
      )}

      <form
        className="shrink-0 border-t border-[color:var(--line)] p-2"
        onSubmit={(e) => { e.preventDefault(); void commit(); }}
      >
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void commit(); }
          }}
          placeholder="Commit message… (⌘⏎ to commit)"
          rows={2}
          className="field block max-h-32 min-h-[42px] w-full resize-none px-2 py-1.5 text-[12px] leading-relaxed"
        />
        <div className="mt-1.5 flex items-center justify-end">
          <button
            type="submit"
            disabled={busy || staged.length === 0 || !message.trim()}
            className="btn-accent px-3 py-1 text-[12px] disabled:opacity-40"
          >
            {busy ? "Committing…" : `Commit ${staged.length || ""}`.trim()}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Branch graph (GitKraken-style lanes) -----------------------------------

const ROWH = 30;
const COLW = 14;
const PADX = 14;
const LANE_COLORS = ["#E4551F", "#2f9e44", "#1c7ed6", "#ae3ec9", "#f08c00", "#0ca678", "#e64980", "#7048e8"];

function BranchGraph({ root }: { root: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["git-log", root, true],
    queryFn: () => gitLog(root, true, 300),
  });
  const { data: branches } = useQuery({ queryKey: ["git-branches", root], queryFn: () => gitBranches(root) });

  const [menu, setMenu] = useState<{ x: number; y: number; commit: GitCommit } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["git-log"] });
    qc.invalidateQueries({ queryKey: ["git-branches"] });
    qc.invalidateQueries({ queryKey: ["git-branch"] });
    qc.invalidateQueries({ queryKey: ["git-status"] });
  };
  const runGit = async (op: () => Promise<string>, ok: string) => {
    setMenu(null);
    try {
      await op();
      setError(null);
      refresh();
    } catch (e) {
      setError(`${ok} failed: ${String(e)}`);
    }
  };

  const model = useMemo(() => (data ? layout(data) : null), [data]);

  if (isLoading) return <Center>Loading branches…</Center>;
  if (!data || data.length === 0 || !model) return <Center>No commits.</Center>;

  const { col, rowOf, maxCol } = model;
  const graphW = PADX * 2 + maxCol * COLW;
  const x = (c: number) => PADX + c * COLW;
  const y = (i: number) => i * ROWH + ROWH / 2;

  return (
    <div className="h-full overflow-auto">
      <div className="relative" style={{ height: data.length * ROWH }}>
        <svg className="pointer-events-none absolute left-0 top-0" width={graphW} height={data.length * ROWH}>
          {/* edges: each commit → its parents */}
          {data.map((c, i) =>
            c.parents.map((p) => {
              const pi = rowOf.get(p);
              if (pi == null) return null;
              const c1 = col.get(c.hash)!;
              const c2 = col.get(p)!;
              const color = LANE_COLORS[Math.min(c1, c2) % LANE_COLORS.length];
              return (
                <path
                  key={`${c.hash}-${p}`}
                  d={edge(x(c1), y(i), x(c2), y(pi))}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              );
            }),
          )}
          {/* nodes */}
          {data.map((c, i) => {
            const cc = col.get(c.hash)!;
            const color = LANE_COLORS[cc % LANE_COLORS.length];
            const head = c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD ->"));
            return (
              <g key={c.hash}>
                {head && <circle cx={x(cc)} cy={y(i)} r={6.5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.5} />}
                <circle cx={x(cc)} cy={y(i)} r={4.5} fill={color} stroke="var(--bg-elevated, #fff)" strokeWidth={2} />
              </g>
            );
          })}
        </svg>

        {/* text rows, offset past the graph */}
        <div style={{ marginLeft: graphW }}>
          {data.map((c) => (
            <div
              key={c.hash}
              className="flex cursor-default items-center gap-2 overflow-hidden pr-3 hover:bg-[var(--hover)]"
              style={{ height: ROWH }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, commit: c });
              }}
            >
              <Refs refs={c.refs} />
              <span className="truncate text-[12px] text-[var(--text-primary)]">{c.subject}</span>
              <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-[var(--text-tertiary)]">
                <span className="font-mono">{c.short}</span> · {c.author} · {relTime(c.time)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-[color:var(--line)] bg-[var(--panel-solid)] px-3 py-1.5 text-[11px] text-red-500">
          <span className="flex-1">{error}</span>
          <button className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {menu && (
        <CommitMenu
          x={menu.x}
          y={menu.y}
          commit={menu.commit}
          branches={branches ?? []}
          onClose={() => setMenu(null)}
          onCheckout={() => void runGit(() => gitCheckout(root, menu.commit.hash), "Checkout")}
          onCreateBranch={(name) => void runGit(() => gitCreateBranch(root, name, menu.commit.hash), "Create branch")}
          onCherryPick={(branch) => void runGit(() => gitCherryPick(root, branch, menu.commit.hash), "Cherry-pick")}
          onCherryPickHead={() => void runGit(() => gitCherryPickHead(root, menu.commit.hash), "Cherry-pick")}
          onRevert={() => void runGit(() => gitRevert(root, menu.commit.hash), "Revert")}
          onReset={(mode) => void runGit(() => gitReset(root, menu.commit.hash, mode), "Reset")}
        />
      )}
    </div>
  );
}

/** Right-click menu for a commit: checkout, new branch from here, cherry-pick. */
function CommitMenu({
  x,
  y,
  commit,
  branches,
  onClose,
  onCheckout,
  onCreateBranch,
  onCherryPick,
  onCherryPickHead,
  onRevert,
  onReset,
}: {
  x: number;
  y: number;
  commit: GitCommit;
  branches: string[];
  onClose: () => void;
  onCheckout: () => void;
  onCreateBranch: (name: string) => void;
  onCherryPick: (branch: string) => void;
  onCherryPickHead: () => void;
  onRevert: () => void;
  onReset: (mode: "soft" | "mixed" | "hard") => void;
}) {
  const [mode, setMode] = useState<"menu" | "newbranch" | "cherry" | "reset" | "resetHard">("menu");
  const [name, setName] = useState("");
  const itemCls =
    "flex w-full items-center gap-6 px-3 py-1 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]";

  return createPortal(
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="context-menu fixed z-[80] max-h-[60vh] min-w-[220px] overflow-y-auto py-1" style={{ left: x, top: y }}>
        <div className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">
          <span className="font-mono">{commit.short}</span> {commit.subject}
        </div>
        <div className="my-1 border-t border-[color:var(--line)]" />
        {mode === "menu" && (
          <>
            <button className={itemCls} onClick={onCheckout}>
              Checkout Revision
            </button>
            <button className={itemCls} onClick={() => setMode("newbranch")}>
              New Branch from Here…
            </button>
            <div className="my-1 border-t border-[color:var(--line)]" />
            <button className={itemCls} onClick={onCherryPickHead}>
              Cherry-Pick onto Current Branch
            </button>
            <button className={itemCls} onClick={() => setMode("cherry")}>
              Cherry-Pick onto… <span className="ml-auto text-[var(--text-tertiary)]">▸</span>
            </button>
            <button className={itemCls} onClick={onRevert}>
              Revert Commit
            </button>
            <div className="my-1 border-t border-[color:var(--line)]" />
            <button className={itemCls} onClick={() => setMode("reset")}>
              Reset Current Branch to Here… <span className="ml-auto text-[var(--text-tertiary)]">▸</span>
            </button>
          </>
        )}
        {mode === "reset" && (
          <>
            <div className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">Reset — keep changes as…</div>
            <button className={itemCls} onClick={() => onReset("soft")}>
              Soft <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">keep staged</span>
            </button>
            <button className={itemCls} onClick={() => onReset("mixed")}>
              Mixed <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">unstage</span>
            </button>
            <button className={`${itemCls} text-red-500`} onClick={() => setMode("resetHard")}>
              Hard <span className="ml-auto text-[11px] text-red-400">discard changes</span>
            </button>
          </>
        )}
        {mode === "resetHard" && (
          <>
            <div className="px-3 py-1.5 text-[11px] text-red-500">
              Hard reset discards all uncommitted changes. Continue?
            </div>
            <button className={`${itemCls} text-red-500`} onClick={() => onReset("hard")}>
              Yes, reset --hard to {commit.short}
            </button>
            <button className={itemCls} onClick={() => setMode("reset")}>
              Cancel
            </button>
          </>
        )}
        {mode === "newbranch" && (
          <form
            className="px-2 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onCreateBranch(name.trim());
            }}
          >
            <div className="mb-1 text-[11px] text-[var(--text-tertiary)]">New branch name (⏎ to create)</div>
            <input
              autoFocus
              spellCheck={false}
              className="field w-full px-2 py-1 text-[12px]"
              placeholder="feature/…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setMode("menu")}
            />
          </form>
        )}
        {mode === "cherry" && (
          <>
            <div className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">Cherry-pick onto branch:</div>
            {branches.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">No branches.</div>
            ) : (
              branches.map((b) => (
                <button key={b} className={itemCls} onClick={() => onCherryPick(b)}>
                  {b}
                </button>
              ))
            )}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

/** Assign each commit a lane column, and record its row. Newest-first input. */
function layout(commits: GitCommit[]): { col: Map<string, number>; rowOf: Map<string, number>; maxCol: number } {
  const col = new Map<string, number>();
  const rowOf = new Map<string, number>();
  const lanes: (string | null)[] = []; // per column: the hash that column currently expects
  let maxCol = 0;

  commits.forEach((c, i) => {
    rowOf.set(c.hash, i);
    // The commit sits in a lane reserved for it, else claims a free lane.
    let idx = lanes.indexOf(c.hash);
    if (idx === -1) {
      idx = lanes.indexOf(null);
      if (idx === -1) {
        idx = lanes.length;
        lanes.push(null);
      }
    }
    col.set(c.hash, idx);
    maxCol = Math.max(maxCol, idx);

    // Free every lane that was waiting on this commit (merge collapse).
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null;

    // First parent continues this commit's lane; extra parents branch out.
    const [p0, ...rest] = c.parents;
    if (p0) lanes[idx] = lanes.includes(p0) ? null : p0;
    else lanes[idx] = null;
    for (const p of rest) {
      if (!lanes.includes(p)) {
        let free = lanes.indexOf(null);
        if (free === -1) {
          free = lanes.length;
          lanes.push(null);
        }
        lanes[free] = p;
        maxCol = Math.max(maxCol, free);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });

  return { col, rowOf, maxCol };
}

/** A commit → parent connector: vertical near both ends, easing between lanes. */
function edge(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`;
  return `M${x1} ${y1} C ${x1} ${y1 + ROWH * 0.6} ${x2} ${y2 - ROWH * 0.6} ${x2} ${y2}`;
}

// --- shared bits ------------------------------------------------------------

function Refs({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {refs.map((r, i) => {
        const isTag = r.startsWith("tag: ");
        const name = isTag ? r.slice(5) : r.replace(/^HEAD -> /, "");
        const isHead = r === "HEAD" || r.startsWith("HEAD ->");
        if (r === "HEAD") return null; // detached HEAD shown via the ring only
        return (
          <span
            key={i}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              isTag
                ? "bg-purple-500/15 text-purple-600"
                : isHead
                  ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                  : name.includes("/")
                    ? "bg-[var(--surface-2)] text-[var(--text-tertiary)]"
                    : "bg-blue-500/12 text-blue-600"
            }`}
          >
            {isTag ? `⌂ ${name}` : name}
          </span>
        );
      })}
    </span>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-[12px] text-[var(--text-tertiary)]">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-[11.5px] text-[var(--text-tertiary)]">{children}</div>;
}

function relTime(unixSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function dir(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i + 1);
}
function base(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// --- icons ------------------------------------------------------------------

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}
function ChangesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v6M9 6h6" />
      <path d="M12 15v6M9 18h6" opacity="0.55" />
      <path d="M4 12h16" />
    </svg>
  );
}
function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <path d="M6 8.4v7.2M6 12a6 6 0 0 0 6-6h3.6" />
    </svg>
  );
}
function SearchMini() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function StageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v10M8 9l4 4 4-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}
