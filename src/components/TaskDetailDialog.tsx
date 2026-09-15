import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import Select from "./Select";
import { agentStatusMeta, type Comment, type Task } from "../lib/taskBoards";

interface Props {
  task: Task;
  columnName: string;
  columns: { id: string; name: string }[];
  /** Resolved current dependencies of this task. */
  deps: { id: string; title: string; complete: boolean }[];
  /** Tasks that may be added as a dependency (no self / cycle / duplicate). */
  depCandidates: { id: string; title: string }[];
  /** Titles of unfinished dependencies blocking this task, if any. */
  blockedBy: string[];
  /** Live streaming buffer when this task's agent is currently running. */
  live: { text: string; activity: string } | null;
  running: boolean;
  onEdit: (patch: Partial<Task>) => void;
  onDelete: () => void;
  onAssign: (colId: string) => void;
  onComment: (text: string) => void;
  onRun: () => void;
  onStop: () => void;
  onAddDep: (depId: string) => void;
  onRemoveDep: (depId: string) => void;
  onOpenSpec: (specId: string, version: number) => void;
  onClose: () => void;
}

/** The ticket detail view: editable title/description, the spec link, the agent's
 *  independent status, its live progress, and the comment thread the human and the
 *  agent talk through. */
export default function TaskDetailDialog({
  task, columnName, columns, deps, depCandidates, blockedBy, live, running, onEdit, onDelete, onAssign, onComment, onRun, onStop, onAddDep, onRemoveDep, onOpenSpec, onClose,
}: Props) {
  const assigned = task.assignee === "agent";
  const status = task.agentStatus;
  const [assigning, setAssigning] = useState(false);
  const [assignCol, setAssignCol] = useState(() => columns.find((c) => /progress/i.test(c.name))?.id ?? columns[0]?.id ?? "");
  const [comment, setComment] = useState("");

  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description ?? "");
  useEffect(() => { setTitle(task.title); setDesc(task.description ?? ""); }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [task.comments?.length, live?.text]);

  const commitTitle = () => { const t = title.trim(); if (t && t !== task.title) onEdit({ title: t }); };
  const commitDesc = () => { const d = desc.trim(); if (d !== (task.description ?? "")) onEdit({ description: d || undefined }); };

  const runLabel = !assigned ? "Run agent"
    : status === "waiting" || status === "review" ? "Continue"
    : status === "done" || status === "blocked" || status === "error" ? "Run again"
    : "Run agent";

  const send = () => { const t = comment.trim(); if (!t) return; onComment(t); setComment(""); };

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="switch-dialog flex h-full max-h-[860px] w-full max-w-[860px] flex-col overflow-hidden rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex shrink-0 items-start gap-2 border-b border-[color:var(--line)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              rows={1}
              className="field w-full resize-none px-2 py-1 text-[15px] font-semibold"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2 px-1 text-[11px] text-[var(--text-tertiary)]">
              <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">{columnName}</span>
              {assigned && status && <AgentChip status={status} pulse={running} />}
              {task.spec && (
                <button onClick={() => onOpenSpec(task.spec!.specId, task.spec!.version)} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 hover:text-[var(--accent-strong,#0a66c2)]">
                  ✦ {task.spec.specTitle} v{task.spec.version}
                </button>
              )}
            </div>
          </div>
          <button onClick={onDelete} title="Delete ticket" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-red-600"><TrashIcon /></button>
          <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12.5px]">Close</button>
        </div>

        {/* Agent action bar */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--line)] bg-[var(--surface-2)] px-4 py-2">
          <RobotIcon />
          {assigning ? (
            <>
              <span className="text-[12px] text-[var(--text-secondary)]">Assign to agent — set status to</span>
              <Select value={assignCol} onChange={setAssignCol} className="field px-1.5 py-1 text-[12px]" options={columns.map((c) => ({ value: c.id, label: c.name }))} />
              <button onClick={() => { onAssign(assignCol); setAssigning(false); }} className="btn-accent px-2.5 py-1 text-[12px]">Assign & start</button>
              <button onClick={() => setAssigning(false)} className="btn-bezel px-2.5 py-1 text-[12px]">Cancel</button>
            </>
          ) : (
            <>
              <span className="text-[12px] text-[var(--text-secondary)]">
                {assigned ? <>Agent assigned{status && <> · <b className="font-medium">{agentStatusMeta(status).label}</b></>}</> : "Not assigned"}
                {blockedBy.length > 0 && <span className="text-[var(--text-tertiary)]"> · waiting for {blockedBy.join(", ")}</span>}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setAssigning(true)} className="btn-bezel px-2.5 py-1 text-[12px]">{assigned ? "Re-assign…" : "Assign to agent…"}</button>
                {running ? (
                  <button onClick={onStop} className="btn-bezel px-2.5 py-1 text-[12px]">Stop</button>
                ) : assigned ? (
                  <button onClick={onRun} className="btn-accent px-2.5 py-1 text-[12px]">{runLabel}</button>
                ) : null}
              </div>
            </>
          )}
        </div>

        {/* Body: dependencies + description + thread */}
        <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Depends on</label>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {deps.length === 0 && <span className="text-[11.5px] text-[var(--text-tertiary)]">No dependencies. Add one to make this run only after another ticket is done.</span>}
            {deps.map((d) => (
              <span key={d.id} className="inline-flex items-center gap-1 rounded-full border border-[color:var(--line)] bg-[var(--control-bg)] py-0.5 pl-1.5 pr-1 text-[11px]" title={d.complete ? "Complete" : "Not finished yet"}>
                <span className={`h-1.5 w-1.5 rounded-full ${d.complete ? "" : ""}`} style={{ background: d.complete ? "#1a7f37" : "#c2410c" }} />
                <span className="max-w-[180px] truncate text-[var(--text-secondary)]">{d.title}</span>
                <button onClick={() => onRemoveDep(d.id)} title="Remove dependency" className="rounded px-0.5 text-[var(--text-tertiary)] hover:text-red-600">×</button>
              </span>
            ))}
            {depCandidates.length > 0 && (
              <Select
                value=""
                onChange={(v) => { if (v) onAddDep(v); }}
                placeholder="+ Add dependency…"
                className="field px-1.5 py-1 text-[11.5px]"
                options={depCandidates.map((c) => ({ value: c.id, label: c.title }))}
              />
            )}
          </div>

          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Description</label>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={commitDesc}
            rows={3}
            placeholder="Describe the task…"
            className="field mb-4 w-full resize-y px-2 py-1.5 text-[12.5px]"
          />

          <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Comments</label>
          <div className="flex flex-col gap-2">
            {(task.comments ?? []).length === 0 && !live && (
              <p className="text-[12px] text-[var(--text-tertiary)]">No comments yet. The agent posts its progress here; reply to give it input.</p>
            )}
            {(task.comments ?? []).map((c) => <CommentView key={c.id} c={c} />)}
            {live && running && (
              <div className="rounded-lg border border-[color:var(--accent-soft,var(--line))] bg-[var(--control-bg)] p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent-strong,#0a66c2)]">
                  <RobotIcon small /> Agent
                  <Spinner />
                  {live.activity && <span className="text-[var(--text-tertiary)]">{live.activity}</span>}
                </div>
                {live.text ? (
                  <div className="md-comment text-[12px] leading-relaxed text-[var(--text-secondary)]"><Markdown text={live.text} /></div>
                ) : (
                  <p className="text-[12px] italic text-[var(--text-tertiary)]">Thinking…</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Comment composer */}
        <div className="flex shrink-0 items-end gap-2 border-t border-[color:var(--line)] px-4 py-2.5">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
            rows={2}
            placeholder={assigned ? "Reply to the agent… (⌘⏎ to send)" : "Add a comment… (⌘⏎)"}
            className="field min-w-0 flex-1 resize-none px-2 py-1.5 text-[12.5px]"
          />
          <button onClick={send} disabled={comment.trim() === ""} className="btn-accent shrink-0 px-3 py-2 text-[12px] disabled:opacity-40">Comment</button>
        </div>
      </div>
    </div>
  );
}

function CommentView({ c }: { c: Comment }) {
  if (c.author === "system") {
    return <p className="py-0.5 text-center text-[11px] italic text-[var(--text-tertiary)]">{c.text} · {time(c.at)}</p>;
  }
  const agent = c.author === "agent";
  return (
    <div className={`rounded-lg border p-2.5 ${agent ? "border-l-2 border-[color:var(--accent-soft,var(--line))] bg-[var(--surface-2)]" : "border-[color:var(--line)] bg-[var(--control-bg)]"}`}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium">
        {agent ? <><RobotIcon small /> <span className="text-[var(--accent-strong,#0a66c2)]">Agent</span></> : <><UserIcon /> <span className="text-[var(--text-secondary)]">You</span></>}
        <span className="font-normal text-[var(--text-tertiary)]">{time(c.at)}</span>
      </div>
      <div className="md-comment text-[12px] leading-relaxed text-[var(--text-primary)]"><Markdown text={c.text} /></div>
    </div>
  );
}

function AgentChip({ status, pulse }: { status: NonNullable<Task["agentStatus"]>; pulse?: boolean }) {
  const { label, color } = agentStatusMeta(status);
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5" style={{ background: `${color}1a`, color }}>
      <span className={`h-1.5 w-1.5 rounded-full ${pulse ? "animate-pulse" : ""}`} style={{ background: color }} />
      {label}
    </span>
  );
}

function time(ms: number) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TrashIcon() { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>; }
function UserIcon() { return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-tertiary)]"><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>; }
function RobotIcon({ small }: { small?: boolean }) {
  const s = small ? 13 : 16;
  return <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent-strong,#0a66c2)]"><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M12 8V4M9 3.5h6" /><circle cx="9" cy="13" r="1" fill="currentColor" /><circle cx="15" cy="13" r="1" fill="currentColor" /><path d="M2 13v2M22 13v2" /></svg>;
}
function Spinner() {
  return <svg viewBox="0 0 24 24" width="12" height="12" className="animate-spin text-[var(--accent-strong,#0a66c2)]"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}
