import { useEffect, useRef } from "react";
import type { Breakpoint, Diagnostic } from "../lib/types";
import { countBreakpoints, type BreakpointMap } from "../lib/breakpoints";
import DebuggerView, { type DebugProps } from "./DebuggerView";
import BreakpointsView from "./BreakpointsView";
import UsagesView, { type UsagesResult } from "./UsagesView";
import GitView from "./GitView";

export interface BreakpointsPanelProps {
  items: BreakpointMap;
  root: string | null;
  onJump: (path: string, line: number) => void;
  onToggleEnabled: (path: string, line: number) => void;
  onRemove: (path: string, line: number) => void;
  onPatch: (path: string, line: number, patch: Partial<Breakpoint>) => void;
  onRemoveAll: () => void;
  onSetAllEnabled: (enabled: boolean) => void;
}

export interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

export type OutputTab = "problems" | "output" | "debugger" | "breakpoints" | "usages" | "git";

interface Props {
  lines: OutputLine[];
  diagnostics: Diagnostic[];
  running: boolean;
  /** Exit status of the last run, null while running or before the first run. */
  lastResult: { code: number; secs: number } | null;
  command: string | null;
  onJump: (file: string, line: number, column: number) => void;
  onClear: () => void;
  onCancel: () => void;
  /** Active tab (controlled, so debugging can focus the Debugger tab). */
  tab: OutputTab;
  onTab: (t: OutputTab) => void;
  debug: DebugProps;
  breakpointsPanel: BreakpointsPanelProps;
  /** "Find Usages" results + root, and a jump handler. */
  usages: UsagesResult | null;
  usagesRoot: string | null;
  onUsageJump: (path: string, line: number, character: number) => void;
  /** Project root, for the Git tab. */
  gitRoot: string | null;
  /** Open a commit's diff for a file as an editor tab. */
  onOpenDiff: (hash: string, relPath: string) => void;
  /** Open the working-tree diff for a file as an editor tab. */
  onOpenWorkingDiff: (relPath: string) => void;
  /** Send the current console output to the AI Assistant for analysis. */
  onAnalyze?: (text: string) => void;
}

export default function OutputPanel({
  lines,
  diagnostics,
  running,
  lastResult,
  command,
  onJump,
  onClear,
  onCancel,
  tab,
  onTab,
  debug,
  breakpointsPanel,
  usages,
  usagesRoot,
  onUsageJump,
  gitRoot,
  onOpenDiff,
  onOpenWorkingDiff,
  onAnalyze,
}: Props) {
  const outRef = useRef<HTMLDivElement>(null);

  // Gather the console output (capped) for the AI Analysis action.
  const analyze = () => {
    const text = lines.slice(-500).map((l) => l.text).join("\n").trim();
    if (text) onAnalyze?.(text);
  };
  const canAnalyze = !!onAnalyze && tab === "output" && lines.length > 0;

  // Follow the tail while a command streams.
  useEffect(() => {
    if (tab === "output" && running) outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [lines, tab, running]);

  // A failing run should surface its errors without a click.
  useEffect(() => {
    if (lastResult && lastResult.code !== 0 && diagnostics.some((d) => d.level === "error")) {
      onTab("problems");
    }
    // onTab is stable enough; only react to run results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult, diagnostics]);

  const errors = diagnostics.filter((d) => d.level === "error").length;
  const warnings = diagnostics.filter((d) => d.level === "warning").length;
  const bpCount = countBreakpoints(breakpointsPanel.items);
  const debugDot =
    debug.status === "paused" ? "#f5a623" : debug.status === "running" || debug.status === "building" ? "#2f9e44" : null;

  return (
    <section className="output-pane flex h-full min-h-0">
      {tab === "output" && (
        <nav className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-[color:var(--line)] pt-2">
          <button
            onClick={analyze}
            disabled={!canAnalyze}
            title="AI Analysis — send this output to the AI Assistant"
            aria-label="AI Analysis"
            className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--accent-strong)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <AiSparkIcon />
          </button>
        </nav>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-[color:var(--line)] px-2">
        <TabButton active={tab === "problems"} onClick={() => onTab("problems")}>
          Problems
          {errors > 0 && <Badge tone="error">{errors}</Badge>}
          {warnings > 0 && <Badge tone="warn">{warnings}</Badge>}
        </TabButton>
        <TabButton active={tab === "output"} onClick={() => onTab("output")}>
          Output
        </TabButton>
        <TabButton active={tab === "debugger"} onClick={() => onTab("debugger")}>
          Debugger
          {debugDot && <span className="ml-1 inline-block h-2 w-2 rounded-full" style={{ background: debugDot }} />}
        </TabButton>
        <TabButton active={tab === "breakpoints"} onClick={() => onTab("breakpoints")}>
          Breakpoints
          {bpCount > 0 && <Badge tone="warn">{bpCount}</Badge>}
        </TabButton>
        {usages && (
          <TabButton active={tab === "usages"} onClick={() => onTab("usages")}>
            Usages
            <Badge tone="warn">{usages.refs.length}</Badge>
          </TabButton>
        )}
        <TabButton active={tab === "git"} onClick={() => onTab("git")}>
          Git
        </TabButton>

        <span className={`ml-auto flex items-center gap-2 pr-1 text-[11px] text-[var(--text-tertiary)] ${tab === "debugger" || tab === "git" || tab === "breakpoints" || tab === "usages" ? "hidden" : ""}`}>
          {running ? (
            <>
              <span className="text-[var(--accent)]">{runLabel(command)}…</span>
              <button onClick={onCancel} className="btn-bezel px-2 py-0.5 text-[11px]">
                Stop
              </button>
            </>
          ) : lastResult ? (
            <span className={lastResult.code === 0 ? "text-green-600" : "text-red-500"}>
              {lastResult.code === 0 ? "✓" : "✗"} {runLabel(command)} · {lastResult.secs.toFixed(1)}s
            </span>
          ) : null}
          <button onClick={onClear} className="btn-bezel px-2 py-0.5 text-[11px]">
            Clear
          </button>
        </span>
      </header>

      {tab === "git" ? (
        <div className="min-h-0 flex-1">
          {gitRoot ? (
            <GitView root={gitRoot} onOpenDiff={onOpenDiff} onOpenWorkingDiff={onOpenWorkingDiff} />
          ) : (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">Open a project to see git history.</p>
          )}
        </div>
      ) : tab === "debugger" ? (
        <div className="min-h-0 flex-1">
          <DebuggerView {...debug} />
        </div>
      ) : tab === "usages" ? (
        <div className="min-h-0 flex-1">
          <UsagesView result={usages} root={usagesRoot} onJump={onUsageJump} />
        </div>
      ) : tab === "breakpoints" ? (
        <div className="min-h-0 flex-1">
          <BreakpointsView
            breakpoints={breakpointsPanel.items}
            root={breakpointsPanel.root}
            onJump={breakpointsPanel.onJump}
            onToggleEnabled={breakpointsPanel.onToggleEnabled}
            onRemove={breakpointsPanel.onRemove}
            onPatch={breakpointsPanel.onPatch}
            onRemoveAll={breakpointsPanel.onRemoveAll}
            onSetAllEnabled={breakpointsPanel.onSetAllEnabled}
          />
        </div>
      ) : tab === "problems" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {diagnostics.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
              {running ? "Compiling…" : "No problems."}
            </p>
          ) : (
            diagnostics.map((d, i) => (
              <button
                key={i}
                onClick={() => d.file && d.line && onJump(d.file, d.line, d.column ?? 1)}
                disabled={!d.file || !d.line}
                title={d.rendered ?? undefined}
                className={`flex w-full items-start gap-2 border-b border-[color:var(--line)] px-3 py-1.5 text-left text-[12px] ${
                  d.file && d.line ? "hover:bg-[var(--hover)]" : "cursor-default opacity-80"
                }`}
              >
                <span
                  className={`mt-[3px] shrink-0 text-[9px] ${
                    d.level === "error" ? "text-red-500" : "text-yellow-600"
                  }`}
                >
                  ●
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[var(--text-primary)]">{d.message}</span>
                  {d.file && (
                    <span className="block truncate text-[11px] text-[var(--text-tertiary)]">
                      {shortPath(d.file)}
                      {d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : ""}
                      {d.code ? ` · ${d.code}` : ""}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div ref={outRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {lines.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-[var(--text-tertiary)]">No output yet.</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5]">
              {lines.map((l, i) => (
                <div key={i} className={l.stream === "stderr" ? "text-[var(--text-secondary)]" : ""}>
                  {l.text}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
      </div>
    </section>
  );
}

function AiSparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
      <path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2z" />
      <path d="M18.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" opacity="0.75" />
    </svg>
  );
}

/** A human label for the running build-tool command (Maven/Gradle under the hood). */
function runLabel(command: string | null): string {
  switch (command) {
    case "run": return "Run";
    case "build": return "Build";
    case "test": return "Test";
    case "check":
    case "clippy": return "Check";
    case "fmt": return "Format";
    default: return command ?? "Task";
  }
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"
      }`}
    >
      {children}
    </button>
  );
}

function Badge({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  return (
    <span
      className={`rounded px-1 text-[10px] font-semibold tabular-nums ${
        tone === "error" ? "bg-red-500/15 text-red-600" : "bg-yellow-500/20 text-yellow-700"
      }`}
    >
      {children}
    </span>
  );
}

/** rustc reports paths relative to the project root; keep the tail readable. */
function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : p;
}
