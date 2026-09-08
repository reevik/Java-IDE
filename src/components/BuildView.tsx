import { useState } from "react";

export type BuildTool = "maven" | "gradle";

interface Props {
  tool: BuildTool;
  /** True while a build/goal is running (disables run actions, shows Stop). */
  running: boolean;
  /** Run the given goals/tasks (a lifecycle phase, or a parsed custom line). */
  onRun: (goals: string[]) => void;
  onStop: () => void;
}

/** Maven default + clean lifecycle phases (running a phase runs every phase up to
 *  it), and the common Gradle tasks. */
const GOALS: Record<BuildTool, { name: string; desc: string }[]> = {
  maven: [
    { name: "clean", desc: "Delete target/ (build outputs)" },
    { name: "validate", desc: "Validate the project is correct" },
    { name: "compile", desc: "Compile main sources" },
    { name: "test", desc: "Run unit tests" },
    { name: "package", desc: "Build the JAR/WAR" },
    { name: "verify", desc: "Run checks on the package" },
    { name: "install", desc: "Install to the local ~/.m2 repository" },
    { name: "site", desc: "Generate the project site" },
    { name: "deploy", desc: "Deploy to the remote repository" },
  ],
  gradle: [
    { name: "clean", desc: "Delete build/ outputs" },
    { name: "classes", desc: "Compile main classes" },
    { name: "assemble", desc: "Assemble outputs (no tests)" },
    { name: "test", desc: "Run tests" },
    { name: "check", desc: "Run all checks (tests + verification)" },
    { name: "build", desc: "Assemble and test everything" },
    { name: "jar", desc: "Build the JAR" },
    { name: "run", desc: "Run (application plugin)" },
    { name: "dependencies", desc: "Print the dependency tree" },
  ],
};

const SHORTCUTS: Record<BuildTool, { label: string; goals: string[] }[]> = {
  maven: [
    { label: "clean install", goals: ["clean", "install"] },
    { label: "clean package", goals: ["clean", "package"] },
    { label: "package -DskipTests", goals: ["clean", "package", "-DskipTests"] },
  ],
  gradle: [
    { label: "clean build", goals: ["clean", "build"] },
    { label: "build -x test", goals: ["build", "-x", "test"] },
  ],
};

const LABEL: Record<BuildTool, string> = { maven: "Maven", gradle: "Gradle" };
const CLI: Record<BuildTool, string> = { maven: "mvn", gradle: "gradle" };

/** Split a custom goal line into args, honoring quotes. */
function parseGoals(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export default function BuildView({ tool, running, onRun, onStop }: Props) {
  const [custom, setCustom] = useState("");
  const [openGoals, setOpenGoals] = useState(true);
  const [openShortcuts, setOpenShortcuts] = useState(true);

  const run = (goals: string[]) => {
    if (!running && goals.length) onRun(goals);
  };
  const submitCustom = () => {
    const goals = parseGoals(custom.trim());
    if (goals.length) run(goals);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{LABEL[tool]}</span>
        {running && (
          <button
            onClick={onStop}
            className="rounded px-1.5 py-0.5 text-[11px] text-[var(--danger,#c22)] hover:bg-[var(--hover)]"
            title="Stop the running goal"
          >
            ■ Stop
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        <Group title={tool === "maven" ? "Lifecycle" : "Tasks"} open={openGoals} onToggle={() => setOpenGoals((o) => !o)}>
          {GOALS[tool].map((g) => (
            <GoalRow key={g.name} label={g.name} title={g.desc} disabled={running} onRun={() => run([g.name])} />
          ))}
        </Group>

        <Group title="Shortcuts" open={openShortcuts} onToggle={() => setOpenShortcuts((o) => !o)}>
          {SHORTCUTS[tool].map((s) => (
            <GoalRow key={s.label} label={s.label} title={`${CLI[tool]} ${s.goals.join(" ")}`} disabled={running} onRun={() => run(s.goals)} />
          ))}
        </Group>
      </div>

      <form
        className="shrink-0 border-t border-[color:var(--line)] px-2 py-2"
        onSubmit={(e) => { e.preventDefault(); submitCustom(); }}
      >
        <label className="mb-1 block text-[10.5px] uppercase tracking-wide text-[var(--text-tertiary)]">
          {tool === "maven" ? "Run goal" : "Run task"}
        </label>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[11.5px] text-[var(--text-tertiary)]">{CLI[tool]}</span>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder={tool === "maven" ? "e.g. dependency:tree -Dincludes=…" : "e.g. :core:test --tests …"}
            disabled={running}
            spellCheck={false}
            className="min-w-0 flex-1 rounded bg-[var(--surface-2)] px-2 py-1 font-mono text-[11.5px] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={running || custom.trim() === ""}
            className="shrink-0 rounded bg-[var(--accent-soft)] px-2 py-1 text-[11.5px] font-medium text-[var(--accent-strong,#0a66c2)] disabled:opacity-40"
            title="Run"
          >
            <PlayGlyph />
          </button>
        </div>
      </form>
    </div>
  );
}

function Group({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      >
        <span className="w-3 text-[var(--text-tertiary)]">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function GoalRow({ label, title, disabled, onRun }: { label: string; title: string; disabled: boolean; onRun: () => void }) {
  return (
    <button
      onClick={onRun}
      disabled={disabled}
      title={title}
      className="group flex w-full items-center gap-2 rounded px-2 py-[3px] pl-6 text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--hover)] disabled:opacity-50"
    >
      <GoalGlyph />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{label}</span>
      <PlayGlyph className="shrink-0 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100" />
    </button>
  );
}

function GoalGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent-strong,#0a66c2)]">
      <path d="M12 3v18M12 12l7-4M12 12L5 8M12 21l7-4M12 21l-7-4" />
    </svg>
  );
}
function PlayGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" className={`shrink-0 ${className}`}>
      <path d="M7 4l12 8-12 8z" />
    </svg>
  );
}
