import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  aiSettings,
  appVersion,
  detectedJdks,
  setLlmApiKey,
  setModel,
  setToolchainDir,
  toolchainInfo,
  toolPaths,
  type ToolInfo,
} from "../lib/api";
import { applyAppearance, loadAppearance, loadFontFamily, loadFontSize, loadMarginColumn, loadShowMargin, loadWrapAtMargin, saveAppearance, saveFont, saveMargin, type Appearance } from "../lib/theme";
import { editorThemeOptions, loadEditorTheme, saveEditorTheme } from "../lib/editorThemes";

type Tab = "general" | "appearance" | "java" | "ai" | "tools";

const TOOLCHAIN_KEY = "java.toolchainDir";

export function loadToolchainDir(): string {
  return localStorage.getItem(TOOLCHAIN_KEY) ?? "";
}

/** Curated model choices; "" means "use the backend default". */
const MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const MODEL_KEY = "ai.model";

export function loadModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? "";
}

interface Props {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="switch-dialog flex h-[460px] w-[720px] flex-col rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center border-b border-[color:var(--line)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Settings</h2>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[170px] shrink-0 flex-col gap-0.5 border-r border-[color:var(--line)] p-2">
            <TabItem active={tab === "general"} onClick={() => setTab("general")} label="General" />
            <TabItem active={tab === "appearance"} onClick={() => setTab("appearance")} label="Appearance" />
            <TabItem active={tab === "java"} onClick={() => setTab("java")} label="Java" />
            <TabItem active={tab === "ai"} onClick={() => setTab("ai")} label="AI" />
            <TabItem active={tab === "tools"} onClick={() => setTab("tools")} label="Tools" />
          </nav>
          <div className="min-w-0 flex-1 overflow-auto p-5">
            {tab === "general" && <GeneralTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "java" && <JavaTab />}
            {tab === "ai" && <AiTab />}
            {tab === "tools" && <ToolsTab />}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end border-t border-[color:var(--line)] px-4 py-3">
          <button onClick={onClose} className="btn-accent px-3 py-1.5 text-[12.5px]">Done</button>
        </div>
      </div>
    </div>
  );
}

function TabItem({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-left text-[12.5px] font-medium ${
        active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"
      }`}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{title}</h3>
      {children}
    </div>
  );
}

// --- General ----------------------------------------------------------------

function GeneralTab() {
  const { data: version } = useQuery({ queryKey: ["app-version"], queryFn: appVersion });
  const resetLayout = () => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("layout.")) localStorage.removeItem(k);
    }
    location.reload();
  };
  return (
    <div>
      <Section title="About">
        <div className="flex items-center gap-3 text-[12.5px]">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--accent-soft)] text-[18px]">🦀</div>
          <div>
            <div className="font-semibold text-[var(--text-primary)]">Reevik Java ADE</div>
            <div className="text-[11.5px] text-[var(--text-tertiary)]">Version {version ?? "…"}</div>
          </div>
        </div>
      </Section>
      <Section title="Layout">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12px] text-[var(--text-secondary)]">Reset the file-tree, panel, and editor sizes to their defaults.</p>
          <button onClick={resetLayout} className="btn-bezel shrink-0 px-3 py-1.5 text-[12px]">Reset panel layout</button>
        </div>
      </Section>
    </div>
  );
}

// --- Appearance -------------------------------------------------------------

function AppearanceTab() {
  const [choice, setChoice] = useState<Appearance>(loadAppearance());
  const [lightScheme, setLightScheme] = useState<string>(loadEditorTheme(false));
  const [darkScheme, setDarkScheme] = useState<string>(loadEditorTheme(true));
  const [fontFamily, setFontFamily] = useState<string>(loadFontFamily());
  const [fontSize, setFontSize] = useState<number>(loadFontSize());
  const [marginCol, setMarginCol] = useState<number>(loadMarginColumn());
  const [wrapAt, setWrapAt] = useState<boolean>(loadWrapAtMargin());
  const [showMargin, setShowMargin] = useState<boolean>(loadShowMargin());
  const applyMargin = (col: number, wrap: boolean, show: boolean) => {
    setMarginCol(col); setWrapAt(wrap); setShowMargin(show);
    saveMargin(col, wrap, show);
  };
  const pick = (a: Appearance) => {
    setChoice(a);
    saveAppearance(a);
    applyAppearance(a); // applies CSS + native window + notifies editors — live, no reload
  };
  const opts: { id: Appearance; label: string; hint: string }[] = [
    { id: "light", label: "Light", hint: "Always light" },
    { id: "dark", label: "Dark", hint: "Always dark" },
    { id: "system", label: "System", hint: "Follow macOS" },
  ];
  return (
    <div>
      <Section title="Theme">
        <div className="grid grid-cols-3 gap-2">
          {opts.map((o) => (
            <button
              key={o.id}
              onClick={() => pick(o.id)}
              className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-[12px] transition-colors ${
                choice === o.id
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                  : "border-[color:var(--line)] text-[var(--text-secondary)] hover:bg-[var(--hover)]"
              }`}
            >
              <ThemeSwatch kind={o.id} />
              <span className="font-medium">{o.label}</span>
              <span className="text-[10px] text-[var(--text-tertiary)]">{o.hint}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Editor color scheme">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Light appearance</span>
            <select
              value={lightScheme}
              onChange={(e) => {
                const id = e.target.value;
                setLightScheme(id);
                saveEditorTheme(false, id);
                window.dispatchEvent(new Event("rustade:theme"));
              }}
              className="field w-full px-2 py-1.5 text-[12px]"
            >
              {editorThemeOptions(false).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Dark appearance</span>
            <select
              value={darkScheme}
              onChange={(e) => {
                const id = e.target.value;
                setDarkScheme(id);
                saveEditorTheme(true, id);
                window.dispatchEvent(new Event("rustade:theme"));
              }}
              className="field w-full px-2 py-1.5 text-[12px]"
            >
              {editorThemeOptions(true).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">The editor uses the scheme matching the current appearance, so switching to Dark automatically applies your dark scheme. “Default” follows the built-in palette.</p>
      </Section>

      <Section title="Editor font">
        <div className="flex items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Typeface</span>
            <select
              value={fontFamily}
              onChange={(e) => { setFontFamily(e.target.value); saveFont(e.target.value, fontSize); }}
              className="field w-full px-2 py-1.5 text-[12px]"
            >
              {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          <label className="flex w-[110px] shrink-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Size ({fontSize}px)</span>
            <input
              type="range"
              min={9}
              max={22}
              step={1}
              value={fontSize}
              onChange={(e) => { const s = Number(e.target.value); setFontSize(s); saveFont(fontFamily, s); }}
              className="w-full accent-[var(--accent)]"
            />
          </label>
        </div>
        <div
          className="mt-2.5 overflow-hidden rounded-lg border border-[color:var(--line)] bg-[var(--surface-2)] px-3 py-2"
          style={{ fontFamily: fontFamily ? `"${fontFamily}", ui-monospace, "SF Mono", Menlo, monospace` : 'var(--code-font-family, "SF Mono", ui-monospace, Menlo, monospace)', fontSize: `${fontSize}px`, lineHeight: 1.6 }}
        >
          <div className="text-[var(--text-secondary)]"><span className="text-[color:#9333ea]">fn</span> <span className="text-[color:#7c3aed]">main</span>() {"{"}</div>
          <div className="pl-4 text-[var(--text-secondary)]"><span className="text-[color:#0369a1]">println!</span>(<span className="text-[color:#0a7d3c]">"Hello, 世界 0123"</span>);</div>
          <div className="text-[var(--text-secondary)]">{"}"}</div>
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">Applies to the code editor. If a typeface isn’t installed it falls back to the system monospace.</p>
      </Section>

      <Section title="Right margin">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--text-secondary)]">Column</span>
          <input
            type="number"
            min={20}
            max={400}
            step={1}
            value={marginCol}
            onChange={(e) => { const v = Math.max(20, Math.min(400, Number(e.target.value) || 100)); applyMargin(v, wrapAt, showMargin); }}
            className="field w-[90px] px-2 py-1 text-[12.5px]"
          />
          <span className="text-[11px] text-[var(--text-tertiary)]">characters</span>
        </div>
        <label className="mt-2.5 flex items-center gap-2">
          <input type="checkbox" checked={showMargin} onChange={(e) => applyMargin(marginCol, wrapAt, e.target.checked)} className="accent-[var(--accent)]" />
          <span className="text-[12.5px] text-[var(--text-primary)]">Show a gray guide line at the column</span>
        </label>
        <label className="mt-2 flex items-center gap-2">
          <input type="checkbox" checked={wrapAt} onChange={(e) => applyMargin(marginCol, e.target.checked, showMargin)} className="accent-[var(--accent)]" />
          <span className="text-[12.5px] text-[var(--text-primary)]">Wrap long lines at the column</span>
        </label>
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
          The guide and wrapping are independent. Wrapping is display-only — the text on disk isn’t changed.
        </p>
      </Section>
    </div>
  );
}

const FONTS: { label: string; value: string }[] = [
  { label: "System default", value: "" },
  { label: "SF Mono", value: "SF Mono" },
  { label: "Menlo", value: "Menlo" },
  { label: "Monaco", value: "Monaco" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Fira Code", value: "Fira Code" },
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "Source Code Pro", value: "Source Code Pro" },
  { label: "IBM Plex Mono", value: "IBM Plex Mono" },
  { label: "Roboto Mono", value: "Roboto Mono" },
];

function ThemeSwatch({ kind }: { kind: Appearance }) {
  const light = <rect x="1" y="1" width="34" height="22" rx="3" fill="#f4f4f6" stroke="rgba(0,0,0,0.12)" />;
  const dark = <rect x="1" y="1" width="34" height="22" rx="3" fill="#26282e" stroke="rgba(255,255,255,0.14)" />;
  return (
    <svg viewBox="0 0 36 24" width="46" height="30" className="shrink-0">
      {kind === "dark" ? dark : kind === "light" ? light : (
        <>
          <clipPath id="half"><rect x="18" y="0" width="18" height="24" /></clipPath>
          {light}
          <g clipPath="url(#half)">{dark}</g>
        </>
      )}
      <circle cx="7" cy="7" r="2" fill="var(--accent)" />
    </svg>
  );
}

// --- JDK / toolchain --------------------------------------------------------

function JavaTab() {
  const qc = useQueryClient();
  const { data: info } = useQuery({ queryKey: ["toolchain-info"], queryFn: toolchainInfo });
  const { data: jdks } = useQuery({ queryKey: ["detected-jdks"], queryFn: detectedJdks });
  const [dir, setDir] = useState<string>(loadToolchainDir());

  const apply = async (value: string) => {
    setDir(value);
    localStorage.setItem(TOOLCHAIN_KEY, value);
    await setToolchainDir(value || null);
    // Re-detect version/vendor and refresh the Tools tab.
    qc.invalidateQueries({ queryKey: ["toolchain-info"] });
    qc.invalidateQueries({ queryKey: ["tool-paths"] });
  };

  const browse = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Select the JDK bin directory" });
    if (typeof picked === "string") void apply(picked);
  };

  // The active JDK: an explicit override, else whichever detected one owns the
  // auto-detected JAVA_HOME.
  const activeBin = dir || (info?.java_home ? `${info.java_home}/bin` : "");

  return (
    <div>
      <Section title="Detected JDKs">
        {!jdks ? (
          <p className="text-[12px] text-[var(--text-tertiary)]">Detecting…</p>
        ) : jdks.length === 0 ? (
          <p className="text-[12px] text-[var(--text-tertiary)]">No JDKs found. Install one (e.g. <code className="font-mono">brew install openjdk@17</code>) or set a path below.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {jdks.map((j) => {
              const active = j.bin === activeBin;
              return (
                <button
                  key={j.home}
                  onClick={() => void apply(j.bin)}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left ${
                    active ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[color:var(--line)] hover:bg-[var(--hover)]"
                  }`}
                >
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${active ? "border-[var(--accent)]" : "border-[color:var(--line)]"}`}>
                    {active && <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-medium text-[var(--text-primary)]">{j.name || `Java ${j.version}`}</span>
                      <span className="shrink-0 text-[10.5px] text-[var(--text-tertiary)]">{j.arch}</span>
                      {active && <span className="shrink-0 text-[10px] font-medium text-[var(--accent-strong)]">DEFAULT</span>}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-[var(--text-tertiary)]" title={j.home}>{j.home}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
          The selected JDK is used for build, run, debug, the language server, and formatting; its{" "}
          <code className="font-mono">JAVA_HOME</code> is passed to Maven/Gradle. Changing it restarts
          the language server (re-indexing the project).
        </p>
      </Section>

      <Section title="Custom JDK location">
        <div className="flex items-center gap-2">
          <input
            value={dir}
            onChange={(e) => void apply(e.target.value)}
            placeholder="Auto (from PATH) — e.g. /opt/homebrew/opt/openjdk@17/bin"
            className="field min-w-0 flex-1 px-2 py-1.5 font-mono text-[12px]"
          />
          <button onClick={() => void browse()} title="Browse…" className="btn-bezel shrink-0 px-2.5 py-1.5 text-[12px]">…</button>
          {dir && <button onClick={() => void apply("")} title="Reset to auto (use PATH)" className="btn-bezel shrink-0 px-2.5 py-1.5 text-[12px]">Auto</button>}
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
          A JDK’s <code className="font-mono">bin</code> directory, for JDKs not listed above. “Auto” falls back to the JDK on your <code className="font-mono">PATH</code>.
        </p>
      </Section>

      <Section title="Active">
        <Row label="Java version" value={info?.version ? info.version : "—"} />
        <Row label="Vendor" value={info?.vendor ?? "—"} />
        <Row label="java" value={info?.java ?? "not found"} mono muted={!info?.java} />
        <Row label="javac" value={info?.javac ?? "not found"} mono muted={!info?.javac} />
        <Row label="JAVA_HOME" value={info?.java_home ?? "—"} mono />
      </Section>
    </div>
  );
}

function Row({ label, value, mono, muted }: { label: string; value: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-3">
      <span className="w-[120px] shrink-0 text-[12px] text-[var(--text-secondary)]">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-[12px] ${mono ? "font-mono text-[11.5px]" : ""} ${muted ? "text-red-600" : "text-[var(--text-primary)]"}`} title={value}>
        {value}
      </span>
    </div>
  );
}

// --- AI ---------------------------------------------------------------------

function AiTab() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["ai-settings"], queryFn: aiSettings });
  const [model, setModelState] = useState<string>(loadModel());
  const [custom, setCustom] = useState<boolean>(() => {
    const m = loadModel();
    return !!m && !MODELS.some((x) => x.id === m);
  });
  const [key, setKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  const applyModel = (id: string) => {
    setModelState(id);
    localStorage.setItem(MODEL_KEY, id);
    void setModel(id || null);
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    try {
      await setLlmApiKey(key.trim());
      setKey("");
      setKeyMsg("Saved to the system keychain.");
      qc.invalidateQueries({ queryKey: ["ai-settings"] });
      qc.invalidateQueries({ queryKey: ["ai-backend"] });
    } catch (e) {
      setKeyMsg(`Error: ${e}`);
    }
  };

  const backend = settings?.backend ?? "none";
  const backendText =
    backend === "cli" ? "Claude CLI detected — used for AI features." :
    backend === "api" ? "Anthropic API key configured." :
    "No AI backend. Add an API key below, or install the Claude CLI.";

  return (
    <div>
      <Section title="Backend">
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${backend === "none" ? "bg-black/10 text-[var(--text-tertiary)]" : "bg-green-400/15 text-green-700"}`}>
            {backend === "cli" ? "Claude CLI" : backend === "api" ? "API key" : "Offline"}
          </span>
          <span className="text-[12px] text-[var(--text-secondary)]">{backendText}</span>
        </div>
      </Section>

      <Section title="Model">
        <select
          value={custom ? "__custom__" : model}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") { setCustom(true); return; }
            setCustom(false);
            applyModel(v);
          }}
          className="field w-full px-2 py-1.5 text-[12.5px]"
        >
          <option value="">Default{settings?.default_model ? ` (${friendly(settings.default_model)})` : ""}</option>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {custom && (
          <input
            value={model}
            onChange={(e) => applyModel(e.target.value)}
            placeholder="model id, e.g. claude-opus-4-1-20250805"
            className="field mt-2 w-full px-2 py-1.5 font-mono text-[12px]"
          />
        )}
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
          Applies to the AI Assistant chat, code review, and explanations. Leave on Default unless you need a specific model.
        </p>
      </Section>

      <Section title="Anthropic API key">
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => { setKey(e.target.value); setKeyMsg(null); }}
            placeholder={settings?.has_api_key ? "•••••••• (a key is saved — enter a new one to replace)" : "sk-ant-…"}
            className="field min-w-0 flex-1 px-2 py-1.5 font-mono text-[12px]"
          />
          <button onClick={() => void saveKey()} disabled={!key.trim()} className="btn-accent shrink-0 px-3 py-1.5 text-[12px] disabled:opacity-40">Save</button>
        </div>
        {keyMsg && <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">{keyMsg}</p>}
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">Stored in the macOS keychain. The Claude CLI, if installed, takes precedence over the API key.</p>
      </Section>
    </div>
  );
}

function friendly(id: string): string {
  const m = MODELS.find((x) => x.id === id);
  if (m) return m.label;
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// --- Tools ------------------------------------------------------------------

function ToolsTab() {
  const { data, isLoading } = useQuery({ queryKey: ["tool-paths"], queryFn: toolPaths });
  return (
    <div>
      <Section title="Toolchain">
        {isLoading ? (
          <p className="text-[12px] text-[var(--text-tertiary)]">Detecting…</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {(data ?? []).map((t) => <ToolRow key={t.name} tool={t} />)}
          </div>
        )}
      </Section>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${tool.path ? "bg-green-500" : "bg-red-400"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12.5px] font-medium text-[var(--text-primary)]">{tool.name}</span>
          {tool.path ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-tertiary)]" title={tool.path}>{tool.path}</span>
          ) : (
            <span className="text-[11px] font-medium text-red-600">Not found</span>
          )}
        </div>
        {!tool.path && <p className="text-[11px] text-[var(--text-tertiary)]">{tool.hint}</p>}
      </div>
    </div>
  );
}
