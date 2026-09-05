import { useEffect, useRef, useState } from "react";
import {
  debugCompletions,
  debugScopes,
  debugSetVariable,
  debugVariables,
  installJavaDebug,
  type CompletionTarget,
  type Scope,
  type StackFrame,
  type Variable,
} from "../lib/api";
import Resizer from "./Resizer";

function persistedWidth(key: string, fallback: number) {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export type DebugStatus = "idle" | "building" | "running" | "paused" | "exited";

export interface DebugTarget {
  kind: "bin" | "test";
  name: string | null;
}

export interface DebugProps {
  status: DebugStatus;
  /** False when the java-debug plugin isn't installed. */
  available: boolean;
  target: DebugTarget;
  bins: string[];
  frames: StackFrame[];
  selectedFrame: number | null;
  consoleLines: string[];
  onTarget: (t: DebugTarget) => void;
  onStart: () => void;
  onStepOver: () => void;
  onStepInto: () => void;
  onStepOut: () => void;
  onStop: () => void;
  onSelectFrame: (frame: StackFrame) => void;
  onEval: (expr: string) => void;
  /** Re-check availability after the java-debug plugin is installed. */
  onInstalled?: () => void;
}

const STATUS_LABEL: Record<DebugStatus, string> = {
  idle: "Not running",
  building: "Building…",
  running: "Running",
  paused: "Paused",
  exited: "Exited",
};

/** Shown when java-debug is missing: explanation + one-click install. */
function DebuggerUnavailable({ onInstalled, toolbar }: { onInstalled?: () => void; toolbar: React.ReactNode }) {
  const [state, setState] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const install = async () => {
    setState("installing");
    setErr("");
    try {
      await installJavaDebug();
      setState("done");
      onInstalled?.(); // re-check availability
    } catch (e) {
      setErr(String(e));
      setState("error");
    }
  };
  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <div className="m-3 max-w-xl rounded-lg border border-[color:var(--line)] bg-[var(--surface-2)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
        <p className="mb-1.5 font-medium text-[var(--text-primary)]">java-debug plugin not found</p>
        <p>
          Java debugging runs inside the language server via Microsoft's{" "}
          <code className="font-mono">java-debug</code> plugin. Install it with one click — the IDE downloads the
          official “Debugger for Java” plugin and places it where it’s auto-detected.
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={() => void install()}
            disabled={state === "installing"}
            className="btn-accent px-3 py-1.5 text-[12px] disabled:opacity-60"
          >
            {state === "installing" ? "Installing…" : state === "done" ? "Installed ✓" : "Install java-debug"}
          </button>
          {state === "done" && <span className="text-[11px] text-green-700">Installed — reopen the project (or restart) so the language server loads it.</span>}
        </div>
        {state === "error" && <p className="mt-2 text-[11px] text-red-600">Install failed: {err}</p>}
        <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">
          It lands in <code className="font-mono">~/.local/share/java-debug/</code>. You can also set{" "}
          <code className="font-mono">JAVA_DEBUG_BUNDLE</code> to a jar you already have.
        </p>
      </div>
    </div>
  );
}

/** The Debugger tab: controls, call stack, captured variables, and console —
 *  laid out horizontally for the bottom panel. */
export default function DebuggerView(d: DebugProps) {
  if (!d.available) {
    return <DebuggerUnavailable onInstalled={d.onInstalled} toolbar={<Toolbar {...d} />} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar {...d} />
      <DebugBody {...d} />
    </div>
  );
}

function DebugBody(d: DebugProps) {
  const [stackWidth, setStackWidth] = useState(() => persistedWidth("layout.dbgStack", 220));
  const [consoleWidth, setConsoleWidth] = useState(() => persistedWidth("layout.dbgConsole", 320));
  useEffect(() => localStorage.setItem("layout.dbgStack", String(stackWidth)), [stackWidth]);
  useEffect(() => localStorage.setItem("layout.dbgConsole", String(consoleWidth)), [consoleWidth]);

  return (
    <div className="flex min-h-0 flex-1">
      <Column title="Call Stack" width={stackWidth}>
        {d.frames.length === 0 ? (
          <Empty>Not paused</Empty>
        ) : (
          <ul>
            {d.frames.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => d.onSelectFrame(f)}
                  className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-[var(--hover)] ${
                    f.id === d.selectedFrame ? "bg-[var(--surface-2)]" : ""
                  }`}
                >
                  <span className="truncate text-[12px] text-[var(--text-primary)]">{f.name}</span>
                  {f.path && (
                    <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-tertiary)]">
                      {basename(f.path)}:{f.line}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Column>

      <Resizer width={stackWidth} setWidth={setStackWidth} dir={1} min={140} max={480} onReset={() => setStackWidth(220)} />

      <Column title="Variables" grow>
        {d.selectedFrame == null ? <Empty>Not paused</Empty> : <Variables frameId={d.selectedFrame} />}
      </Column>

      <Resizer width={consoleWidth} setWidth={setConsoleWidth} dir={-1} min={200} max={640} onReset={() => setConsoleWidth(320)} />

      <Column title="Debug Console" width={consoleWidth} noPad>
        <Console lines={d.consoleLines} onEval={d.onEval} frameId={d.selectedFrame} disabled={d.status !== "paused"} />
      </Column>
    </div>
  );
}

function Toolbar(d: DebugProps) {
  const active = d.status !== "idle" && d.status !== "exited";
  const paused = d.status === "paused";
  const value = d.target.kind === "test" ? "test" : `bin:${d.target.name ?? ""}`;
  const startTitle = !d.available
    ? "Debugger unavailable — install the java-debug plugin (see Settings → Tools) or set JAVA_DEBUG_BUNDLE"
    : paused
      ? "Continue (F5)"
      : "Start Debugging (F5)";
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[color:var(--line)] px-2">
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          d.onTarget(v === "test" ? { kind: "test", name: null } : { kind: "bin", name: v.slice(4) });
        }}
        disabled={active || !d.available}
        title="Debug target"
        className="btn-bezel h-[26px] max-w-[150px] px-1.5 text-[11.5px] disabled:opacity-50"
      >
        {d.bins.length === 0 && <option value="bin:">No main class</option>}
        {d.bins.map((b) => (
          <option key={b} value={`bin:${b}`}>
            {b}
          </option>
        ))}
      </select>
      <IconBtn onClick={d.onStart} title={startTitle} disabled={!d.available || d.status === "building" || d.status === "running"} kind={paused ? "continue" : "start"} />
      <IconBtn onClick={d.onStepOver} title="Step Over (F10)" disabled={!paused} kind="over" />
      <IconBtn onClick={d.onStepInto} title="Step Into (F11)" disabled={!paused} kind="into" />
      <IconBtn onClick={d.onStepOut} title="Step Out (⇧F11)" disabled={!paused} kind="out" />
      <IconBtn onClick={d.onStop} title="Stop (⇧F5)" disabled={!active} kind="stop" />
      <span className={`debug-badge debug-badge-${d.status} ml-2`}>{STATUS_LABEL[d.status]}</span>
    </div>
  );
}

function IconBtn({
  onClick,
  title,
  disabled,
  kind,
}: {
  onClick: () => void;
  title: string;
  disabled: boolean;
  kind: "start" | "continue" | "over" | "into" | "out" | "stop";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="btn-bezel flex h-[26px] w-[26px] items-center justify-center disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {kind === "start" && <path d="M7 4l12 8-12 8z" fill={disabled ? "none" : "#2f9e44"} stroke={disabled ? "currentColor" : "#2f9e44"} />}
        {kind === "continue" && <path d="M7 4l12 8-12 8z" fill="#2f9e44" stroke="#2f9e44" />}
        {kind === "over" && <path d="M4 9a8 8 0 0 1 15 3M19 6v6h-6M12 20v.01" />}
        {kind === "into" && <path d="M12 4v9M8.5 9.5L12 13l3.5-3.5M9 20h6" />}
        {kind === "out" && <path d="M12 13V4M8.5 7.5L12 4l3.5 3.5M9 20h6" />}
        {kind === "stop" && <rect x="6" y="6" width="12" height="12" rx="1.5" fill="#e5534b" stroke="#e5534b" />}
      </svg>
    </button>
  );
}

function Variables({ frameId }: { frameId: number }) {
  const [scopes, setScopes] = useState<Scope[]>([]);
  useEffect(() => {
    let alive = true;
    debugScopes(frameId)
      .then((s) => alive && setScopes(s))
      .catch(() => alive && setScopes([]));
    return () => {
      alive = false;
    };
  }, [frameId]);

  if (scopes.length === 0) return <Empty>No variables</Empty>;
  return (
    <div>
      {scopes.map((s) => (
        <div key={s.variables_reference || s.name}>
          <div className="px-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {s.name}
          </div>
          <VarList variablesReference={s.variables_reference} depth={0} />
        </div>
      ))}
    </div>
  );
}

function VarList({ variablesReference, depth }: { variablesReference: number; depth: number }) {
  const [vars, setVars] = useState<Variable[] | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    debugVariables(variablesReference)
      .then((v) => alive && setVars(v))
      .catch(() => alive && setVars([]));
    return () => {
      alive = false;
    };
  }, [variablesReference, nonce]);

  if (vars == null) return null;
  return (
    <ul>
      {vars.map((v, i) => (
        <VarNode
          key={`${v.name}-${i}`}
          v={v}
          depth={depth}
          parentRef={variablesReference}
          onChanged={() => setNonce((n) => n + 1)}
        />
      ))}
    </ul>
  );
}

function VarNode({
  v,
  depth,
  parentRef,
  onChanged,
}: {
  v: Variable;
  depth: number;
  parentRef: number;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(v.value);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const expandable = v.variables_reference > 0;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(v.value);
    setError(null);
    setEditing(true);
  };
  const commit = async () => {
    const next = draft;
    setEditing(false);
    if (next === v.value) return;
    try {
      await debugSetVariable(parentRef, v.name, next);
      onChanged(); // re-read so this row (and any siblings) reflect the new value
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <li>
      <div
        className="flex w-full items-baseline gap-1.5 rounded px-2 py-[3px] font-mono text-[11.5px] hover:bg-[var(--hover)]"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          onClick={() => expandable && setOpen((o) => !o)}
          className={`flex items-baseline gap-1.5 text-left ${expandable ? "" : "cursor-default"}`}
        >
          <span className="w-2.5 shrink-0 text-[var(--text-tertiary)]">{expandable ? (open ? "▾" : "▸") : ""}</span>
          <span className="shrink-0 text-[var(--accent-strong,#0a66c2)]">{v.name}</span>
          {v.type && <span className="shrink-0 text-[var(--text-tertiary)]">: {v.type}</span>}
        </button>
        <span className="shrink-0 text-[var(--text-secondary)]">=</span>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setError(null);
              }
              e.stopPropagation();
            }}
            className="ml-0.5 min-w-0 flex-1 rounded bg-[var(--surface-2)] px-1 py-0 font-mono text-[11.5px] outline outline-1 outline-[var(--accent-strong,#0a66c2)]"
          />
        ) : (
          <span
            onDoubleClick={startEdit}
            title="Double-click to set value"
            className={`ml-0.5 min-w-0 flex-1 cursor-text truncate ${
              error ? "text-[var(--danger,#c22)]" : "text-[var(--text-secondary)]"
            }`}
          >
            {v.value}
          </span>
        )}
      </div>
      {error && !editing && (
        <div className="px-2 pb-1 font-mono text-[10.5px] text-[var(--danger,#c22)]" style={{ paddingLeft: 8 + depth * 12 + 18 }}>
          {error}
        </div>
      )}
      {open && expandable && <VarList variablesReference={v.variables_reference} depth={depth + 1} />}
    </li>
  );
}

/** Replace the token being completed (adapter-provided span, else the word left
 * of the caret) with `item.text`, returning the new text and caret offset. */
function applyCompletion(expr: string, caret: number, item: CompletionTarget): { text: string; caret: number } {
  let start = item.start ?? -1;
  let len = item.length ?? -1;
  if (start < 0 || len < 0) {
    let i = caret;
    while (i > 0 && /[A-Za-z0-9_$]/.test(expr[i - 1])) i--;
    start = i;
    len = caret - i;
  }
  const before = expr.slice(0, start);
  const after = expr.slice(start + len);
  return { text: before + item.text + after, caret: start + item.text.length };
}

function Console({
  lines,
  onEval,
  frameId,
  disabled,
}: {
  lines: string[];
  onEval: (expr: string) => void;
  frameId: number | null;
  disabled: boolean;
}) {
  const [expr, setExpr] = useState("");
  const [items, setItems] = useState<CompletionTarget[]>([]);
  const [sel, setSel] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reqRef = useRef(0); // drops out-of-order completion responses

  // Keep the console pinned to the tail by scrolling its OWN container — never
  // scrollIntoView(), which would scroll ancestors (and the whole window) too.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const open = items.length > 0;
  const closeList = () => {
    setItems([]);
    setSel(0);
  };

  // Fetch completions (debounced) for the text left of the caret.
  const fetchCompletions = (text: string, caret: number) => {
    if (disabled || frameId == null || caret === 0) {
      closeList();
      return;
    }
    const id = ++reqRef.current;
    debugCompletions(frameId, text, caret + 1 /* DAP column is 1-based */)
      .then((r) => {
        if (id !== reqRef.current) return; // superseded
        setItems(r.slice(0, 50));
        setSel(0);
      })
      .catch(() => id === reqRef.current && closeList());
  };
  useEffect(() => {
    if (disabled || frameId == null) {
      closeList();
      return;
    }
    const caret = inputRef.current?.selectionStart ?? expr.length;
    const t = setTimeout(() => fetchCompletions(expr, caret), 110);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr, frameId, disabled]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const accept = (item: CompletionTarget) => {
    const caret = inputRef.current?.selectionStart ?? expr.length;
    const { text, caret: next } = applyCompletion(expr, caret, item);
    setExpr(text);
    closeList();
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next, next);
      }
    });
  };

  const submit = () => {
    const t = expr.trim();
    if (t) {
      onEval(t);
      setExpr("");
      closeList();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[11.5px] text-[var(--text-secondary)]">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {l}
          </div>
        ))}
      </div>
      <div className="relative shrink-0 border-t border-[color:var(--line)] px-2 py-1.5">
        {open && (
          <ul
            ref={listRef}
            className="absolute bottom-full left-2 right-2 z-10 mb-1 max-h-56 overflow-auto rounded border border-[color:var(--line)] bg-[var(--surface-1,var(--surface-2))] py-1 shadow-lg"
          >
            {items.map((it, i) => (
              <li key={`${it.label}-${i}`} data-sel={i === sel ? "1" : undefined}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus in the input
                    accept(it);
                  }}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-baseline gap-2 px-2 py-[3px] text-left font-mono text-[11.5px] ${
                    i === sel ? "bg-[var(--accent-soft,var(--hover))]" : ""
                  }`}
                >
                  <span className="truncate text-[var(--text-primary,var(--text-secondary))]">{it.label}</span>
                  {it.type && <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)]">{it.type}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => (s + 1) % items.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => (s - 1 + items.length) % items.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && items[sel])) {
                e.preventDefault();
                accept(items[sel]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeList();
                return;
              }
            }
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onBlur={() => closeList()}
          placeholder={disabled ? "Pause to evaluate…" : "Evaluate expression…"}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded bg-[var(--surface-2)] px-2 py-1 font-mono text-[11.5px] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-50"
        />
      </div>
    </div>
  );
}

function Column({
  title,
  children,
  width,
  grow,
  noPad,
}: {
  title: string;
  children: React.ReactNode;
  width?: number;
  grow?: boolean;
  noPad?: boolean;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col border-r border-[color:var(--line)] last:border-r-0 ${grow ? "min-w-0 flex-1" : "shrink-0"}`}
      style={grow ? undefined : { width }}
    >
      <div className="shrink-0 px-2 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        {title}
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${noPad ? "" : "px-1 pb-1"}`}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-[11.5px] text-[var(--text-tertiary)]">{children}</div>;
}

function basename(p: string) {
  return p.split("/").pop() || p;
}
