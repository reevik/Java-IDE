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
  { type: "spring", label: "Spring Boot" },
  { type: "maven", label: "Maven" },
  { type: "gradle", label: "Gradle" },
  { type: "junit", label: "JUnit" },
];

interface Props {
  configs: RunConfig[];
  tests: string[];
  /** Discovered main classes, for the Application → Main class suggestions. */
  mains: string[];
  /** Detected @SpringBootApplication main classes, for the Spring Boot type. */
  springMains: string[];
  onSave: (configs: RunConfig[]) => void;
  onClose: () => void;
}

/** IntelliJ-style "Edit Run Configurations" modal: a list on the left, a form on
 *  the right for the selected config. */
export default function RunConfigDialog({ configs, tests, mains, springMains, onSave, onClose }: Props) {
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
    // Spring Boot: pre-fill with the detected @SpringBootApplication main class.
    if (type === "spring" && springMains.length > 0) {
      c.mainClass = springMains[0];
      c.name = springMains[0].split(".").pop() || "Spring Boot";
    }
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
                  <div className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)]">
                    <KindIcon type={sel.type} />
                    {TYPES.find((t) => t.type === sel.type)?.label ?? sel.type}
                  </div>
                </Field>

                {sel.type === "application" && (
                  <>
                    <Field label="Main class" hint="Fully-qualified, e.g. com.example.Main. Empty uses the project's configured main.">
                      <SuggestInput
                        value={sel.mainClass ?? ""}
                        onChange={(v) => update({ mainClass: v || undefined })}
                        suggestions={mains}
                        placeholder={mains.length ? "com.example.Main — type or pick below" : "com.example.Main"}
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

                {sel.type === "spring" && (
                  <>
                    <Field label="Main class" hint="The @SpringBootApplication class. Runs via mvn spring-boot:run / gradle bootRun; used to target the app and for Debug.">
                      <SuggestInput
                        value={sel.mainClass ?? ""}
                        onChange={(v) => update({ mainClass: v || undefined })}
                        suggestions={springMains}
                        placeholder={springMains.length ? "com.example.Application — type or pick below" : "com.example.Application"}
                        invalid={!sel.mainClass?.trim()}
                      />
                      {!sel.mainClass?.trim() && (
                        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-red-600">
                          <ErrorIcon />
                          {springMains.length === 0
                            ? "No @SpringBootApplication class found in this project."
                            : "Select a Spring Boot main class."}
                        </p>
                      )}
                    </Field>
                    <Field label="Program arguments" hint="Passed to the app (e.g. --server.port=8081). Quote args with spaces.">
                      <input
                        value={argsText}
                        onChange={(e) => { setArgsText(e.target.value); update({ args: parseArgs(e.target.value) }); }}
                        placeholder="--server.port=8081 --spring.profiles.active=dev"
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
                    <SuggestInput
                      value={sel.testTarget ?? ""}
                      onChange={(v) => update({ testTarget: v })}
                      suggestions={tests}
                      placeholder={tests.length ? "all tests — type or pick below" : "all tests"}
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

/** A monospace input with a live suggestions dropdown (fuzzy substring match). */
function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        spellCheck={false}
        className={`field w-full px-2 py-1.5 font-mono text-[12px] ${invalid ? "ring-1 ring-red-500/60" : ""}`}
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

export function KindIcon({ type }: { type: RunType }) {
  switch (type) {
    case "spring":
      // Spring leaf mark.
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-[#6db33f]" fill="currentColor">
          <path d="M20.2 3.8a10 10 0 0 1-1.9 13.4c-2.9 2.7-7.4 3.2-10.9 1.3.6.2 1.5.3 2.4.2 3.6-.3 6.7-2.4 8.4-5.5-1.3 1.1-2.9 1.8-4.7 2-1.8.2-3.4-.1-4.9-.8 3.4.1 5.9-1 7.6-3.2-2 1-4 1.3-6 1-3.5-.6-5.2-2.7-5.1-2.8.1-.2 5 1.7 9.2-.6 0 0-1.8-.3-3.6-1.3 3.7.3 6.9-1.3 7.8-3.9.1-.2.1-.4-.2-.4-2.2 1.2-4.4 1.6-6.6 1.2 2.4-.5 4.6-1.7 6.3-3.5.3-.3.5-.7.7-1.1 0-.1.1-.3.3-.5.3.9.5 1.9.5 2.9a.5.5 0 0 0 1 0c0-.6 0-1.2-.1-1.8z" />
        </svg>
      );
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
        <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0">
          <g transform="translate(0 -1028.4)">
            <path d="m1 1035.4v1 1 2 1 1 1 1 2 1 2 1c0 1.1 0.8954 2 2 2h9 9c1.105 0 2-0.9 2-2v-1-2-4-2-3-1-1h-22z" fill="#bdc3c7" />
            <path d="m3 2c-1.1046 0-2 0.8954-2 2v3h22v-3c0-1.1046-0.895-2-2-2h-9-9z" transform="translate(0 1028.4)" fill="#bdc3c7" />
            <path d="m1 6v1 1 2 1 1 1 1 2 1 2 1c0 1.105 0.8954 2 2 2h9 9c1.105 0 2-0.895 2-2v-1-2-4-2-3-1-1h-22z" transform="translate(0 1028.4)" fill="#ecf0f1" />
            <path d="m4 4a1 1 0 1 1 -2 0 1 1 0 1 1 2 0z" transform="translate(0 1028.4)" fill="#c0392b" />
            <path d="m4 4a1 1 0 1 1 -2 0 1 1 0 1 1 2 0z" transform="translate(3 1028.4)" fill="#27ae60" />
            <path d="m4 4a1 1 0 1 1 -2 0 1 1 0 1 1 2 0z" transform="translate(6 1028.4)" fill="#f39c12" />
          </g>
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

function ErrorIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
