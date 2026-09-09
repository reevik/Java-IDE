import { useEffect, useState } from "react";
import {
  newConfig,
  parseArgs,
  parseEnv,
  serializeArgs,
  serializeEnv,
  type RunConfig,
  type RunType,
} from "../lib/runConfigs";
import { GradleLogo, MavenLogo } from "./BuildView";

const TYPES: { type: RunType; label: string }[] = [
  { type: "application", label: "Java Application" },
  { type: "maven", label: "Maven" },
  { type: "gradle", label: "Gradle" },
  { type: "junit", label: "JUnit" },
];

interface Props {
  configs: RunConfig[];
  tests: string[];
  onSave: (configs: RunConfig[]) => void;
  onClose: () => void;
}

/** IntelliJ-style "Edit Run Configurations" modal: a list on the left, a form on
 *  the right for the selected config. */
export default function RunConfigDialog({ configs, tests, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<RunConfig[]>(() => configs.map((c) => ({ ...c })));
  const [selId, setSelId] = useState<string | null>(draft[0]?.id ?? null);
  const sel = draft.find((c) => c.id === selId) ?? null;

  // Free-text fields kept as local strings so typing isn't fought by re-serialize.
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  useEffect(() => {
    setArgsText(sel ? serializeArgs(sel.args) : "");
    setEnvText(sel ? serializeEnv(sel.env) : "");
  }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [addOpen, setAddOpen] = useState(false);

  const update = (patch: Partial<RunConfig>) =>
    setDraft((prev) => prev.map((c) => (c.id === selId ? { ...c, ...patch } : c)));

  const add = (type: RunType) => {
    const c = newConfig(type);
    setDraft((prev) => [...prev, c]);
    setSelId(c.id);
    setAddOpen(false);
  };
  const remove = (id: string) => {
    setDraft((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (selId === id) setSelId(next[0]?.id ?? null);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="switch-dialog flex h-[460px] w-[720px] flex-col rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center border-b border-[color:var(--line)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Run Configurations</h2>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* list */}
          <div className="flex w-[210px] shrink-0 flex-col border-r border-[color:var(--line)]">
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {draft.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelId(c.id)}
                  className={`group flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                    c.id === selId ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "hover:bg-[var(--hover)]"
                  }`}
                >
                  <KindIcon type={c.type} />
                  <span className="min-w-0 flex-1 truncate">{c.name || "(unnamed)"}</span>
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); remove(c.id); }}
                    className="hidden shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-red-600 group-hover:block"
                    title="Delete"
                  >
                    <TrashIcon />
                  </span>
                </button>
              ))}
              {draft.length === 0 && (
                <p className="px-3 py-4 text-center text-[11.5px] text-[var(--text-tertiary)]">No configurations.</p>
              )}
            </div>
            <div className="relative shrink-0 border-t border-[color:var(--line)]">
              <button onClick={() => setAddOpen((v) => !v)} className="w-full px-3 py-2 text-left text-[12px] text-[var(--accent-strong)] hover:bg-[var(--hover)]">
                + Add configuration
              </button>
              {addOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setAddOpen(false)} />
                  <div className="project-menu absolute bottom-full left-2 z-50 mb-1 w-52 rounded-lg py-1">
                    {TYPES.map((t) => (
                      <button
                        key={t.type}
                        onClick={() => add(t.type)}
                        className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[var(--text-primary)]"
                      >
                        <KindIcon type={t.type} />
                        {t.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* form */}
          <div className="min-w-0 flex-1 overflow-auto p-4">
            {!sel ? (
              <div className="grid h-full place-items-center text-[12px] text-[var(--text-tertiary)]">
                Select or add a configuration.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <Field label="Name">
                  <input value={sel.name} onChange={(e) => update({ name: e.target.value })} className="field w-full px-2 py-1.5 text-[12.5px]" />
                </Field>

                <Field label="Type">
                  <div className="flex flex-wrap gap-1">
                    {TYPES.map((t) => (
                      <Seg key={t.type} active={sel.type === t.type} onClick={() => update({ type: t.type })}>
                        <KindIcon type={t.type} />
                        {t.label}
                      </Seg>
                    ))}
                  </div>
                </Field>

                {sel.type === "application" && (
                  <>
                    <Field label="Main class" hint="Fully-qualified, e.g. com.example.Main. Empty uses the project's configured main.">
                      <input
                        value={sel.mainClass ?? ""}
                        onChange={(e) => update({ mainClass: e.target.value || undefined })}
                        placeholder="com.example.Main"
                        spellCheck={false}
                        className="field w-full px-2 py-1.5 font-mono text-[12px]"
                      />
                    </Field>
                    <Field label="Program arguments" hint="Passed to the program. Quote args with spaces.">
                      <input
                        value={argsText}
                        onChange={(e) => { setArgsText(e.target.value); update({ args: parseArgs(e.target.value) }); }}
                        placeholder="--verbose input.txt"
                        className="field w-full px-2 py-1.5 font-mono text-[12px]"
                      />
                    </Field>
                  </>
                )}

                {(sel.type === "maven" || sel.type === "gradle") && (
                  <Field
                    label={sel.type === "maven" ? "Goals" : "Tasks"}
                    hint={sel.type === "maven" ? "Space-separated, e.g. clean install -DskipTests" : "Space-separated, e.g. clean build test"}
                  >
                    <input
                      value={sel.goals ?? ""}
                      onChange={(e) => update({ goals: e.target.value })}
                      placeholder={sel.type === "maven" ? "clean install" : "build"}
                      spellCheck={false}
                      className="field w-full px-2 py-1.5 font-mono text-[12px]"
                    />
                  </Field>
                )}

                {sel.type === "maven" && (
                  <Field label="Profiles" hint="Comma-separated Maven profiles, activated with -P (e.g. desktop,ci).">
                    <input
                      value={sel.profiles ?? ""}
                      onChange={(e) => update({ profiles: e.target.value })}
                      placeholder="(none)"
                      spellCheck={false}
                      className="field w-full px-2 py-1.5 font-mono text-[12px]"
                    />
                  </Field>
                )}

                {sel.type === "junit" && (
                  <Field label="Test filter" hint="Empty runs all tests. Otherwise Class or Class#method, e.g. FooTest or FooTest#works.">
                    <TestFilterInput
                      value={sel.testTarget ?? ""}
                      onChange={(v) => update({ testTarget: v })}
                      suggestions={tests}
                    />
                  </Field>
                )}

                <Field label="Environment variables" hint="One KEY=VALUE per line.">
                  <textarea
                    value={envText}
                    onChange={(e) => { setEnvText(e.target.value); update({ env: parseEnv(e.target.value) }); }}
                    placeholder={"JAVA_HOME=/path/to/jdk\nAPI_URL=http://localhost:8080"}
                    rows={4}
                    className="field w-full resize-none px-2 py-1.5 font-mono text-[12px]"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[color:var(--line)] px-4 py-3">
          <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12.5px]">Cancel</button>
          <button onClick={() => onSave(draft)} className="btn-accent px-3 py-1.5 text-[12.5px]">Save</button>
        </div>
      </div>
    </div>
  );
}

/** Test-filter input with a live suggestions dropdown of discovered test names. */
function TestFilterInput({ value, onChange, suggestions }: { value: string; onChange: (v: string) => void; suggestions: string[] }) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 6);
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={suggestions.length ? "all tests — type or pick below" : "all tests"}
        className="field w-full px-2 py-1.5 font-mono text-[12px]"
      />
      {open && matches.length > 0 && (
        <div className="project-menu absolute left-0 right-0 top-full z-[70] mt-1 max-h-44 overflow-auto rounded-lg py-1">
          {matches.map((s) => (
            <button
              key={s}
              // mousedown (not click) so it fires before the input's blur closes us
              onMouseDown={(e) => { e.preventDefault(); onChange(s); setOpen(false); }}
              className="project-menu-item block w-full truncate px-3 py-1 text-left font-mono text-[12px] text-[var(--text-primary)]"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-[var(--text-tertiary)]">{hint}</span>}
    </label>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium ${
        active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--hover)]"
      }`}
    >
      {children}
    </button>
  );
}

export function KindIcon({ type }: { type: RunType }) {
  switch (type) {
    case "maven":
      return <MavenLogo size={13} className="text-[#C71A36]" />;
    case "gradle":
      return <GradleLogo size={14} className="text-[#0d9488]" />;
    case "junit":
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" className="shrink-0 text-[var(--accent)]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3h6M10 3v5l-4 9a2 2 0 0 0 2 3h8a2 2 0 0 0 2-3l-4-9V3" />
        </svg>
      );
    default: // application
      return (
        <svg viewBox="0 0 24 24" width="12" height="12" className="shrink-0 text-green-600" fill="currentColor">
          <path d="M7 4l12 8-12 8z" />
        </svg>
      );
  }
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  );
}
