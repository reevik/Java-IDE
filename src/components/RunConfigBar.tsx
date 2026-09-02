import { useState } from "react";
import type { RunConfig } from "../lib/runConfigs";
import { KindIcon } from "./RunConfigDialog";

interface Props {
  configs: RunConfig[];
  selected: RunConfig | undefined;
  running: boolean;
  onSelect: (id: string) => void;
  onRun: () => void;
  onEdit: () => void;
}

/** IntelliJ-style run widget: a config picker fused to a green Run button. */
export default function RunConfigBar({ configs, selected, running, onSelect, onRun, onEdit }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex items-center">
      <div className="flex items-center overflow-hidden rounded-md border border-[color:var(--line)] bg-[var(--control-bg)]">
        <button
          onClick={() => setOpen((v) => !v)}
          title="Select run configuration"
          className="flex min-w-0 max-w-[190px] items-center gap-1.5 px-2 py-1 hover:bg-[var(--hover)]"
        >
          {selected ? <KindIcon kind={selected.kind} /> : null}
          <span className="min-w-0 truncate text-[12px] font-medium text-[var(--text-primary)]">
            {selected?.name ?? "No configurations"}
          </span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button
          onClick={onRun}
          disabled={running || !selected}
          title={selected ? `Run '${selected.name}' (⌘R)` : "No run configuration"}
          className="flex items-center border-l border-[color:var(--line)] px-2 py-1 text-green-700 hover:bg-green-500/10 disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M7 4l12 8-12 8z" />
          </svg>
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="project-menu absolute left-0 top-full z-50 mt-1 w-60 rounded-lg py-1 text-[12.5px]">
            <div className="max-h-72 overflow-auto">
              {configs.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { onSelect(c.id); setOpen(false); }}
                  className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left"
                >
                  <KindIcon kind={c.kind} />
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{c.name || "(unnamed)"}</span>
                  {selected?.id === c.id && <Dot />}
                </button>
              ))}
              {configs.length === 0 && (
                <div className="px-3 py-2 text-[11.5px] text-[var(--text-tertiary)]">No configurations yet.</div>
              )}
            </div>
            <div className="my-1 h-px bg-[var(--surface-2)]" />
            <button
              onClick={() => { setOpen(false); onEdit(); }}
              className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--text-secondary)]"
            >
              <GearIcon />
              Edit Configurations…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
