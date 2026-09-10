import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { chatCancel, taskAgent, type ChatMsg, type GeneratedTask } from "../lib/api";
import SpecDialog from "./SpecDialog";
import TaskDetailDialog from "./TaskDetailDialog";
import {
  agentStatusMeta,
  loadBoards,
  loadSelectedBoardId,
  newBoard,
  newId,
  saveBoards,
  saveSelectedBoardId,
  type AgentStatus,
  type Board,
  type Column,
  type Comment,
  type Spec,
  type SpecRef,
  type Task,
} from "../lib/taskBoards";

interface Props {
  root: string;
  onClose: () => void;
}

/** Parse the agent's trailing `STATUS:` control token; returns the resulting
 *  status and the reply body with that line stripped. */
function parseAgentStatus(reply: string): { status: AgentStatus; body: string } {
  const m = reply.match(/STATUS:\s*(DONE|NEEDS_INPUT|REVIEW|BLOCKED)\s*$/im);
  const map: Record<string, AgentStatus> = { DONE: "done", NEEDS_INPUT: "waiting", REVIEW: "review", BLOCKED: "blocked" };
  if (m && m.index != null) return { status: map[m[1].toUpperCase()], body: reply.slice(0, m.index).trim() };
  return { status: "waiting", body: reply.trim() };
}

/** A Trello-style task board: freely reorderable customizable columns, cards,
 *  versioned specs with AI generation, and agents that work tickets and report
 *  progress in each ticket's comment thread. State persists per project. */
export default function TaskBoardDialog({ root, onClose }: Props) {
  const [boards, setBoards] = useState<Board[]>(() => loadBoards(root));
  const [selId, setSelId] = useState<string>(() => {
    const saved = loadSelectedBoardId(root);
    const list = loadBoards(root);
    return list.find((b) => b.id === saved)?.id ?? list[0].id;
  });
  const board = boards.find((b) => b.id === selId) ?? boards[0];

  const [boardMenu, setBoardMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [specFocus, setSpecFocus] = useState<{ specId: string; version: number } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Live streaming buffer for the single currently-running agent.
  const [live, setLive] = useState<{ taskId: string; text: string; activity: string } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const runningRef = useRef<string | null>(null);
  runningRef.current = runningId;

  // --- persistence (functional so sequential writes in one handler compose) ---
  const mutate = (fn: (bs: Board[]) => Board[]) =>
    setBoards((prev) => { const next = fn(prev); saveBoards(root, next); return next; });
  const updateBoard = (fn: (b: Board) => Board) => mutate((bs) => bs.map((b) => (b.id === board.id ? fn(b) : b)));
  const selectBoard = (id: string) => { setSelId(id); saveSelectedBoardId(root, id); };

  // --- board ops ---
  const addBoard = () => {
    const b = newBoard(`Board ${boards.length + 1}`);
    mutate((bs) => [...bs, b]);
    selectBoard(b.id);
    setBoardMenu(false);
    setRenaming(true);
  };
  const deleteBoard = () => {
    if (boards.length <= 1) return;
    const next = boards.filter((b) => b.id !== board.id);
    mutate(() => next);
    selectBoard(next[0].id);
  };

  // --- column ops ---
  const addColumn = () => updateBoard((b) => ({ ...b, columns: [...b.columns, { id: newId(), name: "New column", tasks: [] }] }));
  const renameColumn = (colId: string, name: string) =>
    updateBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === colId ? { ...c, name } : c)) }));
  const deleteColumn = (colId: string) => updateBoard((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== colId) }));
  const moveColumn = (colId: string, beforeId: string | null) =>
    updateBoard((b) => {
      if (colId === beforeId) return b;
      const cols = [...b.columns];
      const from = cols.findIndex((c) => c.id === colId);
      if (from < 0) return b;
      const [moved] = cols.splice(from, 1);
      const idx = beforeId == null ? cols.length : cols.findIndex((c) => c.id === beforeId);
      cols.splice(idx < 0 ? cols.length : idx, 0, moved);
      return { ...b, columns: cols };
    });

  // --- task ops ---
  const addTask = (colId: string, title: string) => {
    const t: Task = { id: newId(), title: title.trim() };
    if (!t.title) return;
    updateBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === colId ? { ...c, tasks: [...c.tasks, t] } : c)) }));
  };
  const patchTask = (taskId: string, patch: Partial<Task>) =>
    updateBoard((b) => ({ ...b, columns: b.columns.map((c) => ({ ...c, tasks: c.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) })) }));
  const deleteTask = (taskId: string) =>
    updateBoard((b) => ({ ...b, columns: b.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== taskId) })) }));
  const addComment = (taskId: string, author: Comment["author"], text: string) => {
    const c: Comment = { id: newId(), author, text: text.trim(), at: Date.now() };
    if (!c.text) return;
    updateBoard((b) => ({
      ...b,
      columns: b.columns.map((col) => ({ ...col, tasks: col.tasks.map((t) => (t.id === taskId ? { ...t, comments: [...(t.comments ?? []), c] } : t)) })),
    }));
  };
  const moveTask = (taskId: string, fromCol: string, toCol: string, beforeId?: string) => {
    if (fromCol === toCol && !beforeId) return;
    updateBoard((b) => {
      let moved: Task | undefined;
      const stripped = b.columns.map((c) => {
        if (c.id !== fromCol) return c;
        moved = c.tasks.find((t) => t.id === taskId);
        return { ...c, tasks: c.tasks.filter((t) => t.id !== taskId) };
      });
      if (!moved) return b;
      return {
        ...b,
        columns: stripped.map((c) => {
          if (c.id !== toCol) return c;
          if (!beforeId) return { ...c, tasks: [...c.tasks, moved!] };
          const idx = c.tasks.findIndex((t) => t.id === beforeId);
          const tasks = [...c.tasks];
          tasks.splice(idx < 0 ? tasks.length : idx, 0, moved!);
          return { ...c, tasks };
        }),
      };
    });
  };

  // --- agent orchestration ---
  const buildContext = (task: Task): string => {
    let s = `## ${task.title}\n\n`;
    if (task.description) s += `${task.description}\n\n`;
    if (task.spec) {
      const spec = board.specs.find((x) => x.id === task.spec!.specId);
      const ver = spec?.versions.find((v) => v.version === task.spec!.version);
      if (ver) s += `### Source spec — ${task.spec.specTitle} (v${task.spec.version})\n\n${ver.content}\n`;
    }
    return s;
  };
  const toMsgs = (comments?: Comment[]): ChatMsg[] =>
    (comments ?? []).filter((c) => c.author !== "system").map((c) => ({ role: c.author === "agent" ? "assistant" : "user", content: c.text }));

  const runAgent = async (task: Task, msgs: ChatMsg[]) => {
    if (runningRef.current) return; // one agent at a time (shared CLI handle)
    runningRef.current = task.id;
    setRunningId(task.id);
    setLive({ taskId: task.id, text: "", activity: "" });
    patchTask(task.id, { agentStatus: "working" });
    try {
      const reply = await taskAgent(task.id, buildContext(task), msgs, root);
      const { status, body } = parseAgentStatus(reply);
      if (body) addComment(task.id, "agent", body);
      patchTask(task.id, { agentStatus: status });
    } catch (e) {
      addComment(task.id, "system", `⚠️ Agent error: ${String(e)}`);
      patchTask(task.id, { agentStatus: "error" });
    } finally {
      runningRef.current = null;
      setRunningId(null);
      setLive(null);
    }
  };

  const assignToAgent = (task: Task, colId: string) => {
    if (runningRef.current) return;
    const colName = board.columns.find((c) => c.id === colId)?.name ?? "";
    const sys: Comment = { id: newId(), author: "system", text: `Assigned to agent · status set to “${colName}”.`, at: Date.now() };
    updateBoard((b) => {
      let moved: Task | undefined;
      const stripped = b.columns.map((c) => {
        if (!c.tasks.some((t) => t.id === task.id)) return c;
        moved = c.tasks.find((t) => t.id === task.id);
        return { ...c, tasks: c.tasks.filter((t) => t.id !== task.id) };
      });
      if (!moved) return b;
      const updated: Task = { ...moved, assignee: "agent", agentStatus: "working", comments: [...(moved.comments ?? []), sys] };
      return { ...b, columns: stripped.map((c) => (c.id === colId ? { ...c, tasks: [...c.tasks, updated] } : c)) };
    });
    void runAgent({ ...task, assignee: "agent" }, toMsgs(task.comments));
  };

  const postComment = (task: Task, text: string) => {
    const t = text.trim();
    if (!t) return;
    addComment(task.id, "user", t);
    // A comment on an assigned, idle ticket is input for the agent — continue.
    if (task.assignee === "agent" && !runningRef.current && task.agentStatus !== "working") {
      void runAgent(task, [...toMsgs(task.comments), { role: "user", content: t }]);
    }
  };

  const stopAgent = () => { void chatCancel(); };

  // Live event streams (single running agent; payloads tagged with taskId).
  useEffect(() => {
    const subs = [
      listen<{ taskId: string; text: string }>("task-agent:progress", (e) =>
        setLive((l) => ({ taskId: e.payload.taskId, text: e.payload.text, activity: l?.taskId === e.payload.taskId ? l.activity : "" })),
      ),
      listen<{ taskId: string; text: string }>("task-agent:status", (e) =>
        setLive((l) => (l && l.taskId === e.payload.taskId ? { ...l, activity: e.payload.text } : l)),
      ),
    ];
    return () => { subs.forEach((u) => void u.then((off) => off())); };
  }, []);

  // --- specs & AI ---
  const setSpecs = (specs: Spec[]) => updateBoard((b) => ({ ...b, specs }));
  const addGeneratedTasks = (tasks: GeneratedTask[], ref: SpecRef) => {
    updateBoard((b) => {
      const cols = b.columns.map((c) => ({ ...c, tasks: [...c.tasks] }));
      for (const t of tasks) {
        const target = cols.find((c) => c.name.toLowerCase() === t.column.toLowerCase()) ?? cols[0];
        if (!target || !t.title?.trim()) continue;
        target.tasks.push({ id: newId(), title: t.title.trim(), description: t.description?.trim() || undefined, spec: ref });
      }
      return { ...b, columns: cols };
    });
  };
  const openSpec = (specId?: string, version?: number) => {
    setSpecFocus(specId ? { specId, version: version ?? 1 } : null);
    setSpecOpen(true);
  };

  // Fresh detail task + its column, looked up each render.
  const detail = detailId
    ? board.columns.flatMap((c) => c.tasks.filter((t) => t.id === detailId).map((t) => ({ task: t, col: c })))[0] ?? null
    : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="switch-dialog flex h-full max-h-[860px] w-full max-w-[1200px] flex-col rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header: board switcher + actions */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--line)] px-4 py-3">
          <BoardGlyph />
          {renaming ? (
            <input
              autoFocus
              value={board.name}
              onChange={(e) => updateBoard((b) => ({ ...b, name: e.target.value }))}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setRenaming(false); }}
              className="field w-56 px-2 py-1 text-[14px] font-semibold"
            />
          ) : (
            <button onClick={() => setBoardMenu((v) => !v)} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[14px] font-semibold text-[var(--text-primary)] hover:bg-[var(--hover)]">
              {board.name}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-tertiary)]"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          )}
          {boardMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setBoardMenu(false)} />
              <div className="project-menu absolute left-8 top-12 z-50 w-60 rounded-lg py-1 text-[12.5px]">
                <div className="max-h-64 overflow-auto">
                  {boards.map((b) => (
                    <button key={b.id} onClick={() => { selectBoard(b.id); setBoardMenu(false); }} className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left">
                      <BoardGlyph small />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      {b.id === board.id && <Dot />}
                    </button>
                  ))}
                </div>
                <div className="my-1 h-px bg-[var(--surface-2)]" />
                <button onClick={addBoard} className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--accent-strong)]">+ New board</button>
              </div>
            </>
          )}
          <button onClick={() => setRenaming(true)} title="Rename board" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]"><PencilIcon /></button>
          <button onClick={addBoard} title="New board" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]"><PlusIcon /></button>
          {boards.length > 1 && (
            <button onClick={deleteBoard} title="Delete this board" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-red-600"><TrashIcon /></button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => openSpec()} className="btn-bezel flex items-center gap-1.5 px-3 py-1.5 text-[12.5px]">
              <SparkIcon /> Specs & AI
              {board.specs.length > 0 && <span className="rounded-full bg-[var(--surface-2)] px-1.5 text-[10.5px] text-[var(--text-tertiary)]">{board.specs.length}</span>}
            </button>
            <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12.5px]">Close</button>
          </div>
        </div>

        {/* Columns */}
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-4">
          {board.columns.map((col) => (
            <ColumnView
              key={col.id}
              col={col}
              dragging={dragCol === col.id}
              anyColDrag={dragCol != null}
              runningId={runningId}
              onColDragStart={() => setDragCol(col.id)}
              onColDragEnd={() => setDragCol(null)}
              onColDrop={() => { if (dragCol) moveColumn(dragCol, col.id); setDragCol(null); }}
              onRename={(name) => renameColumn(col.id, name)}
              onDelete={() => deleteColumn(col.id)}
              onAddTask={(title) => addTask(col.id, title)}
              onOpenTask={(taskId) => setDetailId(taskId)}
              onDropTask={(taskId, fromCol, beforeId) => moveTask(taskId, fromCol, col.id, beforeId)}
            />
          ))}
          <button
            onClick={addColumn}
            onDragOver={(e) => { if (dragCol) e.preventDefault(); }}
            onDrop={() => { if (dragCol) { moveColumn(dragCol, null); setDragCol(null); } }}
            className="shrink-0 rounded-lg border border-dashed border-[color:var(--line)] px-4 py-2 text-[12.5px] text-[var(--text-tertiary)] hover:bg-[var(--hover)]"
          >
            + Add column
          </button>
        </div>
      </div>

      {detail && (
        <TaskDetailDialog
          task={detail.task}
          columnName={detail.col.name}
          columns={board.columns.map((c) => ({ id: c.id, name: c.name }))}
          live={live && live.taskId === detail.task.id ? { text: live.text, activity: live.activity } : null}
          running={runningId === detail.task.id}
          onEdit={(patch) => patchTask(detail.task.id, patch)}
          onDelete={() => { deleteTask(detail.task.id); setDetailId(null); }}
          onAssign={(colId) => assignToAgent(detail.task, colId)}
          onComment={(text) => postComment(detail.task, text)}
          onRun={() => void runAgent(detail.task, toMsgs(detail.task.comments))}
          onStop={stopAgent}
          onOpenSpec={openSpec}
          onClose={() => setDetailId(null)}
        />
      )}

      {specOpen && (
        <SpecDialog
          specs={board.specs}
          columns={board.columns.map((c) => c.name)}
          onSpecsChange={setSpecs}
          onAddTasks={addGeneratedTasks}
          initialSpecId={specFocus?.specId ?? null}
          initialVersion={specFocus?.version ?? null}
          onClose={() => setSpecOpen(false)}
        />
      )}
    </div>
  );
}

// --- Column -----------------------------------------------------------------

function ColumnView({
  col, dragging, anyColDrag, runningId, onColDragStart, onColDragEnd, onColDrop, onRename, onDelete, onAddTask, onOpenTask, onDropTask,
}: {
  col: Column;
  dragging: boolean;
  anyColDrag: boolean;
  runningId: string | null;
  onColDragStart: () => void;
  onColDragEnd: () => void;
  onColDrop: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddTask: (title: string) => void;
  onOpenTask: (taskId: string) => void;
  onDropTask: (taskId: string, fromCol: string, beforeId?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [over, setOver] = useState(false);

  const commitAdd = () => { if (draft.trim()) onAddTask(draft); setDraft(""); setAdding(false); };

  return (
    <div
      className={`flex max-h-full w-[290px] shrink-0 flex-col rounded-lg bg-[var(--surface-2)] transition-opacity ${dragging ? "opacity-40" : ""} ${over ? "ring-2 ring-[color:var(--accent)]" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (anyColDrag) { onColDrop(); return; }
        const taskId = e.dataTransfer.getData("task");
        const fromCol = e.dataTransfer.getData("col");
        if (taskId && fromCol) onDropTask(taskId, fromCol);
      }}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-2">
        <span
          draggable
          onDragStart={(e) => { e.dataTransfer.setData("column", col.id); e.dataTransfer.effectAllowed = "move"; onColDragStart(); }}
          onDragEnd={onColDragEnd}
          title="Drag to reorder column"
          className="cursor-grab select-none px-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
        >
          <GripIcon />
        </span>
        <input
          value={col.name}
          onChange={(e) => onRename(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] outline-none"
        />
        <span className="shrink-0 rounded-full bg-[var(--surface-1,var(--hover))] px-1.5 text-[10.5px] text-[var(--text-tertiary)]">{col.tasks.length}</span>
        <button onClick={onDelete} title="Delete column" className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-red-600"><TrashIcon /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {col.tasks.map((t) => (
          <TaskCard key={t.id} task={t} colId={col.id} running={runningId === t.id} onOpen={() => onOpenTask(t.id)} onDropBefore={(taskId, fromCol) => onDropTask(taskId, fromCol, t.id)} />
        ))}
        {adding ? (
          <div className="mt-1 rounded-md border border-[color:var(--line)] bg-[var(--control-bg)] p-1.5">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitAdd(); } if (e.key === "Escape") { setDraft(""); setAdding(false); } }}
              onBlur={commitAdd}
              placeholder="Task title…"
              rows={2}
              className="w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-tertiary)] hover:bg-[var(--hover)]">+ Add task</button>
        )}
      </div>
    </div>
  );
}

// --- Card -------------------------------------------------------------------

function TaskCard({ task, colId, running, onOpen, onDropBefore }: {
  task: Task;
  colId: string;
  running: boolean;
  onOpen: () => void;
  onDropBefore: (taskId: string, fromCol: string) => void;
}) {
  const comments = task.comments?.length ?? 0;
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("task", task.id); e.dataTransfer.setData("col", colId); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const taskId = e.dataTransfer.getData("task");
        if (!taskId) return; // column drag — let it bubble to the column
        e.preventDefault();
        e.stopPropagation();
        const fromCol = e.dataTransfer.getData("col");
        if (taskId !== task.id) onDropBefore(taskId, fromCol);
      }}
      onClick={onOpen}
      className="group mt-1.5 cursor-pointer rounded-md border border-[color:var(--line)] bg-[var(--control-bg)] p-2 hover:border-[color:var(--accent-soft)]"
    >
      <div className="text-[12.5px] leading-snug text-[var(--text-primary)]">{task.title}</div>
      {task.description && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] text-[var(--text-tertiary)]">{task.description}</p>}
      {(task.assignee === "agent" || task.spec || comments > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {task.assignee === "agent" && task.agentStatus && <StatusChip status={task.agentStatus} pulse={running} />}
          {comments > 0 && <span className="flex items-center gap-0.5 text-[10px] text-[var(--text-tertiary)]"><CommentIcon /> {comments}</span>}
          {task.spec && <span className="flex items-center gap-0.5 truncate text-[10px] text-[var(--text-tertiary)]"><SparkIcon small /> v{task.spec.version}</span>}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status, pulse }: { status: NonNullable<Task["agentStatus"]>; pulse?: boolean }) {
  const { label, color } = agentStatusMeta(status);
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${color}1a`, color }}>
      <span className={`h-1.5 w-1.5 rounded-full ${pulse ? "animate-pulse" : ""}`} style={{ background: color }} />
      {label}
    </span>
  );
}

// --- icons ------------------------------------------------------------------

function Dot() { return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />; }
function GripIcon() { return <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" /></svg>; }
function CommentIcon() { return <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12 7.7L3 21l1.8-6A8.5 8.5 0 1 1 21 11.5z" /></svg>; }
function BoardGlyph({ small }: { small?: boolean }) {
  const s = small ? 13 : 16;
  return (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent-strong,#0a66c2)]">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16M14 4v16" />
    </svg>
  );
}
function PlusIcon() { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>; }
function PencilIcon() { return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>; }
function SparkIcon({ small }: { small?: boolean }) {
  const s = small ? 11 : 14;
  return <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15l-1.8-4.2L5.5 9l4.7-1.3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></svg>;
}
