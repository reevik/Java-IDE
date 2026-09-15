import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  aiSettings,
  appVersion,
  detectAiConnectors,
  detectedJdks,
  setLlmApiKey,
  setCodeStyle,
  setModel,
  setPreferredConnector,
  setToolchainDir,
  toolchainInfo,
  toolPaths,
  type ToolInfo,
} from "../lib/api";
import {
  loadCodeStyle,
  loadImportedProfiles,
  saveCodeStyle,
  saveImportedProfiles,
  type ImportedProfile,
  type StoredCodeStyle,
} from "../lib/codeStyle";
import { loadSaveActions, saveSaveActions, type SaveActions } from "../lib/saveActions";
import { applyAppearance, loadAppearance, loadFontFamily, loadFontSize, loadMarginColumn, loadShowMargin, loadWrapAtMargin, saveAppearance, saveFont, saveMargin, type Appearance } from "../lib/theme";
import { editorThemeOptions, loadEditorTheme, saveEditorTheme } from "../lib/editorThemes";
import Select from "./Select";

/** IntelliJ-style settings navigation: top-level leaves and expandable groups
 *  whose children are leaves. Each leaf renders a panel on the right. */
interface NavLeaf { id: string; label: string; render: () => React.ReactNode; keywords?: string }
interface NavGroup { id: string; label: string; children: NavLeaf[] }
type NavNode = NavLeaf | NavGroup;
const isGroup = (n: NavNode): n is NavGroup => "children" in n;

const NAV: NavNode[] = [
  { id: "appearance", label: "Appearance", render: () => <AppearanceTab />, keywords: "theme dark light color scheme editor font size family right margin wrap" },
  { id: "general", label: "General", render: () => <GeneralTab />, keywords: "about version layout tabs" },
  {
    id: "editor",
    label: "Editor",
    children: [
      { id: "codestyle", label: "Code Style", render: () => <div><CodeStyleSection /></div>, keywords: "code style formatter google aosp eclipse import xml profile" },
      { id: "saveactions", label: "Save Actions", render: () => <div><SaveActionsSection /></div>, keywords: "actions on save organize imports reformat format" },
    ],
  },
  {
    id: "java",
    label: "Java",
    children: [{ id: "jdk", label: "JDK", render: () => <JdkPanel />, keywords: "jdk java version toolchain home javac vendor sdk runtime" }],
  },
  {
    id: "ai",
    label: "AI",
    children: [
      { id: "ai-connectors", label: "Connectors", render: () => <AiConnectorsPanel />, keywords: "ai connectors claude code anthropic ollama default agent detect backend" },
      { id: "ai-model", label: "Model & API", render: () => <AiModelPanel />, keywords: "model api key anthropic sonnet opus haiku token" },
    ],
  },
  { id: "tools", label: "Tools", render: () => <ToolsTab />, keywords: "tools toolchain maven gradle git paths executables" },
];

const ALL_LEAVES: NavLeaf[] = NAV.flatMap((n) => (isGroup(n) ? n.children : [n]));
/** The group label for a leaf id, for search-result context. */
const GROUP_OF: Record<string, string> = Object.fromEntries(
  NAV.flatMap((n) => (isGroup(n) ? n.children.map((c) => [c.id, n.label] as const) : [])),
);

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

const CONNECTOR_KEY = "ai.connector";

/** The user's chosen default AI connector id, or "" for automatic. */
export function loadPreferredConnector(): string {
  return localStorage.getItem(CONNECTOR_KEY) ?? "";
}
export function savePreferredConnector(id: string) {
  if (id) localStorage.setItem(CONNECTOR_KEY, id);
  else localStorage.removeItem(CONNECTOR_KEY);
}

interface Props {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: Props) {
  const [sel, setSel] = useState<string>("appearance");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const current = ALL_LEAVES.find((l) => l.id === sel) ?? ALL_LEAVES[0];

  const toggle = (id: string) => setCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const q = query.trim().toLowerCase();
  const results = q
    ? ALL_LEAVES.filter((l) => `${GROUP_OF[l.id] ?? ""} ${l.label} ${l.keywords ?? ""}`.toLowerCase().includes(q))
    : [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="switch-dialog flex h-[520px] w-[760px] flex-col rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center border-b border-[color:var(--line)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Settings</h2>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-[color:var(--line)] p-2">
            <div className="relative mb-1.5">
              <SearchIcon />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && results.length) { setSel(results[0].id); setQuery(""); } if (e.key === "Escape") setQuery(""); }}
                placeholder="Search settings…"
                className="field w-full py-1 pl-7 pr-2 text-[12px]"
              />
            </div>
            {q ? (
              results.length === 0 ? (
                <p className="px-2 py-3 text-[11.5px] text-[var(--text-tertiary)]">No matching settings.</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {results.map((leaf) => (
                    <button
                      key={leaf.id}
                      onClick={() => { setSel(leaf.id); setQuery(""); }}
                      className={`rounded-md px-3 py-1.5 text-left text-[12.5px] ${sel === leaf.id ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"}`}
                    >
                      {GROUP_OF[leaf.id] && <span className="text-[var(--text-tertiary)]">{GROUP_OF[leaf.id]} › </span>}
                      {leaf.label}
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div className="flex flex-col gap-0.5">
                {NAV.map((node) =>
                  isGroup(node) ? (
                    <div key={node.id}>
                      <button
                        onClick={() => {
                          const willOpen = collapsed.has(node.id);
                          toggle(node.id);
                          if (willOpen) setSel(node.children[0].id);
                        }}
                        className="flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-[12.5px] font-semibold text-[var(--text-primary)] hover:bg-[var(--hover)]"
                      >
                        <Chevron open={!collapsed.has(node.id)} />
                        {node.label}
                      </button>
                      {!collapsed.has(node.id) &&
                        node.children.map((leaf) => (
                          <NavItem key={leaf.id} active={sel === leaf.id} onClick={() => setSel(leaf.id)} label={leaf.label} indent />
                        ))}
                    </div>
                  ) : (
                    <NavItem key={node.id} active={sel === node.id} onClick={() => setSel(node.id)} label={node.label} />
                  ),
                )}
              </div>
            )}
          </nav>
          <div className="min-w-0 flex-1 overflow-auto p-5">{current.render()}</div>
        </div>
        <div className="flex shrink-0 items-center justify-end border-t border-[color:var(--line)] px-4 py-3">
          <button onClick={onClose} className="btn-accent px-3 py-1.5 text-[12.5px]">Done</button>
        </div>
      </div>
    </div>
  );
}

function NavItem({ active, onClick, label, indent }: { active: boolean; onClick: () => void; label: string; indent?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md py-1.5 text-left text-[12.5px] ${indent ? "pl-6 pr-3" : "px-3 font-medium"} ${
        active ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]" : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"
      }`}
    >
      {label}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
    </svg>
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
            <Select
              value={lightScheme}
              onChange={(id) => { setLightScheme(id); saveEditorTheme(false, id); window.dispatchEvent(new Event("rustade:theme")); }}
              className="field w-full px-2 py-1.5 text-[12px]"
              options={editorThemeOptions(false).map((o) => ({ value: o.id, label: o.name }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Dark appearance</span>
            <Select
              value={darkScheme}
              onChange={(id) => { setDarkScheme(id); saveEditorTheme(true, id); window.dispatchEvent(new Event("rustade:theme")); }}
              className="field w-full px-2 py-1.5 text-[12px]"
              options={editorThemeOptions(true).map((o) => ({ value: o.id, label: o.name }))}
            />
          </label>
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">The editor uses the scheme matching the current appearance, so switching to Dark automatically applies your dark scheme. “Default” follows the built-in palette.</p>
      </Section>

      <Section title="Editor font">
        <div className="flex items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Typeface</span>
            <Select
              value={fontFamily}
              onChange={(v) => { setFontFamily(v); saveFont(v, fontSize); }}
              className="field w-full px-2 py-1.5 text-[12px]"
              options={FONTS.map((f) => ({ value: f.value, label: f.label }))}
            />
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

function JdkPanel() {
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

// --- Code style -------------------------------------------------------------

const BUILTIN_STYLES: { kind: "google" | "aosp"; label: string; hint: string }[] = [
  { kind: "google", label: "Google Java Style", hint: "google-java-format" },
  { kind: "aosp", label: "AOSP (Android)", hint: "google-java-format --aosp" },
];

function CodeStyleSection() {
  const [style, setStyle] = useState<StoredCodeStyle>(() => loadCodeStyle());
  const [profiles, setProfiles] = useState<ImportedProfile[]>(() => loadImportedProfiles());
  const [err, setErr] = useState<string | null>(null);

  const applyStyle = (s: StoredCodeStyle) => {
    setStyle(s);
    saveCodeStyle(s);
    void setCodeStyle(s.kind, s.path);
  };

  const importXml = async () => {
    setErr(null);
    const picked = await open({
      multiple: false,
      title: "Import an Eclipse formatter profile (.xml)",
      filters: [{ name: "Eclipse formatter", extensions: ["xml"] }],
    });
    if (typeof picked !== "string") return;
    const name = picked.split("/").pop() || picked;
    const next = [...profiles.filter((p) => p.path !== picked), { name, path: picked }];
    setProfiles(next);
    saveImportedProfiles(next);
    applyStyle({ kind: "eclipse", path: picked, name });
  };

  const removeProfile = (path: string) => {
    const next = profiles.filter((p) => p.path !== path);
    setProfiles(next);
    saveImportedProfiles(next);
    if (style.kind === "eclipse" && style.path === path) applyStyle({ kind: "google" });
  };

  const isActive = (kind: string, path?: string) =>
    style.kind === kind && (kind !== "eclipse" || style.path === path);

  return (
    <Section title="Code style">
      <div className="flex flex-col gap-1">
        {BUILTIN_STYLES.map((s) => (
          <StyleRow
            key={s.kind}
            active={isActive(s.kind)}
            label={s.label}
            hint={s.hint}
            onSelect={() => applyStyle({ kind: s.kind })}
          />
        ))}
        {profiles.map((p) => (
          <StyleRow
            key={p.path}
            active={isActive("eclipse", p.path)}
            label={p.name}
            hint="Eclipse formatter profile"
            onSelect={() => applyStyle({ kind: "eclipse", path: p.path, name: p.name })}
            onRemove={() => removeProfile(p.path)}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => void importXml()} className="btn-bezel px-2.5 py-1.5 text-[12px]">Import formatter XML…</button>
        {err && <span className="text-[11px] text-[var(--danger,#c22)]">{err}</span>}
      </div>
      <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
        Google/AOSP use <code className="font-mono">google-java-format</code>; an imported Eclipse formatter
        profile (<code className="font-mono">.xml</code>) is applied via the language server. Reformat with{" "}
        <kbd className="rounded bg-[var(--surface-2)] px-1">⌘⌥L</kbd>.
      </p>
    </Section>
  );
}

// --- Actions on save --------------------------------------------------------

function SaveActionsSection() {
  const [actions, setActions] = useState<SaveActions>(() => loadSaveActions());
  const set = (patch: Partial<SaveActions>) => {
    const next = { ...actions, ...patch };
    setActions(next);
    saveSaveActions(next);
  };
  return (
    <Section title="Actions on save">
      <div className="flex flex-col gap-1.5">
        <CheckRow
          checked={actions.organizeImports}
          onChange={(v) => set({ organizeImports: v })}
          label="Organize imports"
          hint="Add missing, remove unused, and sort imports"
        />
        <CheckRow
          checked={actions.format}
          onChange={(v) => set({ format: v })}
          label="Reformat code"
          hint="Apply the selected code style"
        />
      </div>
      <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
        Run automatically for Java files on every save. Organize imports runs first, then reformat.
      </p>
    </Section>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-0.5 hover:bg-[var(--hover)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
      <span className="text-[12.5px] text-[var(--text-primary)]">{label}</span>
      <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">{hint}</span>
    </label>
  );
}

function StyleRow({
  active,
  label,
  hint,
  onSelect,
  onRemove,
}: {
  active: boolean;
  label: string;
  hint: string;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
        active ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[color:var(--line)] hover:bg-[var(--hover)]"
      }`}
    >
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${active ? "border-[var(--accent)]" : "border-[var(--text-tertiary)]"}`}>
          {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
        </span>
        <span className="min-w-0 truncate text-[12.5px] text-[var(--text-primary)]">{label}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-[var(--text-tertiary)]">{hint}</span>
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          title="Remove this profile"
          className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 hover:text-red-600 group-hover:opacity-100"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      )}
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

function ConnectorsSection() {
  const qc = useQueryClient();
  const { data: connectors, isLoading, refetch, isFetching } = useQuery({ queryKey: ["ai-connectors"], queryFn: detectAiConnectors });
  const [sel, setSel] = useState<string>(loadPreferredConnector());

  const choose = (id: string) => {
    setSel(id);
    savePreferredConnector(id);
    void setPreferredConnector(id || null);
    qc.invalidateQueries({ queryKey: ["ai-settings"] });
    qc.invalidateQueries({ queryKey: ["ai-backend"] });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <p className="text-[11.5px] text-[var(--text-tertiary)]">Detected AI agents on this machine. Pick the default.</p>
        <button onClick={() => void refetch()} className="btn-bezel shrink-0 px-2 py-0.5 text-[11px]">{isFetching ? "Scanning…" : "Re-scan"}</button>
      </div>

      <ConnectorRow selected={sel === ""} disabled={false} onSelect={() => choose("")} label="Automatic" detail="Prefer Claude Code, else the Anthropic API." available dot="auto" />

      {isLoading ? (
        <p className="text-[12px] text-[var(--text-tertiary)]">Scanning…</p>
      ) : (
        connectors?.map((c) => (
          <ConnectorRow
            key={c.id}
            selected={sel === c.id}
            disabled={!c.usable}
            onSelect={() => c.usable && choose(c.id)}
            label={c.label}
            detail={c.detail}
            available={c.available}
            dot={c.available ? (c.usable ? "ok" : "detected") : "off"}
          />
        ))
      )}
    </div>
  );
}

function ConnectorRow({ selected, disabled, onSelect, label, detail, available, dot }: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  detail: string;
  available: boolean;
  dot: "ok" | "detected" | "off" | "auto";
}) {
  const color = dot === "ok" ? "#1a7f37" : dot === "detected" ? "#c47f00" : dot === "auto" ? "var(--accent)" : "var(--text-tertiary)";
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left ${selected ? "border-[color:var(--accent)] bg-[var(--accent-soft)]" : "border-[color:var(--line)]"} ${disabled ? "cursor-default opacity-60" : "hover:bg-[var(--hover)]"}`}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border" style={{ borderColor: selected ? "var(--accent)" : "var(--line)" }}>
        {selected && <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />}
      </span>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">{label}</span>
        <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{detail}</span>
      </span>
      {!available && <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">not found</span>}
    </button>
  );
}

/** The AI Connectors leaf. */
function AiConnectorsPanel() {
  return (
    <div>
      <Section title="AI Connectors">
        <ConnectorsSection />
      </Section>
    </div>
  );
}

function AiModelPanel() {
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

  return (
    <div>
      <Section title="Model">
        <Select
          value={custom ? "__custom__" : model}
          onChange={(v) => { if (v === "__custom__") { setCustom(true); return; } setCustom(false); applyModel(v); }}
          className="field w-full px-2 py-1.5 text-[12.5px]"
          options={[
            { value: "", label: `Default${settings?.default_model ? ` (${friendly(settings.default_model)})` : ""}` },
            ...MODELS.map((m) => ({ value: m.id, label: m.label })),
            { value: "__custom__", label: "Custom…" },
          ]}
        />
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
