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
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {tool === "maven" ? <MavenLogo size={13} className="text-[#C71A36]" /> : <GradleLogo size={14} className="text-[#0d9488]" />}
          {LABEL[tool]}
        </span>
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
            <GoalRow key={g.name} tool={tool} label={g.name} title={g.desc} disabled={running} onRun={() => run([g.name])} />
          ))}
        </Group>

        <Group title="Shortcuts" open={openShortcuts} onToggle={() => setOpenShortcuts((o) => !o)}>
          {SHORTCUTS[tool].map((s) => (
            <GoalRow key={s.label} tool={tool} label={s.label} title={`${CLI[tool]} ${s.goals.join(" ")}`} disabled={running} onRun={() => run(s.goals)} />
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

function GoalRow({ tool, label, title, disabled, onRun }: { tool: BuildTool; label: string; title: string; disabled: boolean; onRun: () => void }) {
  return (
    <button
      onClick={onRun}
      disabled={disabled}
      title={title}
      className="group flex w-full items-center gap-2 rounded px-2 py-[3px] pl-6 text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--hover)] disabled:opacity-50"
    >
      {tool === "maven" ? <MavenLogo size={13} className="text-[#C71A36]" /> : <GradleLogo size={14} className="text-[#0d9488]" />}
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{label}</span>
      <PlayGlyph className="shrink-0 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100" />
    </button>
  );
}

// (Gradle rows use the Gradle logo below.)

/** The Gradle elephant logo. */
export function GradleLogo({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" role="img" aria-label="Gradle" className={`shrink-0 ${className}`}>
      <path d="M28.477,7.021a4.436,4.436,0,0,0-6.169-.1.413.413,0,0,0-.133.3.427.427,0,0,0,.123.307l.56.559a.423.423,0,0,0,.553.039,2.517,2.517,0,0,1,1.522-.508,2.545,2.545,0,0,1,1.8,4.343C23.22,15.493,18.5,5.618,7.829,10.7a1.449,1.449,0,0,0-.7,1.924,1.129,1.129,0,0,0,.057.109L9.013,15.9a1.452,1.452,0,0,0,1.962.54l.046-.026-.036.026.812-.456a18.635,18.635,0,0,0,2.557-1.9.443.443,0,0,1,.582-.019.417.417,0,0,1,.06.587.425.425,0,0,1-.06.06,19.372,19.372,0,0,1-2.674,2.017l-.029.016-.811.453a2.263,2.263,0,0,1-1.122.294A2.324,2.324,0,0,1,8.285,16.33L6.552,13.342C3.229,15.69,1.211,20.213,2.294,25.936a.424.424,0,0,0,.417.343H4.68a.421.421,0,0,0,.434-.369,2.89,2.89,0,0,1,5.732,0,.421.421,0,0,0,.411.369h1.92a.425.425,0,0,0,.421-.369,2.887,2.887,0,0,1,5.729,0,.42.42,0,0,0,.417.369h1.9a.419.419,0,0,0,.42-.414c.046-2.677.767-5.752,2.826-7.291C32,13.245,30.126,8.677,28.477,7.021Zm-7.265,8.061v0L19.854,14.4a.854.854,0,1,1,1.358.685Z" />
    </svg>
  );
}

/** The Apache Maven feather logo. */
export function MavenLogo({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" role="img" aria-label="Maven" className={`shrink-0 ${className}`}>
      <path d="M4.237.001c-.312-.013-.665.072-.828.457-.158.374-.283 1.188-.34 2.276l1.223.591c-.02-.737.007-1.43.076-2.066-.026.299-.056.96.006 2.039.019.342.049.725.088 1.15.002.024.002.047.007.069a45.485 45.485 0 0 0 .309 2.412c.057.368.126.752.195 1.16l-.01.01c.014.01.015.018.014.023l.03.16c.03.162.06.328.093.494l.108.553.056.289a61.72 61.72 0 0 0 .457 2.068c.09.382.186.78.287 1.186.098.386.199.783.309 1.193.096.362.199.735.303 1.117.003.018.012.036.015.055a145.826 145.826 0 0 0 .34 1.185l.049.174c.078.261.158.533.242.805a4.2 4.2 0 0 1-.293-.135l-.19-.654c-.02-.077-.042-.148-.062-.225l-.002-.004-.004-.002c-.087-.3-.17-.607-.257-.916-.023-.087-.044-.173-.069-.263l-.314-1.178c-.1-.381-.194-.765-.29-1.154-.094-.39-.185-.78-.277-1.172-.093-.401-.181-.8-.265-1.203-.085-.396-.161-.798-.24-1.193a50.315 50.315 0 0 1-.211-1.17c-.004-.013-.006-.03-.01-.041l.004-.002c-.057-.386-.116-.77-.174-1.15a60.905 60.905 0 0 1-.154-1.204 27.447 27.447 0 0 1-.172-2.41l-1.22-.59c-.004.074-.01.15-.013.23-.012.294-.02.605-.023.93a45.3 45.3 0 0 0 .006 1.157c.009.37.025.755.045 1.148.02.336.042.675.07 1.022l.002.039.006.004c.003.023.007.05.006.076.033.368.064.739.107 1.115a34.493 34.493 0 0 0 .303 2.125c.01.064.024.131.035.195a23.418 23.418 0 0 0 .547 2.32c.07.237.14.464.21.68.063.182.13.365.194.545.155.422.327.832.512 1.232l.006.004a.318.318 0 0 0 .02.05c.225.485.475.95.755 1.395.01.013.02.033.03.047-.455-.183-1.259-.098-1.253-.097.83.288 1.557.64 2.016 1.175-.183.2-.523.352-.953.477.594.064.924-.039 1.045-.092-.31.26-.483.732-.635 1.24.35-.57.696-.949 1.033-1.094.078.258.162.524.244.788A147.532 147.532 0 0 0 5.157 24a.56.56 0 0 0 .43-.312c.13-.282.83-1.775 1.908-3.875.413 1.303.88 2.679 1.386 4.109a.494.494 0 0 0 .076-.465 103.735 103.735 0 0 1-1.308-3.945c.154-.299.316-.612.484-.932.125.04.255.094.389.155.203.186.352.491.482.84a1.515 1.515 0 0 0-.334-1.098c1.335.258 2.547.09 3.287-.81a3.97 3.97 0 0 0 .192-.258c-.325.304-.682.404-1.313.273.996-.281 1.523-.617 2.035-1.22.12-.145.244-.303.371-.48-.943.722-1.927.822-2.9.493l-.045-.018c.914.02 2.203-.474 3.092-1.189.41-.33.796-.73 1.17-1.21.28-.359.55-.76.82-1.216.234-.393.468-.824.7-1.293a2.83 2.83 0 0 1-.74.137l-.144.008c-.048.002-.093 0-.146.002.885-.198 1.5-.74 1.994-1.447-.24.117-.628.262-1.07.297-.058.006-.12.006-.182.006-.013-.002-.028 0-.047-.002.306-.078.574-.178.81-.309a3.363 3.363 0 0 0 .358-.236c.044-.037.088-.07.13-.106.099-.086.193-.18.28-.287.028-.034.056-.063.08-.098.036-.05.073-.098.104-.146a8.388 8.388 0 0 0 .51-.828c.015-.031.032-.057.046-.088.04-.084.08-.16.11-.227.042-.099.074-.179.092-.238a.515.515 0 0 1-.108.051c-.273.112-.727.187-1.086.201-.004 0-.008 0-.013.004h-.067c.72-.214 1.067-.45 1.422-.818a13.883 13.883 0 0 0 1.154-1.428c.264-.37.505-.738.692-1.072a6.5 6.5 0 0 0 .298-.592c.066-.157.122-.305.172-.45-.466.01-.986.011-1.48 0 .495.01 1.015.007 1.484-.005.5-1.485.063-2.262.063-2.262s-.526-1.212-1.4-.851c-.426.175-1.172.73-2.083 1.56l.514 1.45a17.561 17.561 0 0 1 1.703-1.602c-.257.22-.807.726-1.615 1.644-.256.29-.537.624-.844.997-.017.02-.035.038-.047.06a51.435 51.435 0 0 0-1.666 2.187c-.248.34-.498.704-.765 1.088h-.016c.002.02-.004.028-.01.032l-.101.152c-.104.155-.213.31-.318.47l-.352.534c-.061.09-.124.181-.186.277-.184.282-.367.573-.558.873a97.351 97.351 0 0 0-1.428 2.338 96.866 96.866 0 0 0-1.341 2.343c-.012.017-.02.04-.034.057a197.256 197.256 0 0 0-.668 1.223l-.097.181c-.17.318-.346.642-.52.979 0 .004-.005.008-.006.013-.026.048-.05.093-.072.141-.117.222-.218.424-.45.87a1.352 1.352 0 0 0-.233-.182l.345-.65c.047-.089.096-.177.143-.27l.04-.077.546-1.001.13-.233v-.006l-.001-.006c.169-.31.345-.62.52-.94.051-.087.102-.173.153-.265.224-.395.454-.794.684-1.197a91.685 91.685 0 0 1 2.135-3.504c.247-.386.503-.77.754-1.152.092-.138.182-.272.279-.41a72.9 72.9 0 0 1 .48-.701c.007-.012.019-.024.026-.037h.006c.26-.356.517-.713.773-1.065.278-.373.554-.735.83-1.09a31.075 31.075 0 0 1 1.777-2.075l-.515-1.446c-.06.057-.126.116-.192.178a32.37 32.37 0 0 0-.758.729c-.295.294-.597.606-.912.935a46.032 46.032 0 0 0-1.632 1.838l-.03.033.002.008c-.017.02-.033.044-.054.064-.266.323-.538.649-.801.985a39.105 39.105 0 0 0-1.445 1.95c-.043.06-.085.126-.127.186a26.458 26.458 0 0 0-1.403 2.303c-.13.247-.256.485-.37.715-.096.195-.187.395-.278.591-.21.463-.398.93-.566 1.399l.002.006a.36.36 0 0 0-.026.058c-.108.303-.203.608-.29.914-.14.174-.302.325-.483.46a3.505 3.505 0 0 0-.131-.153 5.148 5.148 0 0 0 .824-2.211 6.4 6.4 0 0 0-.016-1.488c-.046-.4-.126-.82-.238-1.274-.097-.393-.217-.81-.363-1.248-.091.185-.22.367-.379.545l-.086.094c-.029.032-.06.06-.092.094.434-.674.486-1.397.358-2.148a2.722 2.722 0 0 1-.49.85c-.033.038-.072.077-.11.116-.01.007-.019.018-.033.028.144-.24.25-.467.318-.698a1.29 1.29 0 0 0 .04-.146 2.85 2.85 0 0 0 .038-.225l.018-.146a2.11 2.11 0 0 0-.002-.354c-.003-.04-.004-.076-.01-.113-.01-.055-.016-.105-.027-.154a7.416 7.416 0 0 0-.193-.84c-.01-.028-.015-.056-.026-.084-.027-.079-.048-.149-.072-.209a2.1 2.1 0 0 0-.09-.209.455.455 0 0 1-.035.1c-.102.24-.34.57-.557.8-.003.003-.007.005-.007.01l-.04.043c.318-.58.39-.946.385-1.398a12.274 12.274 0 0 0-.16-1.615 10.68 10.68 0 0 0-.232-1.104 5.853 5.853 0 0 0-.18-.558 6.337 6.337 0 0 0-.172-.391 26.18 26.18 0 0 0 .002-.004C5.576.341 4.82.124 4.82.124s-.27-.11-.582-.123zm3.38 15.783.032.082v.002c-.06.033-.116.067-.178.097-.012.004-.024.012-.039.018a2.41 2.41 0 0 0 .186-.2zm-.603 1.626c.13.136.25.242.354.32l.07.227a1.866 1.866 0 0 0-.246.053l-.03-.098c-.024-.084-.048-.17-.076-.257l-.021-.073zm.26.875a2.34 2.34 0 0 1 .271.01l.07.229a.778.778 0 0 1 .247-.004l-.326.627a127.643 127.643 0 0 1-.262-.862z" />
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
