import { useState } from "react";
import type { Breakpoint } from "../lib/types";
import type { BreakpointMap } from "../lib/breakpoints";

interface Props {
  breakpoints: BreakpointMap;
  /** Project root, for showing paths relative to it. */
  root: string | null;
  onJump: (path: string, line: number) => void;
  onToggleEnabled: (path: string, line: number) => void;
  onRemove: (path: string, line: number) => void;
  onPatch: (path: string, line: number, patch: Partial<Breakpoint>) => void;
  onRemoveAll: () => void;
  onSetAllEnabled: (enabled: boolean) => void;
}

function rel(path: string, root: string | null): string {
  if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  return path.split("/").slice(-2).join("/");
}

function summary(b: Breakpoint): string {
  const parts = [
    b.condition && `if ${b.condition}`,
    b.hitCondition && `hits ${b.hitCondition}`,
    b.logMessage && `log "${b.logMessage}"`,
  ].filter(Boolean);
  return parts.join("  ·  ");
}

export default function BreakpointsView({
  breakpoints,
  root,
  onJump,
  onToggleEnabled,
  onRemove,
  onPatch,
  onRemoveAll,
  onSetAllEnabled,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null); // `${path}#${line}`

  const files = Object.entries(breakpoints)
    .filter(([, list]) => list.length)
    .sort(([a], [b]) => rel(a, root).localeCompare(rel(b, root)));
  const total = files.reduce((n, [, list]) => n + list.length, 0);
  const anyEnabled = files.some(([, list]) => list.some((b) => b.enabled));

  if (total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-[12px] text-[var(--text-tertiary)]">No breakpoints.</p>
        <p className="text-[11px] text-[var(--text-tertiary)]">
          Click the gutter next to a line to add one, then set a condition here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--line)] px-3 py-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {total} breakpoint{total === 1 ? "" : "s"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button className="btn-bezel px-2 py-0.5 text-[11px]" onClick={() => onSetAllEnabled(!anyEnabled)}>
            {anyEnabled ? "Disable all" : "Enable all"}
          </button>
          <button className="btn-bezel px-2 py-0.5 text-[11px]" onClick={onRemoveAll}>
            Remove all
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {files.map(([path, list]) => (
          <div key={path} className="mb-1">
            <div className="px-3 py-1 text-[11px] font-semibold text-[var(--text-tertiary)]">{rel(path, root)}</div>
            {[...list]
              .sort((a, b) => a.line - b.line)
              .map((b) => {
                const key = `${path}#${b.line}`;
                const isEditing = editing === key;
                const conditional = !!(b.condition || b.hitCondition || b.logMessage);
                return (
                  <div key={key} className="px-1">
                    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-[color:var(--hover)]">
                      <input
                        type="checkbox"
                        checked={b.enabled}
                        onChange={() => onToggleEnabled(path, b.line)}
                        className="accent-[var(--accent)]"
                        title={b.enabled ? "Disable breakpoint" : "Enable breakpoint"}
                      />
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 shrink-0"
                        style={{
                          background: b.enabled ? "#e5534b" : "transparent",
                          boxShadow: b.enabled ? "none" : "inset 0 0 0 1.5px #e5534b",
                          borderRadius: conditional ? 2 : "50%",
                          transform: conditional ? "rotate(45deg)" : undefined,
                        }}
                      />
                      <button
                        className="text-[12px] text-[var(--text-primary)] hover:text-[var(--accent)]"
                        onClick={() => onJump(path, b.line)}
                        title="Go to line"
                      >
                        line {b.line}
                      </button>
                      {conditional && !isEditing && (
                        <span className="truncate text-[11px] text-[var(--text-tertiary)]">{summary(b)}</span>
                      )}
                      <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                        <button
                          className={`rounded px-1 text-[11px] ${isEditing ? "text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"}`}
                          onClick={() => setEditing(isEditing ? null : key)}
                          title="Edit condition"
                        >
                          {conditional ? "Edit condition" : "Add condition"}
                        </button>
                        <button
                          className="rounded px-1 text-[13px] text-[var(--text-tertiary)] hover:text-red-500"
                          onClick={() => {
                            if (isEditing) setEditing(null);
                            onRemove(path, b.line);
                          }}
                          title="Remove breakpoint"
                        >
                          ×
                        </button>
                      </span>
                    </div>

                    {isEditing && (
                      <div className="mb-1 ml-8 mr-2 flex flex-col gap-1.5 rounded-md border border-[color:var(--line)] bg-[var(--surface-2)] p-2">
                        <Field
                          label="Condition"
                          placeholder="e.g. i == 5 && ready"
                          value={b.condition ?? ""}
                          onCommit={(v) => onPatch(path, b.line, { condition: v })}
                        />
                        <Field
                          label="Hit count"
                          placeholder="e.g. >= 3, % 2, 10"
                          value={b.hitCondition ?? ""}
                          onCommit={(v) => onPatch(path, b.line, { hitCondition: v })}
                        />
                        <Field
                          label="Log message"
                          placeholder={"prints instead of stopping — use {expr}"}
                          value={b.logMessage ?? ""}
                          onCommit={(v) => onPatch(path, b.line, { logMessage: v })}
                        />
                        <p className="text-[10px] text-[var(--text-tertiary)]">
                          Conditions apply on the next debug run (and live if a session is active).
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="flex items-center gap-2">
      <span className="w-[84px] shrink-0 text-[11px] text-[var(--text-secondary)]">{label}</span>
      <input
        data-bp-field={label}
        className="field w-full px-2 py-1 text-[12px]"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(draft.trim());
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
