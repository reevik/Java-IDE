import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ProjectLauncher from "./components/ProjectLauncher";
import FileTree, { type NewKind } from "./components/FileTree";
import ProjectSettingsDialog from "./components/ProjectSettingsDialog";
import { DEFAULT_ROOTS, hasSavedSourceRoots, loadSourceRoots, saveSourceRoots, type SourceRoots } from "./lib/sourceRoots";
import CodeEditor, { type CodeEditorHandle, type Runnable } from "./components/CodeEditor";
import OutputPanel, { type OutputLine, type OutputTab } from "./components/OutputPanel";
import DiffView from "./components/DiffView";
import MarkdownEditor from "./components/MarkdownEditor";
import ModulesView from "./components/ModulesView";
import DependenciesView from "./components/DependenciesView";
import BuildView, { GradleLogo, MavenLogo } from "./components/BuildView";
import CommandPalette, { type Command } from "./components/CommandPalette";
import QuickOpen, { type QuickFile } from "./components/QuickOpen";
import SearchOverlay from "./components/SearchOverlay";
import AiPanel from "./components/AiPanel";
import ChatPanel from "./components/ChatPanel";
import SkillsPanel from "./components/SkillsPanel";
import ActivityBar from "./components/ActivityBar";
import StatusBar from "./components/StatusBar";
import RunConfigBar from "./components/RunConfigBar";
import RunConfigDialog from "./components/RunConfigDialog";
import SettingsDialog, { loadModel, loadPreferredConnector, loadToolchainDir } from "./components/SettingsDialog";
import TaskBoardDialog from "./components/TaskBoardDialog";
import { loadCodeStyle } from "./lib/codeStyle";
import { loadSaveActions } from "./lib/saveActions";
import {
  loadConfigs,
  saveConfigs,
  loadSelectedId,
  saveSelectedId,
  defaultConfigs,
  toCargo,
  goalsFor,
  isGoalConfig,
  newId,
  type RunConfig,
} from "./lib/runConfigs";
import { type DebugStatus } from "./components/DebuggerView";
import { type UsagesResult } from "./components/UsagesView";
import { type Reference, type FileEdit } from "./lib/api";
import { runBootstrap } from "./lib/bootstrap";
import Resizer from "./components/Resizer";
import {
  addProject,
  cargoCancel,
  cargoRun,
  createDir,
  createFile,
  deletePath,
  movePaths,
  copyPaths,
  debuggerAdapter,
  gitFileDiff,
  gitWorkingDiff,
  listProjects,
  listTests,
  runJavaMain,
  springMains,
  openProjectWindow,
  setModel,
  setPreferredConnector,
  setToolchainDir,
  formatJava,
  debugContinue,
  debugEval,
  debugNext,
  debugSetBreakpoints,
  debugStack,
  debugStart,
  debugAttach,
  debugStepIn,
  debugStepOut,
  debugStop,
  gitBranch,
  detectSourceRoots,
  organizeImports,
  runMavenGoals,
  setCodeStyle,
  lspClassFileContents,
  lspDidSave,
  lspSync,
  projectInfo,
  readFile,
  readProjectTree,
  writeFile,
  type StackFrame,
} from "./lib/api";
import type { Breakpoint, CargoCommand, CargoEvent, Diagnostic, LspDiagnostic, LspDiagnosticsParams, OpenFile, ProjectRef, TreeNode } from "./lib/types";
import {
  loadBreakpoints,
  saveBreakpoints,
  toSourceBreakpoints,
  toSourceMap,
  type BreakpointMap,
} from "./lib/breakpoints";
import "./App.css";

const TREE_DEFAULT = 240;
const OUTPUT_DEFAULT = 220;
const EMPTY_DIAG: LspDiagnostic[] = [];
const EMPTY_BREAKPOINTS: Breakpoint[] = [];

/** Apply LSP text edits (0-based line/char ranges) to a document string. */
function applyEditsToText(text: string, edits: FileEdit["edits"]): string {
  const lineStart: number[] = [];
  let off = 0;
  for (const line of text.split("\n")) {
    lineStart.push(off);
    off += line.length + 1;
  }
  const pos = (l: number, c: number) => (lineStart[l] ?? text.length) + c;
  const sorted = edits
    .map((e) => ({ from: pos(e.startLine, e.startCharacter), to: pos(e.endLine, e.endCharacter), insert: e.newText }))
    .sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const e of sorted) out = out.slice(0, Math.max(0, e.from)) + e.insert + out.slice(Math.max(0, e.to));
  return out;
}

function basename(p: string) {
  return p.split("/").pop() || p;
}

/** Cap on simultaneously-open editor tabs; opening more evicts the oldest one
 *  that's safe to close (not pinned, not unsaved). */
const MAX_OPEN = 30;

/** Tab label for a `jdt://…/Pkg/Simple.class?=…` library URI: `Simple.java`
 * (`.java` so the editor highlights the decompiled/attached source as Java). */
function jdtDisplayName(uri: string) {
  const m = /\/([^/?]+)\.class(?:\?|$)/.exec(uri);
  return `${m ? m[1] : "library"}.java`;
}

function num(key: string, fallback: number) {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export default function App() {
  const qc = useQueryClient();
  const [project, setProject] = useState<ProjectRef | null>(null);
  // A new window may be launched with a project to open (?open=<path>).
  const openParam = useMemo(() => {
    const p = new URLSearchParams(window.location.search).get("open");
    return p ? decodeURIComponent(p) : null;
  }, []);
  const [booting, setBooting] = useState(!!openParam);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Split editor: an optional second group ("row" = side by side, "col" = stacked)
  // with its own tab list + active file, sharing the same buffer pool (`files`).
  const [split, setSplit] = useState<null | "row" | "col">(null);
  const [secPaths, setSecPaths] = useState<string[]>([]);
  const [secActive, setSecActive] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<0 | 1>(0);
  // Pinned tabs (by path): protected from Close / Close Others / Close All / ×.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  // "Find Usages" results shown in the bottom Usages panel.
  const [usages, setUsages] = useState<UsagesResult | null>(null);
  // Collaborative agent editing: whether the agent is running + the file it's editing.
  const [agentActive, setAgentActive] = useState(false);
  const [agentEditPath, setAgentEditPath] = useState<string | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [quickOpen, setQuickOpen] = useState<null | "files" | "commands">(null);
  const [showSearch, setShowSearch] = useState(false);
  const [aiWidth, setAiWidth] = useState(() => num("layout.ai", 300));
  // Right side: "review" (Intelligent Review) | "chat" (Vibe Coder) | null (hidden).
  const [rightPanel, setRightPanel] = useState<"review" | "chat" | "skills" | null>(() => {
    const v = localStorage.getItem("layout.rightPanel");
    return v === "chat" ? "chat" : v === "skills" ? "skills" : v === "hidden" ? null : "review";
  });
  const [selection, setSelection] = useState("");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [lspDiag, setLspDiag] = useState<Record<string, LspDiagnostic[]>>({});

  // MRU trail of edited files (oldest → newest) + a cursor for prev/next navigation.
  const [editTrail, setEditTrail] = useState<string[]>([]);
  const [trailPos, setTrailPos] = useState(-1);
  const editTrailRef = useRef<string[]>([]);
  editTrailRef.current = editTrail;
  useEffect(() => localStorage.setItem("layout.ai", String(aiWidth)), [aiWidth]);
  useEffect(() => localStorage.setItem("layout.rightPanel", rightPanel ?? "hidden"), [rightPanel]);

  // Layout (persisted)
  const [treeWidth, setTreeWidth] = useState(() => num("layout.tree", TREE_DEFAULT));
  const [outputHeight, setOutputHeight] = useState(() => num("layout.output", OUTPUT_DEFAULT));
  const [treeHidden, setTreeHidden] = useState(() => localStorage.getItem("layout.treeHidden") === "1");
  const [outputHidden, setOutputHidden] = useState(() => localStorage.getItem("layout.outputHidden") === "1");
  useEffect(() => localStorage.setItem("layout.tree", String(treeWidth)), [treeWidth]);
  useEffect(() => localStorage.setItem("layout.output", String(outputHeight)), [outputHeight]);
  useEffect(() => localStorage.setItem("layout.treeHidden", treeHidden ? "1" : ""), [treeHidden]);
  useEffect(() => localStorage.setItem("layout.outputHidden", outputHidden ? "1" : ""), [outputHidden]);

  // Cargo run state
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [running, setRunning] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ code: number; secs: number } | null>(null);

  // Run configurations (IntelliJ-style), persisted per project in localStorage.
  const [runConfigs, setRunConfigs] = useState<RunConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const [editingConfigs, setEditingConfigs] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [gotoLine, setGotoLine] = useState(false);
  const [runMenu, setRunMenu] = useState<{ run: Runnable; path: string; x: number; y: number } | null>(null);
  const [leftTab, setLeftTab] = useState<"project" | "modules" | "dependencies" | "maven">("project");

  // Apply persisted AI model + toolchain overrides to the backend on startup.
  useEffect(() => {
    const m = loadModel();
    if (m) void setModel(m);
    const conn = loadPreferredConnector();
    if (conn) void setPreferredConnector(conn);
    const tc = loadToolchainDir();
    if (tc) void setToolchainDir(tc);
    const cs = loadCodeStyle();
    void setCodeStyle(cs.kind, cs.path);
  }, []);
  // Test names for filter suggestions, fetched lazily while the dialog is open.
  const { data: testNames } = useQuery({
    queryKey: ["tests", project?.path],
    queryFn: () => listTests(project!.path),
    enabled: !!project && editingConfigs,
    staleTime: 30_000,
  });
  const { data: springMainNames } = useQuery({
    queryKey: ["spring-mains", project?.path],
    queryFn: () => springMains(project!.path),
    enabled: !!project && editingConfigs,
    staleTime: 30_000,
  });

  // Debugger state
  const [breakpoints, setBreakpoints] = useState<BreakpointMap>({});
  const [debugStatus, setDebugStatus] = useState<DebugStatus>("idle");
  const [threadId, setThreadId] = useState<number | null>(null);
  const [frames, setFrames] = useState<StackFrame[]>([]);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [stopPos, setStopPos] = useState<{ path: string; line: number } | null>(null);
  const [debugConsole, setDebugConsole] = useState<string[]>([]);
  const [debugTarget, setDebugTarget] = useState<{ kind: "bin" | "test"; name: string | null }>({ kind: "bin", name: null });
  const [outputTab, setOutputTab] = useState<OutputTab>("problems");

  const filesRef = useRef<OpenFile[]>([]);
  filesRef.current = files;
  const activeRef = useRef<string | null>(null);
  activeRef.current = activePath;
  const projectRef = useRef<string | null>(null);
  projectRef.current = project?.path ?? null;
  const breakpointsRef = useRef<BreakpointMap>({});
  breakpointsRef.current = breakpoints;
  const threadIdRef = useRef<number | null>(null);
  threadIdRef.current = threadId;
  const debugStatusRef = useRef<DebugStatus>("idle");
  debugStatusRef.current = debugStatus;
  const selectedFrameRef = useRef<number | null>(null);
  selectedFrameRef.current = selectedFrame;
  const hasDebuggerRef = useRef(true);
  const editorRef = useRef<CodeEditorHandle>(null);
  const editorRef2 = useRef<CodeEditorHandle>(null);
  const activeGroupRef = useRef<0 | 1>(0);
  activeGroupRef.current = activeGroup;
  const secActiveRef = useRef<string | null>(null);
  secActiveRef.current = secActive;
  const openFileRef = useRef<(p: string) => void>(() => {});
  /** The editor handle for the currently focused group (for fold/format/etc.). */
  const activeEditor = () => (activeGroupRef.current === 1 ? editorRef2 : editorRef).current;
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const { data: tree, isFetching: treeLoading } = useQuery({
    queryKey: ["tree", project?.path],
    queryFn: () => readProjectTree(project!.path),
    enabled: !!project,
  });
  const { data: info } = useQuery({
    queryKey: ["info", project?.path],
    queryFn: () => projectInfo(project!.path),
    enabled: !!project,
  });
  // Whether a debug adapter is installed (null → not found; disables debugging).
  const { data: dbgAdapter } = useQuery({
    queryKey: ["debugger-adapter"],
    queryFn: debuggerAdapter,
    staleTime: Infinity,
  });
  const hasDebugger = dbgAdapter != null;
  hasDebuggerRef.current = hasDebugger;
  const { data: branch } = useQuery({
    queryKey: ["branch", project?.path],
    queryFn: () => gitBranch(project!.path),
    enabled: !!project,
  });

  const active = files.find((f) => f.path === activePath) ?? null;
  // Secondary group's tab list + active file (a view over the shared buffer pool).
  const secFiles = secPaths.map((p) => files.find((f) => f.path === p)).filter((f): f is OpenFile => !!f);
  // The Build panel shows the project's build tool (Maven goals / Gradle tasks).
  const buildTool: "maven" | "gradle" | null = tree?.some((n) => n.name === "pom.xml")
    ? "maven"
    : tree?.some((n) => n.name.startsWith("build.gradle"))
      ? "gradle"
      : null;
  const secActiveFile = files.find((f) => f.path === secActive) ?? null;
  /** The file the focused group is showing (drives cursor-line commands). */
  const focusedFile = activeGroup === 1 ? secActiveFile : active;

  // Apply a code block from the AI Assistant to the focused editor. First tries an
  // anchor match (replace the region whose first+last lines match the block); else
  // replaces the selection / inserts at the cursor.
  const applyChatCode = useCallback(
    (code: string): "applied" | "inserted" | "none" => {
      const ed = activeEditor();
      const f = activeGroupRef.current === 1 ? secActiveFile : active;
      if (!ed || !f || f.readOnly || f.kind === "diff") return "none";
      const snippet = code.replace(/\s+$/, "");
      const lines = snippet.split("\n");
      const firstT = lines.find((l) => l.trim())?.trim();
      let lastT: string | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim()) {
          lastT = lines[i].trim();
          break;
        }
      }
      if (firstT && lastT) {
        const fileLines = f.content.split("\n");
        const start = fileLines.findIndex((l) => l.trim() === firstT);
        if (start >= 0) {
          let end = -1;
          for (let i = start; i < fileLines.length; i++) {
            if (fileLines[i].trim() === lastT) {
              end = i;
              break;
            }
          }
          if (end >= start) {
            const original = fileLines.slice(start, end + 1).join("\n");
            if (f.content.includes(original) && ed.applyEdit(original, snippet)) return "applied";
          }
        }
      }
      ed.replaceSelectionOrInsert(snippet);
      return "inserted";
    },
    [active, secActiveFile],
  );

  // Show Find Usages results in the bottom Usages panel.
  const showUsages = useCallback((symbol: string, refs: Reference[]) => {
    setUsages({ symbol, refs });
    setOutputHidden(false);
    setOutputTab("usages");
  }, []);

  // Open the current file in a new split group to the right / below.
  const splitEditor = useCallback((dir: "row" | "col") => {
    const p = activeGroup === 1 ? secActive : activePath;
    if (!p) return;
    setSplit(dir);
    setSecPaths((prev) => (prev.includes(p) ? prev : [...prev, p]));
    setSecActive(p);
    setActiveGroup(1);
  }, [activeGroup, activePath, secActive]);

  // Close tab(s) in the secondary group; collapse the split when it empties.
  const closeSecTabs = useCallback((paths: string[]) => {
    if (!paths.length) return;
    const set = new Set(paths);
    setSecPaths((prev) => {
      const next = prev.filter((p) => !set.has(p));
      if (next.length === 0) {
        setSplit(null);
        setActiveGroup(0);
        setSecActive(null);
      } else {
        setSecActive((cur) => (cur && set.has(cur) ? next[next.length - 1] : cur));
      }
      return next;
    });
  }, []);

  // Run the startup bootstrap once the app has mounted, then dismiss the splash
  // screen and reveal this (initially hidden) window.
  useEffect(() => {
    void runBootstrap();
  }, []);

  // --- Run configurations -----------------------------------------------------

  // Load a project's saved configs + breakpoints when it opens.
  useEffect(() => {
    if (!project) return;
    setRunConfigs(loadConfigs(project.path));
    setSelectedConfigId(loadSelectedId(project.path));
    setBreakpoints(loadBreakpoints(project.path));
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed sensible defaults (a Run per detected main class + All Tests) when a
  // project opens with none saved. Waits for project info so mains are available.
  useEffect(() => {
    if (!project || !info) return;
    if (loadConfigs(project.path).length > 0) return;
    const seeded = defaultConfigs(info.bins ?? []);
    setRunConfigs(seeded);
    saveConfigs(project.path, seeded);
  }, [project?.path, info]); // eslint-disable-line react-hooks/exhaustive-deps

  // Source-root config (drives package flattening + root icons in the tree).
  const [sourceRoots, setSourceRoots] = useState<SourceRoots>({});
  const [structureOpen, setStructureOpen] = useState(false);
  useEffect(() => {
    if (!project) return;
    // A user override wins; otherwise auto-detect from the project's Maven build
    // config (or the conventional src/main/java… layout).
    if (hasSavedSourceRoots(project.path)) {
      setSourceRoots(loadSourceRoots(project.path));
      return;
    }
    let alive = true;
    setSourceRoots({});
    detectSourceRoots(project.path)
      .then((roots) => alive && setSourceRoots(roots as SourceRoots))
      .catch(() => alive && setSourceRoots({ ...DEFAULT_ROOTS }));
    return () => { alive = false; };
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedConfig = runConfigs.find((c) => c.id === selectedConfigId) ?? runConfigs[0];

  const selectConfig = useCallback(
    (id: string) => {
      setSelectedConfigId(id);
      if (project) saveSelectedId(project.path, id);
    },
    [project],
  );

  const persistConfigs = useCallback(
    (next: RunConfig[]) => {
      setRunConfigs(next);
      if (project) saveConfigs(project.path, next);
      if (next.length && !next.some((c) => c.id === selectedConfigId)) selectConfig(next[0].id);
    },
    [project, selectedConfigId, selectConfig],
  );

  // Flat list of files for Quick Open, derived from the project tree.
  const quickFiles: QuickFile[] = useMemo(() => {
    const out: QuickFile[] = [];
    const rootLen = project ? project.path.length + 1 : 0;
    const walk = (nodes: TreeNode[] | null | undefined) => {
      for (const n of nodes ?? []) {
        if (n.kind === "dir") walk(n.children);
        else out.push({ path: n.path, name: n.name, rel: n.path.slice(rootLen) });
      }
    };
    walk(tree);
    return out;
  }, [tree, project]);

  // Push a file to rust-analyzer so it re-checks and pushes diagnostics.
  const syncLsp = useCallback(
    (path: string, text: string) => {
      if (project && path.endsWith(".java")) lspSync(project.path, path, text).catch(() => {});
    },
    [project],
  );

  // Re-read every open file from disk (after the AI agent edits them) + refresh the
  // tree/git so new/changed files show up.
  const reloadOpenFiles = useCallback(async () => {
    for (const f of filesRef.current) {
      if (f.kind === "diff" || f.readOnly) continue;
      try {
        const text = await readFile(f.path);
        if (text !== f.content) {
          setFiles((prev) => {
            const arr = prev.map((x) => (x.path === f.path ? { ...x, content: text, rev: x.rev + 1, saveState: "saved" as const } : x));
            filesRef.current = arr;
            return arr;
          });
          syncLsp(f.path, text);
        }
      } catch {
        /* file may have been deleted by the agent */
      }
    }
    qc.invalidateQueries({ queryKey: ["tree", projectRef.current] });
    qc.invalidateQueries({ queryKey: ["git-status"] });
    qc.invalidateQueries({ queryKey: ["git-log"] });
  }, [qc, syncLsp]);

  // Apply a project-wide rename (LSP): edit open buffers + write every file.
  const applyRename = useCallback(
    async (edits: FileEdit[]) => {
      for (const fe of edits) {
        const open = filesRef.current.find((f) => f.path === fe.path);
        const base = open ? open.content : await readFile(fe.path).catch(() => null);
        if (base == null) continue;
        const next = applyEditsToText(base, fe.edits);
        if (next === base) continue;
        try {
          await writeFile(fe.path, next);
        } catch (e) {
          console.error(e);
          continue;
        }
        if (open) {
          setFiles((prev) => {
            const arr = prev.map((f) => (f.path === fe.path ? { ...f, content: next, rev: f.rev + 1, saveState: "saved" as const } : f));
            filesRef.current = arr;
            return arr;
          });
          syncLsp(fe.path, next);
        }
      }
      qc.invalidateQueries({ queryKey: ["tree", projectRef.current] });
    },
    [qc, syncLsp],
  );

  // rust-analyzer diagnostics, keyed by absolute path.
  useEffect(() => {
    const un = listen<LspDiagnosticsParams>("lsp:diagnostics", (e) => {
      const path = e.payload.uri.replace(/^file:\/\//, "");
      setLspDiag((prev) => ({ ...prev, [path]: e.payload.diagnostics }));
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  const applySuggestion = useCallback(
    (original: string, replacement: string) => {
      // The editor holds the live buffer; applyEdit fires onChange so the tab
      // goes dirty and autosave picks it up.
      editorRef.current?.applyEdit(original, replacement);
    },
    [],
  );

  const patch = useCallback((path: string, p: Partial<OpenFile>) => {
    setFiles((prev) => {
      const next = prev.map((f) => (f.path === path ? { ...f, ...p } : f));
      filesRef.current = next;
      return next;
    });
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      // Show it in whichever group is focused (the split group, when active).
      if (activeGroupRef.current === 1) {
        setSecActive(path);
        setSecPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      } else {
        setActivePath(path);
      }
      if (filesRef.current.some((f) => f.path === path)) return;
      // Keep the open-tab count bounded: before opening a new one, evict the
      // oldest tab that's safe to close (not pinned, not unsaved).
      if (filesRef.current.length >= MAX_OPEN) {
        const victim = filesRef.current.find(
          (f) => f.path !== path && !pinnedRef.current.has(f.path) && f.saveState === "saved",
        );
        if (victim) closeTabRef.current(victim.path);
      }
      // A `jdt://…` URI is a library class reached via Go to Definition: its text
      // comes from the language server (decompiled or attached source), not disk.
      const isLibrary = path.includes("://");
      // Files outside the project (deps/std, via Go to Definition) open read-only.
      const external = isLibrary || !project || !path.startsWith(project.path + "/");
      const entry: OpenFile = {
        path,
        name: isLibrary ? jdtDisplayName(path) : basename(path),
        content: "",
        saveState: "saved",
        loading: true,
        rev: 0,
        readOnly: external,
      };
      setFiles((prev) => {
        const next = [...prev, entry];
        filesRef.current = next;
        return next;
      });
      try {
        const text =
          isLibrary && project ? await lspClassFileContents(project.path, path) : await readFile(path);
        patch(path, { content: text, loading: false });
        if (!isLibrary) syncLsp(path, text); // library buffers aren't tracked as files
      } catch (e) {
        console.error(e);
        patch(path, { content: `// failed to open: ${e}`, loading: false, saveState: "error" });
      }
    },
    [patch, syncLsp, project],
  );
  openFileRef.current = (p: string) => void openFile(p);

  // Collaborative agent editing: follow the agent to the file it edits, and while
  // it runs, poll open files and stream disk changes into the editors in place.
  useEffect(() => {
    const un = listen<string>("ai:agent-edit", (e) => {
      setAgentEditPath(e.payload);
      openFileRef.current(e.payload);
    });
    return () => void un.then((off) => off());
  }, []);
  useEffect(() => {
    if (!agentActive) {
      setAgentEditPath(null);
      return;
    }
    const tick = async () => {
      for (const f of filesRef.current) {
        if (f.kind === "diff" || f.readOnly) continue;
        let text: string;
        try {
          text = await readFile(f.path);
        } catch {
          continue;
        }
        if (text === f.content) continue;
        const shown = f.path === activeRef.current || f.path === secActiveRef.current;
        setFiles((prev) => {
          const arr = prev.map((x) => (x.path === f.path ? { ...x, content: text, saveState: "saved" as const, rev: shown ? x.rev : x.rev + 1 } : x));
          filesRef.current = arr;
          return arr;
        });
        if (f.path === activeRef.current) editorRef.current?.updateContentLive(text);
        if (f.path === secActiveRef.current) editorRef2.current?.updateContentLive(text);
        syncLsp(f.path, text);
      }
    };
    const id = window.setInterval(() => void tick(), 600);
    return () => window.clearInterval(id);
  }, [agentActive, syncLsp]);

  /** Open a commit's diff for one file as a read-only editor tab (dedup by key). */
  const openDiff = useCallback(
    async (hash: string, relPath: string) => {
      if (!project) return;
      const key = `diff:${hash}:${relPath}`;
      setActivePath(key);
      if (filesRef.current.some((f) => f.path === key)) return;
      const entry: OpenFile = {
        path: key,
        name: `${basename(relPath)} · ${hash.slice(0, 7)}`,
        content: "",
        saveState: "saved",
        loading: true,
        rev: 0,
        readOnly: true,
        kind: "diff",
      };
      setFiles((prev) => {
        const next = [...prev, entry];
        filesRef.current = next;
        return next;
      });
      try {
        const text = await gitFileDiff(project.path, hash, relPath);
        patch(key, { content: text, loading: false });
      } catch (e) {
        patch(key, { content: `Failed to load diff:\n${e}`, loading: false });
      }
    },
    [project, patch],
  );

  /** Open the working-tree diff for one file as a diff tab (re-fetched each time,
   *  since the working tree is live). */
  const openWorkingDiff = useCallback(
    async (relPath: string) => {
      if (!project) return;
      const key = `wdiff:${relPath}`;
      setActivePath(key);
      if (!filesRef.current.some((f) => f.path === key)) {
        const entry: OpenFile = {
          path: key,
          name: `${basename(relPath)} · working`,
          content: "",
          saveState: "saved",
          loading: true,
          rev: 0,
          readOnly: true,
          kind: "diff",
        };
        setFiles((prev) => {
          const next = [...prev, entry];
          filesRef.current = next;
          return next;
        });
      } else {
        patch(key, { loading: true });
      }
      try {
        const text = await gitWorkingDiff(project.path, relPath);
        patch(key, { content: text, loading: false });
      } catch (e) {
        patch(key, { content: `Failed to load diff:\n${e}`, loading: false });
      }
    },
    [project, patch],
  );

  /** Save immediately (⌘S and before a cargo run). */
  const saveNow = useCallback(
    async (path: string) => {
      const f = filesRef.current.find((x) => x.path === path);
      if (!f || f.saveState === "saved") return;
      const timer = saveTimers.current.get(path);
      if (timer) {
        clearTimeout(timer);
        saveTimers.current.delete(path);
      }
      patch(path, { saveState: "saving" });
      try {
        let content = f.content;
        // Actions on save (Java files, opt-in): organize imports, then reformat.
        if (project && !f.readOnly && path.endsWith(".java")) {
          const sa = loadSaveActions();
          if (sa.organizeImports || sa.format) {
            try {
              let next = content;
              if (sa.organizeImports) next = await organizeImports(project.path, path, next);
              if (sa.format) next = await formatJava(next, project.path, path);
              if (next && next !== content) {
                content = next;
                if (path === activeRef.current) editorRef.current?.setDoc(content);
                if (path === secActiveRef.current) editorRef2.current?.setDoc(content);
                patch(path, { content });
              }
            } catch (e) {
              setLines((prev) => [...prev.slice(-4000), { stream: "stderr", text: `Save actions: ${e}` }]);
            }
          }
        }
        await writeFile(path, content);
        patch(path, { saveState: "saved" });
        if (project && path.endsWith(".java")) lspDidSave(project.path, path, content).catch(() => {});
      } catch (e) {
        console.error(e);
        patch(path, { saveState: "error" });
      }
    },
    [patch, project],
  );

  // Move `path` to the head of the edit trail and park the cursor there.
  const recordEdit = useCallback((path: string) => {
    const prev = editTrailRef.current;
    const next = prev[prev.length - 1] === path ? prev : [...prev.filter((p) => p !== path), path];
    if (next !== prev) {
      editTrailRef.current = next;
      setEditTrail(next);
    }
    setTrailPos(next.length - 1);
  }, []);

  // Step through recently changed editors: dir -1 = older, +1 = newer.
  const goHistory = useCallback(
    (dir: -1 | 1) => {
      setTrailPos((pos) => {
        const trail = editTrailRef.current;
        const nextPos = pos + dir;
        if (nextPos < 0 || nextPos >= trail.length) return pos;
        const path = trail[nextPos];
        if (filesRef.current.some((f) => f.path === path)) setActivePath(path);
        else void openFile(path); // reopen a closed editor we changed earlier
        return nextPos;
      });
    },
    [openFile],
  );

  const onEdit = useCallback(
    (path: string, text: string) => {
      patch(path, { content: text, saveState: "dirty" });
      recordEdit(path);
      const timers = saveTimers.current;
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      timers.set(path, setTimeout(() => {
        void saveNow(path);
        syncLsp(path, text);
      }, 700));
    },
    [patch, saveNow, syncLsp, recordEdit],
  );

  const pinnedRef = useRef<Set<string>>(new Set());
  pinnedRef.current = pinned;
  const togglePin = useCallback((path: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const closeTab = useCallback((path: string) => {
    if (pinnedRef.current.has(path)) return; // pinned tabs stay until unpinned
    void saveNow(path);
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      const next = prev.filter((f) => f.path !== path);
      filesRef.current = next;
      setActivePath((cur) =>
        cur !== path ? cur : next.length === 0 ? null : (next[idx] ?? next[next.length - 1]).path,
      );
      return next;
    });
    closeSecTabs([path]); // the buffer is gone — drop it from the split group too
  }, [saveNow, closeSecTabs]);
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  // Close a set of tabs at once (Close Others / Close All / Close to the Right / …).
  // Pinned tabs are always kept.
  const closeTabs = useCallback((paths: string[]) => {
    const targets = paths.filter((p) => !pinnedRef.current.has(p));
    if (targets.length === 0) return;
    const set = new Set(targets);
    targets.forEach((p) => void saveNow(p));
    setFiles((prev) => {
      const next = prev.filter((f) => !set.has(f.path));
      filesRef.current = next;
      setActivePath((cur) => (cur && set.has(cur) ? (next[next.length - 1]?.path ?? null) : cur));
      return next;
    });
    closeSecTabs(targets);
  }, [saveNow, closeSecTabs]);

  // --- Cargo ---------------------------------------------------------------

  useEffect(() => {
    const un = listen<CargoEvent>("cargo:event", (e) => {
      const ev = e.payload;
      if (ev.type === "line") {
        setLines((prev) => [...prev.slice(-4000), { stream: ev.stream, text: ev.text }]);
      } else if (ev.type === "diagnostic") {
        setDiagnostics((prev) => [...prev, ev.diagnostic]);
      } else if (ev.type === "finished") {
        setRunning(false);
        setLastResult({ code: ev.code, secs: ev.secs });
        // A build may have changed generated files.
        qc.invalidateQueries({ queryKey: ["tree", project?.path] });
      }
    });
    return () => {
      un.then((off) => off());
    };
  }, [qc, project?.path]);

  const runCargo = useCallback(
    async (cmd: CargoCommand, extra: string[] = [], env: Record<string, string> = {}) => {
      if (!project) return;
      // Compiling a stale buffer is confusing — flush every dirty file first.
      await Promise.all(filesRef.current.filter((f) => f.saveState !== "saved").map((f) => saveNow(f.path)));
      setLines([]);
      setDiagnostics([]);
      setLastResult(null);
      setCommand(cmd);
      setRunning(true);
      setOutputHidden(false);
      try {
        await cargoRun(project.path, cmd, extra, env);
      } catch (e) {
        setLines((prev) => [...prev, { stream: "stderr", text: String(e) }]);
        setRunning(false);
      }
    },
    [project, saveNow],
  );

  /** Run raw Maven goals (from the Maven panel), streaming to the Output panel. */
  const runGoal = useCallback(
    async (goals: string[], env: Record<string, string> = {}) => {
      if (!project || goals.length === 0) return;
      await Promise.all(filesRef.current.filter((f) => f.saveState !== "saved").map((f) => saveNow(f.path)));
      setLines([]);
      setDiagnostics([]);
      setLastResult(null);
      setCommand(goals.join(" "));
      setRunning(true);
      setOutputHidden(false);
      setOutputTab("output");
      try {
        await runMavenGoals(project.path, goals, env);
      } catch (e) {
        setLines((prev) => [...prev, { stream: "stderr", text: String(e) }]);
        setRunning(false);
      }
    },
    [project, saveNow],
  );

  // Launch a Java application via the classpath route (build target/classes if
  // stale, then `java -cp … Main`), streaming like a build.
  const runJavaApp = useCallback(
    async (mainClass: string, args: string[], env: Record<string, string>) => {
      if (!project) return;
      await Promise.all(filesRef.current.filter((f) => f.saveState !== "saved").map((f) => saveNow(f.path)));
      setLines([]);
      setDiagnostics([]);
      setLastResult(null);
      setCommand("run");
      setRunning(true);
      setOutputHidden(false);
      try {
        await runJavaMain(project.path, mainClass, args, env);
      } catch (e) {
        setLines((prev) => [...prev, { stream: "stderr", text: String(e) }]);
        setRunning(false);
      }
    },
    [project, saveNow],
  );

  // Remote JVM Debug: attach the debugger to a JVM running the JDWP agent.
  const attachRemote = useCallback(
    async (c: RunConfig) => {
      if (!project) return;
      const port = parseInt(c.port ?? "", 10);
      setOutputHidden(false);
      setOutputTab("debugger");
      if (!port) {
        setDebugConsole(["Set the JDWP port on the Remote JVM Debug configuration."]);
        return;
      }
      if (!hasDebuggerRef.current) {
        setDebugConsole([
          "Debugger unavailable: the java-debug plugin isn't installed.",
          "Open the Debugger tab and click “Install java-debug”, then reopen the project.",
        ]);
        return;
      }
      const host = c.host?.trim() || "localhost";
      setDebugConsole([`Attaching to ${host}:${port}…`]);
      setDebugStatus("building");
      try {
        await debugAttach(project.path, host, port, toSourceMap(breakpointsRef.current));
        setDebugStatus("running");
        setDebugConsole((p) => [...p, `Attached to ${host}:${port}.`]);
      } catch (e) {
        setDebugConsole((p) => [...p, String(e)]);
        setDebugStatus("idle");
      }
    },
    [project],
  );

  /** Run any run configuration — routing by type (goals vs run/test). */
  const runConfig = useCallback(
    (c: RunConfig) => {
      // Remote debug has nothing to "run" — Run and Debug both attach.
      if (c.type === "remote") {
        void attachRemote(c);
        return;
      }
      setOutputTab("output");
      // Java Application: resolve target/classes + deps and launch java directly
      // (robust vs. exec:java). Empty main class uses the project's default.
      if (c.type === "application") {
        const main = c.mainClass?.trim() || info?.bins?.[0];
        if (main) {
          void runJavaApp(main, c.args, c.env);
          return;
        }
      }
      // Spring Boot launches through the build plugin: `mvn spring-boot:run` or
      // `gradle bootRun` (the backend picks the tool). Program args + the target
      // main class are passed the way each plugin expects.
      if (c.type === "spring") {
        const progArgs = c.args.join(" ");
        const goals: string[] =
          buildTool === "gradle"
            ? ["bootRun", ...(c.args.length ? [`--args=${progArgs}`] : [])]
            : [
                "spring-boot:run",
                ...(c.mainClass?.trim() ? [`-Dspring-boot.run.mainClass=${c.mainClass.trim()}`] : []),
                ...(c.args.length ? [`-Dspring-boot.run.arguments=${progArgs}`] : []),
              ];
        void runGoal(goals, c.env);
        return;
      }
      if (isGoalConfig(c)) {
        void runGoal(goalsFor(c), c.env);
      } else {
        const { command, extra, env } = toCargo(c);
        void runCargo(command, extra, env);
      }
    },
    [runCargo, runGoal, runJavaApp, attachRemote, buildTool, info?.bins],
  );

  /** Run the currently-selected run configuration. */
  const runSelectedConfig = useCallback(() => {
    if (selectedConfig) runConfig(selectedConfig);
  }, [selectedConfig, runConfig]);

  /** Click a ▶ gutter marker: create (or reuse) a run config named after the
   *  symbol, select it, and run it — IntelliJ style. */
  const runSymbol = useCallback(
    (run: Runnable, _filePath: string) => {
      if (!project) return;
      // `run.name` is the class (main) or the test class/method the gutter detected.
      const cfg: RunConfig =
        run.kind === "test"
          ? { id: newId(), name: run.name, type: "junit", testTarget: run.name, args: [], env: {} }
          : { id: newId(), name: run.name, type: "application", mainClass: run.name, args: [], env: {} };

      // Reuse an identical existing config so repeated clicks don't pile up.
      const existing = runConfigs.find((c) =>
        c.type === cfg.type && c.name === cfg.name && (cfg.type === "junit" ? c.testTarget === cfg.testTarget : c.mainClass === cfg.mainClass),
      );
      const chosen = existing ?? cfg;
      if (!existing) persistConfigs([...runConfigs, cfg]);
      selectConfig(chosen.id);
      runConfig(chosen);
    },
    [project, runConfigs, persistConfigs, selectConfig, runConfig],
  );

  /** Diagnostics carry project-relative paths; resolve then jump. */
  const jumpTo = useCallback(
    async (file: string, line: number, column: number) => {
      if (!project) return;
      // Absolute paths and scheme URIs (jdt:// library classes) pass through;
      // bare paths are resolved against the project root.
      const abs = file.startsWith("/") || file.includes("://") ? file : `${project.path}/${file}`;
      await openFile(abs);
      // Let the editor mount for a newly opened file before moving the cursor.
      setTimeout(() => activeEditor()?.goTo(line, column), 60);
    },
    [project, openFile],
  );

  // Infer a Java package from a directory's path: the segment chain after a
  // `src/main/java` or `src/test/java` source root (empty = default package).
  const packageForDir = useCallback((dir: string): string => {
    const norm = dir.replace(/\\/g, "/");
    for (const root of ["/src/main/java/", "/src/test/java/"]) {
      const i = norm.indexOf(root);
      if (i >= 0) return norm.slice(i + root.length).replace(/\/+$/, "").replace(/\//g, ".");
    }
    // A directory that *is* the source root → default package.
    if (norm.endsWith("/src/main/java") || norm.endsWith("/src/test/java")) return "";
    return "";
  }, []);

  // Create a file/class/dir from the file-tree context menu, then refresh + open.
  const createInTree = useCallback(
    async (dir: string, rawName: string, kind: NewKind) => {
      const name = rawName.trim();
      const refresh = () => qc.invalidateQueries({ queryKey: ["tree", project?.path] });
      if (kind === "dir") {
        await createDir(dir, name);
        await refresh();
        return;
      }
      if (kind === "java") {
        // A Java class: <ClassName>.java, seeded with a package line inferred
        // from the target directory's position under src/main|test/java.
        const className = name.replace(/\.java$/, "");
        const pkg = packageForDir(dir);
        const created = await createFile(dir, `${className}.java`);
        const header = pkg ? `package ${pkg};\n\n` : "";
        await writeFile(created, `${header}public class ${className} {\n}\n`);
        await refresh();
        void openFile(created);
        return;
      }
      const created = await createFile(dir, name);
      await refresh();
      void openFile(created);
    },
    [qc, project?.path, openFile, packageForDir],
  );

  // Delete files/dirs from the tree: remove on disk, close affected tabs, refresh.
  const deleteInTree = useCallback(
    async (paths: string[]) => {
      for (const p of paths) {
        await deletePath(p);
      }
      // Close any open editors for a deleted file (or a file inside a deleted dir).
      for (const f of filesRef.current) {
        if (paths.some((p) => f.path === p || f.path.startsWith(p + "/"))) closeTab(f.path);
      }
      await qc.invalidateQueries({ queryKey: ["tree", project?.path] });
      qc.invalidateQueries({ queryKey: ["modules", project?.path] });
    },
    [qc, project?.path, closeTab],
  );

  // Perform a move: move each path into `dir`, remap any open tabs whose paths
  // changed, refresh the tree. Returns {from,to} pairs (for undo). Does NOT
  // record undo itself, so it can be reused to undo a move.
  const doMove = useCallback(
    async (paths: string[], dir: string): Promise<{ from: string; to: string }[]> => {
      const news = await movePaths(paths, dir);
      const map = new Map<string, string>();
      paths.forEach((p, i) => { if (news[i]) map.set(p, news[i]); });
      const remap = (fp: string): string | null => {
        for (const [oldP, newP] of map) {
          if (fp === oldP) return newP;
          if (fp.startsWith(oldP + "/")) return newP + fp.slice(oldP.length);
        }
        return null;
      };
      setFiles((prev) => {
        const next = prev.map((f) => {
          const np = remap(f.path);
          return np ? { ...f, path: np, name: basename(np) } : f;
        });
        filesRef.current = next;
        return next;
      });
      setActivePath((p) => (p ? remap(p) ?? p : p));
      setSecActive((p) => (p ? remap(p) ?? p : p));
      await qc.invalidateQueries({ queryKey: ["tree", project?.path] });
      qc.invalidateQueries({ queryKey: ["modules", project?.path] });
      return paths.map((p, i) => ({ from: p, to: news[i] })).filter((x) => x.to);
    },
    [qc, project?.path],
  );

  // Undo stack for file-tree operations (move / copy). Reversed with ⌘Z when the
  // explorer is focused.
  const treeUndo = useRef<({ type: "move"; pairs: { from: string; to: string }[] } | { type: "copy"; created: string[] })[]>([]);

  const moveInTree = useCallback(
    async (paths: string[], dir: string) => {
      const pairs = await doMove(paths, dir);
      if (pairs.length) treeUndo.current.push({ type: "move", pairs });
    },
    [doMove],
  );

  const copyInTree = useCallback(
    async (paths: string[], dir: string) => {
      const created = await copyPaths(paths, dir);
      if (created.length) treeUndo.current.push({ type: "copy", created });
      await qc.invalidateQueries({ queryKey: ["tree", project?.path] });
      qc.invalidateQueries({ queryKey: ["modules", project?.path] });
    },
    [qc, project?.path],
  );

  // Undo the most recent tree operation: move files back to where they came
  // from, or delete the copies a paste created.
  const undoTree = useCallback(async () => {
    const entry = treeUndo.current.pop();
    if (!entry) return;
    try {
      if (entry.type === "copy") {
        for (const p of entry.created) await deletePath(p);
        for (const f of filesRef.current) {
          if (entry.created.some((p) => f.path === p || f.path.startsWith(p + "/"))) closeTab(f.path);
        }
        await qc.invalidateQueries({ queryKey: ["tree", project?.path] });
        qc.invalidateQueries({ queryKey: ["modules", project?.path] });
      } else {
        // Group by each item's original parent directory, then move back.
        const groups = new Map<string, string[]>();
        for (const { from, to } of entry.pairs) {
          const origDir = from.slice(0, from.lastIndexOf("/"));
          const list = groups.get(origDir) ?? [];
          list.push(to);
          groups.set(origDir, list);
        }
        for (const [origDir, tos] of groups) await doMove(tos, origDir);
      }
    } catch (e) {
      alert(String(e));
    }
  }, [qc, project?.path, closeTab, doMove]);

  // Reformat the active Java file in place with the selected code style.
  const reformatActive = useCallback(async () => {
    const path = activeGroupRef.current === 1 ? secActiveRef.current : activeRef.current;
    const f = filesRef.current.find((x) => x.path === path);
    if (!f || f.loading || f.readOnly || !f.path.endsWith(".java")) return;
    try {
      const formatted = await formatJava(f.content, projectRef.current ?? undefined, f.path);
      if (formatted && formatted !== f.content) activeEditor()?.setDoc(formatted);
    } catch (e) {
      setLines((prev) => [...prev.slice(-4000), { stream: "stderr", text: `Formatter: ${e}` }]);
      setOutputHidden(false);
      setOutputTab("output");
    }
  }, []);

  // rust-analyzer diagnostics as project-wide problems. Unlike cargo-run output,
  // these are republished on startup, so the Problems list / tree dots come back
  // after a restart once the project is re-indexed.
  const lspProblems = useMemo<Diagnostic[]>(() => {
    const out: Diagnostic[] = [];
    for (const [path, diags] of Object.entries(lspDiag)) {
      for (const d of diags) {
        if (d.severity !== 1 && d.severity !== 2) continue; // errors + warnings only
        out.push({
          level: d.severity === 1 ? "error" : "warning",
          message: d.message,
          file: path,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          code: d.code == null ? null : typeof d.code === "object" ? d.code.value : String(d.code),
          rendered: null,
        });
      }
    }
    return out;
  }, [lspDiag]);

  // Problems list = cargo output (rich, has rendered spans) + rust-analyzer
  // (live, survives restart), deduped by absolute file + line + message.
  const allProblems = useMemo<Diagnostic[]>(() => {
    const abs = (f: string | null) => (f == null ? "" : f.startsWith("/") ? f : `${project?.path}/${f}`);
    const seen = new Set<string>();
    const merged: Diagnostic[] = [];
    for (const d of [...diagnostics, ...lspProblems]) {
      const key = `${abs(d.file)}|${d.line}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
    merged.sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));
    return merged;
  }, [diagnostics, lspProblems, project?.path]);

  const problemPaths = useMemo(() => {
    const set = new Set<string>();
    if (!project) return set;
    for (const d of allProblems) {
      // Only errors get a red dot; warnings don't.
      if (d.file && d.level === "error") set.add(d.file.startsWith("/") ? d.file : `${project.path}/${d.file}`);
    }
    return set;
  }, [allProblems, project]);

  // Index of every project file for resolving references the AI cites (which may
  // be a bare filename like `io.rs`, not a full `src/io.rs`).
  const fileIndex = useMemo(() => {
    const rels: string[] = [];
    const base = project?.path;
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "file") {
          rels.push(base && n.path.startsWith(base + "/") ? n.path.slice(base.length + 1) : n.path);
        } else if (n.children) {
          walk(n.children);
        }
      }
    };
    if (tree) walk(tree);
    return rels;
  }, [tree, project?.path]);

  /** Resolve an AI-cited path/filename to a real absolute file path, or null. */
  const resolveRef = useCallback(
    (cited: string): string | null => {
      if (!project) return null;
      const c = cited.replace(/^\.?\//, "").trim();
      if (!c) return null;
      const exact = fileIndex.find((r) => r === c);
      if (exact) return `${project.path}/${exact}`;
      // Longest-suffix / basename match; prefer the shortest resulting path.
      const cand = fileIndex
        .filter((r) => r === c || r.endsWith("/" + c) || r.split("/").pop() === c.split("/").pop())
        .sort((a, b) => a.length - b.length)[0];
      return cand ? `${project.path}/${cand}` : null;
    },
    [project, fileIndex],
  );

  // Show the launcher to pick/open another project.
  const openLauncher = useCallback(() => setProject(null), []);

  // Switch to a project, clearing state that belonged to the previous one.
  const chooseProject = useCallback(
    (p: ProjectRef) => {
      setProject((prev) => {
        if (prev?.path !== p.path) {
          setFiles([]);
          filesRef.current = [];
          setActivePath(null);
          setLines([]);
          setDiagnostics([]);
          setLspDiag({});
          setEditTrail([]);
          setTrailPos(-1);
          setLastResult(null);
        }
        return p;
      });
    },
    [],
  );

  // Open the project this window was launched with (fresh window → no reset needed).
  useEffect(() => {
    if (!openParam) return;
    let alive = true;
    (async () => {
      try {
        const list = await addProject(openParam);
        const p = list.find((x) => x.path === openParam) ?? list[0];
        if (alive && p) setProject(p);
      } catch {
        /* fall through to the launcher */
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [openParam]);

  // --- Project switcher dropdown ----------------------------------------------

  const [switcherOpen, setSwitcherOpen] = useState(false);
  // A project the user picked to switch to, awaiting "replace vs new window".
  const [pendingSwitch, setPendingSwitch] = useState<ProjectRef | null>(null);
  const { data: recentProjects } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: switcherOpen,
  });

  const pickProject = useCallback(
    (p: ProjectRef) => {
      setSwitcherOpen(false);
      if (p.path === project?.path) return;
      setPendingSwitch(p);
    },
    [project],
  );

  // --- Debugger ---------------------------------------------------------------

  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;

  // Default the debug target to the first binary once project info loads.
  useEffect(() => {
    if (info?.bins?.length && debugTarget.kind === "bin" && !debugTarget.name) {
      setDebugTarget({ kind: "bin", name: info.bins[0] });
    }
  }, [info, debugTarget]);

  // React to adapter events: stops, output, and termination.
  useEffect(() => {
    const un = listen<{ event: string; body: Record<string, unknown> }>("dap:event", async (e) => {
      const { event, body } = e.payload;
      if (event === "stopped") {
        const tid = (body?.threadId as number) ?? threadIdRef.current ?? 0;
        setThreadId(tid);
        setDebugStatus("paused");
        const fr = await debugStack(tid).catch(() => [] as StackFrame[]);
        setFrames(fr);
        const top = fr.find((f) => f.path) ?? fr[0];
        if (top) {
          setSelectedFrame(top.id);
          if (top.path) {
            setStopPos({ path: top.path, line: top.line });
            void jumpToRef.current(top.path, top.line, top.column || 1);
          }
        }
      } else if (event === "continued") {
        setDebugStatus("running");
        setStopPos(null);
      } else if (event === "output") {
        const text = (body?.output as string) ?? "";
        if (text) setDebugConsole((prev) => [...prev.slice(-4000), text.replace(/\n$/, "")]);
      } else if (event === "terminated" || event === "exited") {
        setDebugStatus("exited");
        setStopPos(null);
        setThreadId(null);
        setFrames([]);
        setSelectedFrame(null);
      }
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Replace one file's breakpoint list: persist it and push to a live session.
  const setFileBreakpoints = useCallback((path: string, next: Breakpoint[]) => {
    setBreakpoints((prev) => {
      const map = { ...prev, [path]: next };
      if (!next.length) delete map[path];
      if (projectRef.current) saveBreakpoints(projectRef.current, map);
      void debugSetBreakpoints(path, toSourceBreakpoints(next)).catch(() => {}); // no-op unless debugging
      return map;
    });
  }, []);

  // Gutter click: add an (enabled, unconditional) breakpoint, or remove it.
  const toggleBreakpoint = useCallback(
    (line: number) => {
      const path = activeRef.current;
      if (!path) return;
      const cur = breakpointsRef.current[path] ?? [];
      const next = cur.some((b) => b.line === line)
        ? cur.filter((b) => b.line !== line)
        : [...cur, { line, enabled: true }].sort((a, b) => a.line - b.line);
      setFileBreakpoints(path, next);
    },
    [setFileBreakpoints],
  );

  // --- Breakpoints panel operations ------------------------------------------
  const patchBreakpoint = useCallback(
    (path: string, line: number, p: Partial<Breakpoint>) => {
      const cur = breakpointsRef.current[path] ?? [];
      setFileBreakpoints(path, cur.map((b) => (b.line === line ? { ...b, ...p } : b)));
    },
    [setFileBreakpoints],
  );
  const removeBreakpoint = useCallback(
    (path: string, line: number) => {
      const cur = breakpointsRef.current[path] ?? [];
      setFileBreakpoints(path, cur.filter((b) => b.line !== line));
    },
    [setFileBreakpoints],
  );
  const removeAllBreakpoints = useCallback(() => {
    const map = breakpointsRef.current;
    for (const path of Object.keys(map)) void debugSetBreakpoints(path, []).catch(() => {});
    setBreakpoints({});
    if (projectRef.current) saveBreakpoints(projectRef.current, {});
  }, []);
  const setAllBreakpointsEnabled = useCallback((enabled: boolean) => {
    const map = breakpointsRef.current;
    const next: BreakpointMap = {};
    for (const [path, list] of Object.entries(map)) {
      next[path] = list.map((b) => ({ ...b, enabled }));
      void debugSetBreakpoints(path, toSourceBreakpoints(next[path])).catch(() => {});
    }
    setBreakpoints(next);
    if (projectRef.current) saveBreakpoints(projectRef.current, next);
  }, []);

  // Build + launch a fresh debug session for an explicit target.
  const launchDebug = useCallback(async (target: { kind: "bin" | "test"; name: string | null }) => {
    if (!project) return;
    if (!hasDebuggerRef.current) {
      setOutputHidden(false);
      setOutputTab("debugger");
      setDebugConsole([
        "Debugger unavailable: the java-debug plugin isn't installed.",
        "Open the Debugger tab and click “Install java-debug”, then reopen the project.",
      ]);
      return;
    }
    if (debugStatusRef.current === "building" || debugStatusRef.current === "running") return;
    // Flush dirty buffers so we debug what's on disk.
    await Promise.all(filesRef.current.filter((f) => f.saveState !== "saved").map((f) => saveNow(f.path)));
    setDebugConsole([]);
    setDebugStatus("building");
    setLines([]);
    setDiagnostics([]);
    setOutputHidden(false);
    setOutputTab("debugger");
    try {
      await debugStart(project.path, target.kind, target.name, [], toSourceMap(breakpointsRef.current));
      setDebugStatus("running");
    } catch (e) {
      setDebugConsole((p) => [...p, String(e)]);
      setDebugStatus("idle");
    }
  }, [project, saveNow]);

  const startOrContinue = useCallback(async () => {
    if (!project) return;
    // F5 while paused → continue.
    if (debugStatusRef.current === "paused" && threadIdRef.current != null) {
      setDebugStatus("running");
      setStopPos(null);
      await debugContinue(threadIdRef.current).catch((e) => setDebugConsole((p) => [...p, String(e)]));
      return;
    }
    await launchDebug(debugTarget);
  }, [project, debugTarget, launchDebug]);

  // Debug the *selected run configuration* (Run and Debug share it), or Continue
  // when already paused.
  const debugSelectedConfig = useCallback(async () => {
    if (!project) return;
    if (debugStatusRef.current === "paused" && threadIdRef.current != null) {
      setDebugStatus("running");
      setStopPos(null);
      await debugContinue(threadIdRef.current).catch((e) => setDebugConsole((p) => [...p, String(e)]));
      return;
    }
    if (!selectedConfig) return;
    // Remote JVM Debug: attach instead of launching.
    if (selectedConfig.type === "remote") {
      await attachRemote(selectedConfig);
      return;
    }
    // Java Application and Spring Boot configs launch under the debugger (both
    // run a main class).
    if (selectedConfig.type !== "application" && selectedConfig.type !== "spring") {
      setOutputHidden(false);
      setOutputTab("debugger");
      setDebugConsole([`Debugging isn't supported for a ${selectedConfig.type} configuration — use a Java Application or Spring Boot configuration.`]);
      return;
    }
    const target: { kind: "bin" | "test"; name: string | null } = {
      kind: "bin",
      name: selectedConfig.mainClass?.trim() || info?.bins?.[0] || null,
    };
    setDebugTarget(target);
    await launchDebug(target);
  }, [project, selectedConfig, info, launchDebug, attachRemote]);

  // Debug a specific gutter runnable (a main class; tests aren't debuggable yet).
  const debugSymbol = useCallback((run: Runnable) => {
    const target = { kind: (run.kind === "test" ? "test" : "bin") as "bin" | "test", name: run.name };
    setDebugTarget(target);
    void launchDebug(target);
  }, [launchDebug]);

  const stepOver = useCallback(() => {
    if (threadIdRef.current != null) void debugNext(threadIdRef.current).catch(() => {});
  }, []);
  const stepInto = useCallback(() => {
    if (threadIdRef.current != null) void debugStepIn(threadIdRef.current).catch(() => {});
  }, []);
  const stepOut = useCallback(() => {
    if (threadIdRef.current != null) void debugStepOut(threadIdRef.current).catch(() => {});
  }, []);
  const stopDebug = useCallback(async () => {
    await debugStop().catch(() => {});
    setDebugStatus("idle");
    setStopPos(null);
    setThreadId(null);
    setFrames([]);
    setSelectedFrame(null);
  }, []);

  const selectFrame = useCallback((f: StackFrame) => {
    setSelectedFrame(f.id);
    if (f.path) {
      setStopPos({ path: f.path, line: f.line });
      void jumpToRef.current(f.path, f.line, f.column || 1);
    }
  }, []);

  const evalExpr = useCallback((expr: string) => {
    const fid = selectedFrameRef.current;
    if (fid == null) return;
    setDebugConsole((p) => [...p, `> ${expr}`]);
    debugEval(fid, expr)
      .then((r) => setDebugConsole((p) => [...p, r.result]))
      .catch((e) => setDebugConsole((p) => [...p, String(e)]));
  }, []);

  // --- Commands (shared by the palette and the native menu) -----------------

  const commands: Command[] = useMemo(() => {
    const noProject = "Open a project first";
    const foldDisabled = !focusedFile || focusedFile.kind === "diff";
    const bpCount = Object.values(breakpoints).reduce((n, l) => n + l.length, 0);
    const bpAnyEnabled = Object.values(breakpoints).some((l) => l.some((b) => b.enabled));
    const list: Command[] = [
      { id: "cargo.build", group: "Build", title: "Build", hint: "⌘B", disabled: !project, disabledReason: noProject, run: () => void runCargo("build") },
      { id: "cargo.run", group: "Run", title: selectedConfig ? `Run '${selectedConfig.name}'` : "Run", hint: "⌘R", disabled: !project || !selectedConfig, disabledReason: noProject, run: () => runSelectedConfig() },
      { id: "run.edit", group: "Run", title: "Edit Run Configurations…", disabled: !project, disabledReason: noProject, run: () => setEditingConfigs(true) },
      { id: "app.settings", group: "View", title: "Settings…", hint: "⌘,", run: () => setShowSettings(true) },
      { id: "project.settings", group: "View", title: "Project Settings…", disabled: !project, disabledReason: noProject, run: () => setStructureOpen(true) },
      { id: "view.taskboard", group: "View", title: "Task Board…", disabled: !project, disabledReason: noProject, run: () => setShowBoard(true) },
      { id: "cargo.test", group: "Build", title: "Test (all)", hint: "⌘U", disabled: !project, disabledReason: noProject, run: () => void runCargo("test") },
      { id: "cargo.clippy", group: "Build", title: "Check", hint: "⌘L", disabled: !project, disabledReason: noProject, run: () => void runCargo("clippy") },
      { id: "cargo.check", group: "Code", title: "Code Analysis", hint: "⌘⇧B", disabled: !project, disabledReason: noProject, run: () => void runCargo("check") },
      { id: "code.reformat", group: "Code", title: "Reformat Code", hint: "⌘⌥L", disabled: !active || active.readOnly || !active.path.endsWith(".java"), disabledReason: "Open a Java file", run: () => void reformatActive() },
      { id: "cargo.fmt", group: "Build", title: "Format project", hint: "⌘⇧F", disabled: !project, disabledReason: noProject, run: () => void runCargo("fmt") },
      { id: "cargo.cancel", group: "Build", title: "Stop", hint: "⌘.", disabled: !running, disabledReason: "Nothing is running", run: () => void cargoCancel() },
      { id: "debug.start", group: "Debug", title: debugStatus === "paused" ? "Continue" : "Start Debugging", hint: "F5", disabled: !project, disabledReason: noProject, run: () => void debugSelectedConfig() },
      { id: "debug.step-over", group: "Debug", title: "Step Over", hint: "F10", disabled: debugStatus !== "paused", disabledReason: "Not paused", run: stepOver },
      { id: "debug.step-into", group: "Debug", title: "Step Into", hint: "F11", disabled: debugStatus !== "paused", disabledReason: "Not paused", run: stepInto },
      { id: "debug.step-out", group: "Debug", title: "Step Out", hint: "⇧F11", disabled: debugStatus !== "paused", disabledReason: "Not paused", run: stepOut },
      { id: "debug.stop", group: "Debug", title: "Stop Debugging", hint: "⇧F5", disabled: debugStatus === "idle", disabledReason: "Not debugging", run: () => void stopDebug() },
      { id: "debug.toggle-breakpoint", group: "Debug", title: "Toggle Breakpoint", hint: "⌘F8", disabled: !focusedFile || !focusedFile.path.endsWith(".java"), disabledReason: "Open a Java file", run: () => focusedFile && toggleBreakpoint(cursor.line) },
      { id: "debug.view-breakpoints", group: "Debug", title: "View Breakpoints", disabled: !project, disabledReason: noProject, run: () => { setOutputHidden(false); setOutputTab("breakpoints"); } },
      { id: "debug.toggle-all-breakpoints", group: "Debug", title: bpAnyEnabled ? "Disable All Breakpoints" : "Enable All Breakpoints", disabled: bpCount === 0, disabledReason: "No breakpoints", run: () => setAllBreakpointsEnabled(!bpAnyEnabled) },
      { id: "debug.remove-all-breakpoints", group: "Debug", title: "Remove All Breakpoints", disabled: bpCount === 0, disabledReason: "No breakpoints", run: () => removeAllBreakpoints() },
      { id: "code.goto-line", group: "Code", title: "Go to Line…", hint: "⌃G", disabled: !active, disabledReason: "Open a file", run: () => setGotoLine(true) },
      { id: "code.refactor", group: "Code", title: "Refactoring: Refactor This…", hint: "⌃T", disabled: !active || active.readOnly || !active.path.endsWith(".java"), disabledReason: "Open a Java file", run: () => activeEditor()?.openRefactor() },
      { id: "code.fold", group: "Code", title: "Fold at Cursor", hint: "⌘⌥[", disabled: foldDisabled, disabledReason: "Open a code file", run: () => activeEditor()?.foldAtCursor() },
      { id: "code.unfold", group: "Code", title: "Unfold at Cursor", hint: "⌘⌥]", disabled: foldDisabled, disabledReason: "Open a code file", run: () => activeEditor()?.unfoldAtCursor() },
      { id: "code.fold-all", group: "Code", title: "Fold All", disabled: foldDisabled, disabledReason: "Open a code file", run: () => activeEditor()?.foldAll() },
      { id: "code.unfold-all", group: "Code", title: "Unfold All", disabled: foldDisabled, disabledReason: "Open a code file", run: () => activeEditor()?.unfoldAll() },
      { id: "view.split-right", group: "View", title: "Split Right", disabled: !active, disabledReason: "No file open", run: () => splitEditor("row") },
      { id: "view.split-down", group: "View", title: "Split Down", disabled: !active, disabledReason: "No file open", run: () => splitEditor("col") },
      { id: "view.close-split", group: "View", title: "Close Split", disabled: !split, disabledReason: "No split", run: () => closeSecTabs(secPaths) },
      { id: "file.save", group: "File", title: "Save", hint: "⌘S", disabled: !active, disabledReason: "No file open", run: () => active && void saveNow(active.path) },
      { id: "file.close-tab", group: "File", title: "Close tab", hint: "⌘W", disabled: !active, disabledReason: "No file open", run: () => active && closeTab(active.path) },
      { id: "view.tree", group: "View", title: treeHidden ? "Show explorer" : "Hide explorer", hint: "⌘⌥1", run: () => setTreeHidden((v) => !v) },
      { id: "view.output", group: "View", title: outputHidden ? "Show output" : "Hide output", hint: "⌘⌥2", run: () => setOutputHidden((v) => !v) },
      { id: "view.ai", group: "View", title: rightPanel === "review" ? "Hide Intelligent Review" : "Intelligent Review", hint: "⌘⌥3", run: () => setRightPanel((p) => (p === "review" ? null : "review")) },
      { id: "view.chat", group: "View", title: rightPanel === "chat" ? "Hide AI Assistant" : "AI Assistant", hint: "⌘⌥4", run: () => setRightPanel((p) => (p === "chat" ? null : "chat")) },
      { id: "view.skills", group: "View", title: rightPanel === "skills" ? "Hide Skills" : "Skills", hint: "⌘⌥5", run: () => setRightPanel((p) => (p === "skills" ? null : "skills")) },
      { id: "ai.review", group: "AI", title: "Review file", hint: "⌘⇧A", disabled: !active, disabledReason: "No file open", run: () => { setRightPanel("review"); setTimeout(() => window.dispatchEvent(new Event("rustade:ai-review")), 40); } },
      { id: "ai.explain", group: "AI", title: "Explain selection / file", hint: "⌘⇧E", disabled: !active, disabledReason: "No file open", run: () => { setRightPanel("review"); setTimeout(() => window.dispatchEvent(new Event("rustade:ai-explain")), 40); } },
      { id: "project.open", group: "Project", title: "Open project…", hint: "⌘⇧O", run: openLauncher },
      { id: "view.quickopen", group: "Go to", title: "Go to file…", hint: "⌘P", run: () => setQuickOpen("files") },
      { id: "view.search", group: "Search", title: "Find in files…", hint: "⌘⇧F", disabled: !project, disabledReason: "Open a project first", run: () => setShowSearch(true) },
      { id: "view.palette", group: "View", title: "Command palette", hint: "⌘K", run: () => setShowPalette((v) => !v) },
    ];
    return list;
  }, [project, running, active, focusedFile, split, secPaths, splitEditor, closeSecTabs, treeHidden, outputHidden, rightPanel, runCargo, saveNow, closeTab, debugStatus, startOrContinue, debugSelectedConfig, stepOver, stepInto, stepOut, stopDebug, reformatActive, selectedConfig, runSelectedConfig, breakpoints, cursor, toggleBreakpoint, removeAllBreakpoints, setAllBreakpointsEnabled]);

  const commandsRef = useRef<Command[]>([]);
  commandsRef.current = commands;
  useEffect(() => {
    const un = listen<string>("menu:command", (e) => {
      const c = commandsRef.current.find((x) => x.id === e.payload);
      if (c && !c.disabled) c.run();
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // ⌘⇧P palette, ⌘⇧F find-in-files, plus command shortcuts (⌘⇧A review,
  // ⌘⇧B code analysis) that only appear as hints in the palette otherwise.
  useEffect(() => {
    const runCmd = (id: string) => {
      const c = commandsRef.current.find((x) => x.id === id);
      if (c && !c.disabled) c.run();
    };
    const h = (e: KeyboardEvent) => {
      // Go to Line — ⌃G (Ctrl+G), no other modifiers.
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGotoLine(true);
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "p") {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if (key === "f") {
        e.preventDefault();
        setShowSearch(true);
      } else if (key === "a") {
        e.preventDefault();
        runCmd("ai.review");
      } else if (key === "b") {
        e.preventDefault();
        runCmd("cargo.check");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!project) {
    if (booting) {
      return (
        <div className="flex h-screen items-center justify-center text-[13px] text-[var(--text-tertiary)]" data-tauri-drag-region>
          Opening project…
        </div>
      );
    }
    return (
      <>
        <ProjectLauncher onOpen={chooseProject} />
        {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      </>
    );
  }

  // Render one editor group's content (empty / loading / diff / markdown / code).
  // Shared by the primary group and the optional split group.
  const renderEditorArea = (f: OpenFile | null, edRef: React.RefObject<CodeEditorHandle | null>) => {
    if (!f) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <p className="text-[13px] text-[var(--text-secondary)]">No file open</p>
          <p className="text-[12px] text-[var(--text-tertiary)]">Pick a file from the explorer.</p>
        </div>
      );
    }
    if (f.loading) {
      return <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-tertiary)]">Loading…</div>;
    }
    if (f.kind === "diff") return <DiffView text={f.content} />;
    if (/\.(md|markdown)$/i.test(f.path)) {
      return (
        <MarkdownEditor
          key={`md:${f.path}#${f.rev}`}
          initial={f.content}
          basePath={f.path.slice(0, f.path.lastIndexOf("/"))}
          onChange={(text) => onEdit(f.path, text)}
          onSave={() => void saveNow(f.path)}
          onCursor={(line, col) => setCursor({ line, col })}
          readOnly={f.readOnly}
        />
      );
    }
    return (
      <CodeEditor
        ref={edRef}
        key={`${f.path}#${f.rev}`}
        path={f.path}
        root={project?.path ?? ""}
        initial={f.content}
        onChange={(text) => onEdit(f.path, text)}
        onSave={() => void saveNow(f.path)}
        onSelection={setSelection}
        diagnostics={lspDiag[f.path] ?? EMPTY_DIAG}
        readOnly={f.readOnly}
        onGoToDefinition={(p, l, c) => void jumpTo(p, l, c)}
        onCursor={(line, col) => setCursor({ line, col })}
        breakpoints={breakpoints[f.path] ?? EMPTY_BREAKPOINTS}
        onToggleBreakpoint={toggleBreakpoint}
        stopLine={stopPos && stopPos.path === f.path ? stopPos.line : null}
        onRunSymbol={(run, x, y, menu) => (menu ? setRunMenu({ run, path: f.path, x, y }) : runSymbol(run, f.path))}
        onFindUsages={showUsages}
        onRename={applyRename}
        onRefactorError={(msg) => window.alert(msg)}
        agentActive={agentActive}
        onStaged={() => {
          qc.invalidateQueries({ queryKey: ["git-status"] });
          qc.invalidateQueries({ queryKey: ["git-log"] });
        }}
        onExplainDiagnostic={(message, snippet) => {
          setRightPanel("chat");
          const prompt = `Explain this Java diagnostic and how to fix it:\n\n> ${message}\n\n\`\`\`java\n${snippet}\n\`\`\``;
          setTimeout(() => window.dispatchEvent(new CustomEvent("rustade:vibe-ask", { detail: prompt })), 60);
        }}
      />
    );
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Title bar: traffic-light space + project identity + cargo actions */}
      <header className="relative flex h-11 shrink-0 items-center gap-3 pl-[86px] pr-3" data-tauri-drag-region>
        {/* Project switcher — click for a dropdown of recent projects. */}
        <div className="relative -ml-1">
          <button
            onClick={() => setSwitcherOpen((v) => !v)}
            title="Switch project"
            className="project-switch flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1"
          >
            <FolderIcon />
            <span className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
              {info?.name ?? project.name}
            </span>
            {info?.version && <span className="shrink-0 text-[12.5px] font-normal text-[var(--text-tertiary)]">v{info.version}</span>}
            {info?.is_workspace && (
              <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                workspace
              </span>
            )}
            <ChevronDown />
          </button>

          {switcherOpen && (
            <>
              {/* click-away backdrop */}
              <div className="fixed inset-0 z-40" onClick={() => setSwitcherOpen(false)} />
              <div className="project-menu absolute left-0 top-full z-50 mt-1 w-64 rounded-lg py-1 text-[12.5px]">
                <div className="px-3 py-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                  Recent projects
                </div>
                <div className="max-h-72 overflow-auto">
                  {(recentProjects ?? []).map((p) => (
                    <button
                      key={p.path}
                      onClick={() => pickProject(p)}
                      className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    >
                      <FolderIcon />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-[var(--text-primary)]">{p.name}</span>
                        <span className="block truncate text-[10.5px] text-[var(--text-tertiary)]">{p.path}</span>
                      </span>
                      {p.path === project.path && <CheckIcon />}
                    </button>
                  ))}
                  {recentProjects && recentProjects.length === 0 && (
                    <div className="px-3 py-2 text-[11.5px] text-[var(--text-tertiary)]">No recent projects.</div>
                  )}
                </div>
                <div className="my-1 h-px bg-[var(--surface-2)]" />
                <button
                  onClick={() => { setSwitcherOpen(false); openLauncher(); }}
                  className="project-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--text-secondary)]"
                >
                  <PlusIcon />
                  Open or create another project…
                </button>
              </div>
            </>
          )}
        </div>

        {/* Centred nav group: prev/next through recently changed editors, then a
            VS Code-style search box. The box hides while the dropdown is open so
            the popup input visually replaces it. */}
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5">
          <div className="flex items-center">
            <NavArrow
              dir="prev"
              disabled={trailPos <= 0}
              onClick={() => goHistory(-1)}
              title="Back to previously changed editor"
            />
            <NavArrow
              dir="next"
              disabled={trailPos < 0 || trailPos >= editTrail.length - 1}
              onClick={() => goHistory(1)}
              title="Forward to next changed editor"
            />
          </div>
          <button
            onClick={() => setQuickOpen("files")}
            title="Go to file (⌘P) · type > for commands"
            className={`search-box flex h-[26px] w-[min(440px,42vw)] items-center gap-2 px-2.5 ${
              quickOpen ? "opacity-0" : ""
            }`}
          >
            <SearchIcon />
            <span className="min-w-0 flex-1 truncate text-left text-[12px] text-[var(--text-tertiary)]">
              {info?.name ?? project.name}
            </span>
            <kbd className="shrink-0 rounded bg-[var(--surface-2)] px-1 py-0.5 text-[10px] font-sans text-[var(--text-tertiary)]">⌘P</kbd>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <RunConfigBar
            configs={runConfigs}
            selected={selectedConfig}
            running={running}
            debugBusy={debugStatus === "running" || debugStatus === "building"}
            debugPaused={debugStatus === "paused"}
            onSelect={selectConfig}
            onRun={runSelectedConfig}
            onDebug={() => void debugSelectedConfig()}
            onEdit={() => setEditingConfigs(true)}
          />
          <CargoButton iconOnly onClick={() => void runCargo("build")} disabled={running} label="Build" hint="⌘B" icon={<HammerIcon />} />
          <CargoButton iconOnly onClick={() => void runCargo("clippy")} disabled={running} label="Check" hint="⌘L" icon={<SparkleIcon />} />
          <CargoButton iconOnly onClick={() => setShowBoard(true)} label="Task Board" icon={<BoardIcon />} />
          {running && (
            <button onClick={() => void cargoCancel()} className="btn-bezel ml-1 px-2.5 py-1 text-[12px]">
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!treeHidden && (
          <>
            <aside className="explorer-pane flex shrink-0 flex-row" style={{ width: treeWidth }}>
              <nav className="nav-rail flex shrink-0 flex-col items-center gap-1 pt-2" data-tauri-drag-region>
                <RailTab active={leftTab === "project"} onClick={() => setLeftTab("project")} title="Project" icon={<FilesIcon />} />
                <RailTab active={leftTab === "modules"} onClick={() => setLeftTab("modules")} title="Modules" icon={<ModulesRailIcon />} />
                <RailTab active={leftTab === "dependencies"} onClick={() => setLeftTab("dependencies")} title="Dependencies" icon={<DepsRailIcon />} />
                {buildTool && (
                  <RailTab
                    active={leftTab === "maven"}
                    onClick={() => setLeftTab("maven")}
                    title={buildTool === "maven" ? "Maven" : "Gradle"}
                    icon={buildTool === "maven" ? <MavenLogo size={18} /> : <GradleLogo size={18} />}
                  />
                )}
              </nav>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1">
                {leftTab === "project" ? (
                  <FileTree
                    tree={tree ?? []}
                    loading={treeLoading && !tree}
                    rootPath={project.path}
                    selectedPath={activePath}
                    problemPaths={problemPaths}
                    sourceRoots={sourceRoots}
                    onOpen={openFile}
                    onCreate={createInTree}
                    onDelete={deleteInTree}
                    onMove={moveInTree}
                    onCopy={copyInTree}
                    onUndo={undoTree}
                    onOpenStructure={() => setStructureOpen(true)}
                  />
                ) : leftTab === "modules" ? (
                  <ModulesView root={project.path} activePath={activePath} onOpen={(p, line) => void jumpTo(p, line ?? 1, 1)} />
                ) : leftTab === "maven" && buildTool ? (
                  <BuildView tool={buildTool} running={running} onRun={(goals) => void runGoal(goals)} onStop={() => void cargoCancel()} />
                ) : (
                  <DependenciesView root={project.path} />
                )}
              </div>
            </aside>
            <Resizer width={treeWidth} setWidth={setTreeWidth} dir={1} min={160} max={480} onReset={() => setTreeWidth(TREE_DEFAULT)} />
          </>
        )}

        <main className="content-pane flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1" style={{ flexDirection: split === "col" ? "column" : "row" }}>
            {/* Primary editor group */}
            <div
              className={`flex min-h-0 min-w-0 flex-1 flex-col ${split && activeGroup === 0 ? "ring-1 ring-inset ring-[color:var(--accent-soft)]" : ""}`}
              onMouseDownCapture={() => setActiveGroup(0)}
            >
              <TabStrip
                files={files}
                activePath={activePath}
                onSelect={(p) => { setActivePath(p); setActiveGroup(0); }}
                onClose={closeTab}
                onCloseTabs={closeTabs}
                onSplit={split ? undefined : splitEditor}
                pinned={pinned}
                onTogglePin={togglePin}
              />
              <div className="relative min-h-0 min-w-0 flex-1">
                {agentActive && agentEditPath && (
                  <div className="agent-editing-pill">
                    <span className="dot" />
                    Agent editing {basename(agentEditPath)}
                  </div>
                )}
                {renderEditorArea(active, editorRef)}
              </div>
            </div>

            {/* Split (secondary) editor group */}
            {split && (
              <div
                className={`flex min-h-0 min-w-0 flex-1 flex-col ${split === "col" ? "border-t" : "border-l"} border-[color:var(--line)] ${activeGroup === 1 ? "ring-1 ring-inset ring-[color:var(--accent-soft)]" : ""}`}
                onMouseDownCapture={() => setActiveGroup(1)}
              >
                <TabStrip
                  files={secFiles}
                  activePath={secActive}
                  onSelect={(p) => { setSecActive(p); setActiveGroup(1); }}
                  onClose={(p) => closeSecTabs([p])}
                  onCloseTabs={closeSecTabs}
                />
                <div className="relative min-h-0 min-w-0 flex-1">{renderEditorArea(secActiveFile, editorRef2)}</div>
              </div>
            )}
          </div>

          {!outputHidden && (
            <>
              <VResizer height={outputHeight} setHeight={setOutputHeight} />
              <div className="shrink-0" style={{ height: outputHeight }}>
                <OutputPanel
                  lines={lines}
                  diagnostics={allProblems}
                  running={running}
                  lastResult={lastResult}
                  command={command}
                  onJump={(f, l, c) => void jumpTo(f, l, c)}
                  onClear={() => {
                    setLines([]);
                    setDiagnostics([]);
                    setLastResult(null);
                  }}
                  onCancel={() => void cargoCancel()}
                  tab={outputTab}
                  onTab={setOutputTab}
                  debug={{
                    status: debugStatus,
                    available: hasDebugger,
                    target: debugTarget,
                    bins: info?.bins ?? [],
                    frames,
                    selectedFrame,
                    consoleLines: debugConsole,
                    onTarget: setDebugTarget,
                    onStart: () => void startOrContinue(),
                    onStepOver: stepOver,
                    onStepInto: stepInto,
                    onStepOut: stepOut,
                    onStop: () => void stopDebug(),
                    onSelectFrame: selectFrame,
                    onEval: evalExpr,
                    onInstalled: () => {
                      qc.invalidateQueries({ queryKey: ["debugger-adapter"] });
                      qc.invalidateQueries({ queryKey: ["tool-paths"] });
                    },
                  }}
                  usages={usages}
                  usagesRoot={project.path}
                  onUsageJump={(p, l, c) => void jumpTo(p, l, c)}
                  breakpointsPanel={{
                    items: breakpoints,
                    root: project.path,
                    onJump: (p, line) => void jumpTo(p, line, 1),
                    onToggleEnabled: (p, line) => {
                      const cur = breakpointsRef.current[p] ?? [];
                      const b = cur.find((x) => x.line === line);
                      if (b) patchBreakpoint(p, line, { enabled: !b.enabled });
                    },
                    onRemove: removeBreakpoint,
                    onPatch: patchBreakpoint,
                    onRemoveAll: removeAllBreakpoints,
                    onSetAllEnabled: setAllBreakpointsEnabled,
                  }}
                  gitRoot={project.path}
                  onOpenDiff={openDiff}
                  onOpenWorkingDiff={openWorkingDiff}
                  onOpenRepoFile={(rel) => openFile(`${project.path}/${rel}`)}
                  onAnalyze={(text) => {
                    setRightPanel("chat");
                    const prompt = `Analyze this build/run output from the project and explain what happened. If there are errors, identify the root cause and suggest concrete fixes; if it succeeded, summarize briefly.\n\n\`\`\`\n${text}\n\`\`\``;
                    setTimeout(() => window.dispatchEvent(new CustomEvent("rustade:vibe-ask", { detail: prompt })), 60);
                  }}
                />
              </div>
            </>
          )}
        </main>

        {rightPanel && (
          <>
            <Resizer width={aiWidth} setWidth={setAiWidth} dir={-1} min={240} max={Math.max(560, window.innerWidth - 520)} onReset={() => setAiWidth(300)} />
            <div className="h-full min-h-0 shrink-0 overflow-hidden" style={{ width: aiWidth }}>
              {rightPanel === "review" ? (
                <AiPanel
                  file={active && !active.loading ? { path: active.path, name: active.name, content: active.content } : null}
                  selection={selection}
                  onApply={applySuggestion}
                />
              ) : rightPanel === "skills" ? (
                <SkillsPanel root={project.path} />
              ) : (
                <ChatPanel
                  file={active && !active.loading ? { path: active.path, name: active.name, content: active.content } : null}
                  root={project.path}
                  resolveRef={resolveRef}
                  onOpen={(path, line) => void jumpTo(path, line ?? 1, 1)}
                  onApplyCode={applyChatCode}
                  onWorkspaceChanged={reloadOpenFiles}
                  onAgentActive={setAgentActive}
                />
              )}
            </div>
          </>
        )}

        {/* Right activity bar — switch between the two AI panels. */}
        <ActivityBar
          items={[
            {
              id: "review",
              title: "Intelligent Review (⌘⌥3)",
              active: rightPanel === "review",
              onClick: () => setRightPanel((p) => (p === "review" ? null : "review")),
              icon: (
                <svg viewBox="0 0 304.887 304.887" width="16" height="16" fill="currentColor">
                  <path d="M298.903,269.979l-111.37-111.37c11.014-16.584,16.937-36.028,16.937-56.381c0-27.299-10.639-52.971-29.953-72.285C155.214,10.633,129.547,0,102.243,0C74.928,0,49.25,10.633,29.942,29.942C10.638,49.256,0.005,74.929,0.005,102.227c0,27.31,10.633,52.976,29.937,72.291c19.314,19.303,44.986,29.942,72.296,29.942c20.353,0,39.803-5.923,56.381-16.926l111.349,111.349c3.856,3.867,8.996,6.005,14.468,6.005c5.455,0,10.601-2.121,14.484-5.988C306.872,290.908,306.872,277.947,298.903,269.979z M102.243,35.805c17.737,0,34.413,6.908,46.961,19.461c12.553,12.537,19.456,29.213,19.456,46.966c0,17.742-6.908,34.424-19.456,46.972c-12.548,12.542-29.224,19.456-46.966,19.456s-34.424-6.913-46.972-19.456c-12.548-12.553-19.461-29.23-19.461-46.972s6.913-34.424,19.456-46.966C67.814,42.713,84.501,35.805,102.243,35.805z" />
                </svg>
              ),
            },
            {
              id: "chat",
              title: "AI Assistant (⌘⌥4)",
              active: rightPanel === "chat",
              onClick: () => setRightPanel((p) => (p === "chat" ? null : "chat")),
              icon: (
                <svg viewBox="0 -0.5 25 25" width="18" height="18" fill="none">
                  <path fillRule="evenodd" clipRule="evenodd" d="M4.5 14.462V12.538C4.52129 11.6681 5.2431 10.9799 6.113 11H6.774C7.34208 9.24261 8.96147 8.03831 10.808 8H14.192C16.0385 8.03831 17.6579 9.24261 18.226 11C18.4082 11.5231 18.5009 12.0731 18.5 12.627V14.373C18.5849 16.8392 16.6579 18.9088 14.192 19H10.808C8.96147 18.9617 7.34208 17.7574 6.774 16H6.113C5.2431 16.0201 4.52129 15.3319 4.5 14.462Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path fillRule="evenodd" clipRule="evenodd" d="M14.5 12.5C14.5 13.6046 13.6046 14.5 12.5 14.5C11.3954 14.5 10.5 13.6046 10.5 12.5C10.5 11.3954 11.3954 10.5 12.5 10.5C13.6046 10.5 14.5 11.3954 14.5 12.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M13.25 5C13.25 4.58579 12.9142 4.25 12.5 4.25C12.0858 4.25 11.75 4.58579 11.75 5H13.25ZM11.75 8C11.75 8.41421 12.0858 8.75 12.5 8.75C12.9142 8.75 13.25 8.41421 13.25 8H11.75ZM6.06579 16.2467C6.20206 16.6379 6.62963 16.8445 7.02079 16.7082C7.41194 16.572 7.61856 16.1444 7.48228 15.7533L6.06579 16.2467ZM6.50004 14.373L7.25004 14.3742V14.373H6.50004ZM6.50004 12.627H7.25004L7.25004 12.6258L6.50004 12.627ZM7.48228 11.2467C7.61856 10.8556 7.41194 10.428 7.02079 10.2918C6.62963 10.1555 6.20206 10.3621 6.06579 10.7533L7.48228 11.2467ZM18.226 10.25C17.8118 10.25 17.476 10.5858 17.476 11C17.476 11.4142 17.8118 11.75 18.226 11.75V10.25ZM18.887 11V11.75C18.8928 11.75 18.8986 11.7499 18.9044 11.7498L18.887 11ZM20.5 12.538H21.25C21.25 12.5319 21.25 12.5258 21.2498 12.5197L20.5 12.538ZM20.5 14.462L21.2498 14.4803C21.25 14.4742 21.25 14.4681 21.25 14.462H20.5ZM18.887 16L18.9044 15.2502C18.8986 15.2501 18.8928 15.25 18.887 15.25V16ZM18.226 15.25C17.8118 15.25 17.476 15.5858 17.476 16C17.476 16.4142 17.8118 16.75 18.226 16.75V15.25ZM10.5 15.75C10.0858 15.75 9.75004 16.0858 9.75004 16.5C9.75004 16.9142 10.0858 17.25 10.5 17.25V15.75ZM14.5 17.25C14.9142 17.25 15.25 16.9142 15.25 16.5C15.25 16.0858 14.9142 15.75 14.5 15.75V17.25ZM11.75 5V8H13.25V5H11.75ZM7.48228 15.7533C7.32782 15.3099 7.2493 14.8437 7.25004 14.3742L5.75004 14.3718C5.74904 15.0101 5.85579 15.644 6.06579 16.2467L7.48228 15.7533ZM7.25004 14.373V12.627H5.75004V14.373H7.25004ZM7.25004 12.6258C7.2493 12.1563 7.32782 11.6901 7.48228 11.2467L6.06579 10.7533C5.85579 11.356 5.74904 11.9899 5.75004 12.6282L7.25004 12.6258ZM18.226 11.75H18.887V10.25H18.226V11.75ZM18.9044 11.7498C19.3606 11.7392 19.7391 12.1002 19.7503 12.5563L21.2498 12.5197C21.2184 11.2361 20.1533 10.2205 18.8697 10.2502L18.9044 11.7498ZM19.75 12.538V14.462H21.25V12.538H19.75ZM19.7503 14.4437C19.7391 14.8998 19.3606 15.2608 18.9044 15.2502L18.8697 16.7498C20.1533 16.7795 21.2184 15.7639 21.2498 14.4803L19.7503 14.4437ZM18.887 15.25H18.226V16.75H18.887V15.25ZM10.5 17.25H14.5V15.75H10.5V17.25Z" fill="currentColor" />
                </svg>
              ),
            },
            {
              id: "skills",
              title: "Skills (⌘⌥5)",
              active: rightPanel === "skills",
              onClick: () => setRightPanel((p) => (p === "skills" ? null : "skills")),
              icon: (
                <svg viewBox="0 0 512 512" width="17" height="17" fill="currentColor">
                  <path d="M94.972,55.756H30.479C13.646,55.756,0,69.407,0,86.243v342.279c0,16.837,13.646,30.47,30.479,30.47h64.493c16.833,0,30.479-13.634,30.479-30.47V86.243C125.452,69.407,111.805,55.756,94.972,55.756z M98.569,234.237H26.882v-17.922h71.687V234.237z M98.569,180.471H26.882v-35.843h71.687V180.471z" />
                  <path d="M238.346,55.756h-64.493c-16.833,0-30.479,13.651-30.479,30.487v342.279c0,16.837,13.646,30.47,30.479,30.47h64.493c16.833,0,30.479-13.634,30.479-30.47V86.243C268.825,69.407,255.178,55.756,238.346,55.756z M241.942,234.237h-71.687v-17.922h71.687V234.237z M241.942,180.471h-71.687v-35.843h71.687V180.471z" />
                  <path d="M510.409,398.305L401.562,73.799c-5.352-15.961-22.63-24.554-38.587-19.208l-61.146,20.512c-15.961,5.356-24.559,22.63-19.204,38.592L391.472,438.2c5.356,15.962,22.63,24.555,38.587,19.208l61.146-20.512C507.166,431.541,515.763,414.267,510.409,398.305z M326.677,160.493l67.967-22.796l11.398,33.988l-67.968,22.796L326.677,160.493z M355.173,245.455l-5.701-16.994l67.968-22.796l5.696,16.994L355.173,245.455z" />
                </svg>
              ),
            },
          ]}
        />
      </div>

      <StatusBar
        file={active && !active.loading ? { name: active.name, content: active.content } : null}
        branch={branch ?? null}
        cursor={cursor}
      />

      {quickOpen && (
        <QuickOpen
          files={quickFiles}
          commands={commands}
          onOpenFile={openFile}
          startInCommands={quickOpen === "commands"}
          onClose={() => setQuickOpen(null)}
        />
      )}

      {showSearch && project && (
        <SearchOverlay root={project.path} onJump={(f, l, c) => void jumpTo(f, l, c)} onClose={() => setShowSearch(false)} />
      )}

      {showPalette && (
        <CommandPalette
          commands={commands.filter((c) => c.id !== "view.palette")}
          onClose={() => setShowPalette(false)}
        />
      )}

      {editingConfigs && (
        <RunConfigDialog
          configs={runConfigs}
          tests={testNames ?? []}
          mains={info?.bins ?? []}
          springMains={springMainNames ?? []}
          onSave={(next) => { persistConfigs(next); setEditingConfigs(false); }}
          onClose={() => setEditingConfigs(false)}
        />
      )}

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      {showBoard && project && <TaskBoardDialog root={project.path} onClose={() => setShowBoard(false)} />}

      {runMenu && (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setRunMenu(null)} onContextMenu={(e) => { e.preventDefault(); setRunMenu(null); }} />
          <div className="context-menu fixed z-[71] py-1" style={{ left: runMenu.x, top: runMenu.y }}>
            <button
              className="context-item flex items-center gap-2"
              onClick={() => { runSymbol(runMenu.run, runMenu.path); setRunMenu(null); }}
            >
              <span className="text-green-600">▶</span> Run ‘{runMenu.run.name}’
            </button>
            <button
              className="context-item flex items-center gap-2"
              onClick={() => { debugSymbol(runMenu.run); setRunMenu(null); }}
            >
              <span className="text-[var(--accent)]">🐞</span> Debug ‘{runMenu.run.name}’
            </button>
          </div>
        </>
      )}

      {gotoLine && active && (
        <GoToLineDialog
          totalLines={Math.max(1, (active.content.match(/\n/g)?.length ?? 0) + 1)}
          onGo={(line, col) => { activeEditor()?.goTo(line, col); setGotoLine(false); }}
          onClose={() => setGotoLine(false)}
        />
      )}

      {structureOpen && project && (
        <ProjectSettingsDialog
          rootPath={project.path}
          tree={tree ?? []}
          roots={sourceRoots}
          about={{
            name: info?.name ?? project.name,
            version: info?.version,
            languageLevel: info?.edition || undefined,
            buildTool: tree?.some((n) => n.name === "pom.xml") ? "Maven" : tree?.some((n) => n.name.startsWith("build.gradle")) ? "Gradle" : undefined,
            workspace: info?.is_workspace,
            members: info?.members,
          }}
          onSave={(next) => {
            saveSourceRoots(project.path, next);
            setSourceRoots(next);
            setStructureOpen(false);
          }}
          onClose={() => setStructureOpen(false)}
        />
      )}

      {pendingSwitch && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30"
          onClick={() => setPendingSwitch(null)}
        >
          <div
            className="switch-dialog w-[380px] rounded-xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Open “{pendingSwitch.name}”</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              Replace the project in this window, or open it in a new window?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => { const p = pendingSwitch; setPendingSwitch(null); chooseProject(p); }}
                className="btn-accent w-full px-3 py-2 text-[12.5px]"
              >
                Replace this window
              </button>
              <button
                onClick={() => { void openProjectWindow(pendingSwitch.path); setPendingSwitch(null); }}
                className="btn-bezel w-full px-3 py-2 text-[12.5px]"
              >
                Open in new window
              </button>
              <button
                onClick={() => setPendingSwitch(null)}
                className="w-full px-3 py-1.5 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function NavArrow({
  dir,
  disabled,
  onClick,
  title,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="nav-arrow flex h-[26px] w-[24px] items-center justify-center text-[var(--text-tertiary)] disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {dir === "prev" ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
      </svg>
    </button>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent)]">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className="shrink-0 text-[var(--text-tertiary)]">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

/** Small "Go to Line" prompt: accepts `line` or `line:column`, ⏎ to jump. */
function GoToLineDialog({ totalLines, onGo, onClose }: { totalLines: number; onGo: (line: number, col: number) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const m = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(value);
    if (!m) return;
    const line = Math.min(Math.max(parseInt(m[1], 10), 1), totalLines);
    const col = m[2] ? Math.max(parseInt(m[2], 10), 1) : 1;
    onGo(line, col);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/20" onClick={onClose}>
      <div className="switch-dialog mt-[18vh] w-[min(360px,86vw)] rounded-xl p-3.5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-[13px] font-semibold text-[var(--text-primary)]">Go to Line</div>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          placeholder={`Line (1–${totalLines}), or line:column`}
          className="field w-full px-2.5 py-2 font-mono text-[12.5px]"
        />
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
          Enter a line number, or <code className="font-mono">line:column</code>. ⏎ to jump, Esc to cancel.
        </p>
      </div>
    </div>
  );
}

function CargoButton({
  onClick,
  disabled,
  label,
  hint,
  icon,
  iconOnly,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  iconOnly?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint ? `${label} (${hint})` : label}
      className={`flex items-center gap-1.5 rounded-md border border-[color:var(--line)] bg-[var(--control-bg)] py-1 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--hover)] disabled:opacity-40 ${
        iconOnly ? "px-2" : "px-2.5"
      }`}
    >
      {icon}
      {!iconOnly && label}
    </button>
  );
}

function RailTab({ active, onClick, title, icon }: { active: boolean; onClick: () => void; title: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`nav-rail-btn ${active ? "nav-rail-btn-active" : ""}`}
    >
      {icon}
    </button>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M3.75 4.5a.25.25 0 00-.25.25v14.5c0 .138.112.25.25.25h16.5a.25.25 0 00.25-.25V7.687a.25.25 0 00-.25-.25h-8.471a1.75 1.75 0 01-1.447-.765L8.928 4.61a.25.25 0 00-.208-.11H3.75zM2 4.75C2 3.784 2.784 3 3.75 3h4.971c.58 0 1.12.286 1.447.765l1.404 2.063a.25.25 0 00.207.11h8.471c.966 0 1.75.783 1.75 1.75V19.25A1.75 1.75 0 0120.25 21H3.75A1.75 1.75 0 012 19.25V4.75z" />
    </svg>
  );
}

function PinIcon({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5M9 3h6l-1 6 3 2v2H7v-2l3-2z" />
    </svg>
  );
}

function ModulesRailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.3 7l8.7 5 8.7-5M12 22V12" />
    </svg>
  );
}

function DepsRailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8 7l7.5 1.6M7.5 8.2 8.6 15.5" />
    </svg>
  );
}

function HammerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
      <path d="M14 6l4 4M3 21l7.5-7.5M12.5 8.5l3-3 1-1a2.8 2.8 0 0 1 4 4l-1 1-3 3-4-4z" />
      <path d="M9 11l4 4-1.5 1.5a2 2 0 0 1-3 0l-1-1a2 2 0 0 1 0-3z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
      <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
      <path d="M18 15l.7 1.8 1.8.7-1.8.7L18 20l-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  );
}

function TabStrip({
  files,
  activePath,
  onSelect,
  onClose,
  onCloseTabs,
  onSplit,
  pinned,
  onTogglePin,
}: {
  files: OpenFile[];
  activePath: string | null;
  onSelect: (p: string) => void;
  onClose: (p: string) => void;
  onCloseTabs: (paths: string[]) => void;
  onSplit?: (dir: "row" | "col") => void;
  pinned?: Set<string>;
  onTogglePin?: (path: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const isPinned = (p: string) => !!pinned?.has(p);
  // Pinned tabs first (keeping their relative order), then the rest.
  const ordered = pinned && pinned.size > 0 ? [...files.filter((f) => isPinned(f.path)), ...files.filter((f) => !isPinned(f.path))] : files;
  const lastPinnedIdx = ordered.reduce((acc, f, i) => (isPinned(f.path) ? i : acc), -1);

  if (files.length === 0) return <div className="h-9 shrink-0 border-b border-[color:var(--line)]" />;
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[color:var(--line)]">
      {ordered.map((f, i) => {
        const active = f.path === activePath;
        const pin = isPinned(f.path);
        return (
          <div
            key={f.path}
            onClick={() => onSelect(f.path)}
            onAuxClick={(e) => {
              // Middle-click closes (unless pinned).
              if (e.button === 1) {
                e.preventDefault();
                onClose(f.path);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: f.path });
            }}
            className={`group flex min-w-[84px] max-w-[200px] flex-shrink cursor-default items-center gap-1.5 border-r px-3 text-[12px] ${
              i === lastPinnedIdx ? "border-r-2 border-[color:var(--accent-soft)]" : "border-[color:var(--line)]"
            } ${active ? "bg-[var(--control-bg)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"}`}
          >
            {f.name.endsWith(".java") && <JavaCoffeeGlyph />}
            <span className="min-w-0 truncate">{f.name}</span>
            {f.saveState !== "saved" ? (
              <span className="shrink-0 text-[9px] text-[var(--accent)]" title="Unsaved">
                ●
              </span>
            ) : null}
            {pin ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin?.(f.path);
                }}
                title="Unpin"
                className="shrink-0 rounded p-0.5 text-[var(--accent)] hover:bg-[var(--hover)]"
              >
                <PinIcon filled />
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(f.path);
                }}
                title="Close"
                className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--hover)] group-hover:opacity-100"
              >
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        );
      })}

      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.path}
          files={ordered}
          pinned={isPinned(menu.path)}
          onTogglePin={onTogglePin ? () => { onTogglePin(menu.path); setMenu(null); } : undefined}
          onClose={() => setMenu(null)}
          onAction={(paths) => {
            onCloseTabs(paths);
            setMenu(null);
          }}
          onSplit={
            onSplit
              ? (dir) => {
                  onSelect(menu.path);
                  onSplit(dir);
                  setMenu(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/** Right-click menu for an editor tab: Close / Close Others / Close to the Right /
 *  Close Saved / Close All. */
function TabContextMenu({
  x,
  y,
  path,
  files,
  pinned,
  onTogglePin,
  onClose,
  onAction,
  onSplit,
}: {
  x: number;
  y: number;
  path: string;
  files: OpenFile[];
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose: () => void;
  onAction: (paths: string[]) => void;
  onSplit?: (dir: "row" | "col") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const idx = files.findIndex((f) => f.path === path);
  const others = files.filter((f) => f.path !== path).map((f) => f.path);
  const toRight = files.slice(idx + 1).map((f) => f.path);
  const saved = files.filter((f) => f.saveState === "saved").map((f) => f.path);
  const all = files.map((f) => f.path);

  const items: { label: string; paths: string[]; disabled?: boolean }[] = [
    { label: "Close", paths: [path], disabled: pinned },
    { label: "Close Others", paths: others, disabled: others.length === 0 },
    { label: "Close to the Right", paths: toRight, disabled: toRight.length === 0 },
    { label: "Close Saved", paths: saved, disabled: saved.length === 0 },
    { label: "Close All", paths: all },
  ];

  const itemCls =
    "flex w-full items-center px-3 py-1 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-primary)]";
  return createPortal(
    <div ref={ref} className="context-menu fixed z-[80] min-w-[190px] py-1" style={{ left: x, top: y }}>
      {onTogglePin && (
        <>
          <button className={itemCls} onClick={onTogglePin}>
            {pinned ? "Unpin Tab" : "Pin Tab"}
          </button>
          <div className="my-1 border-t border-[color:var(--line)]" />
        </>
      )}
      {items.map((it, i) => (
        <button key={i} disabled={it.disabled} onClick={() => onAction(it.paths)} className={itemCls}>
          {it.label}
        </button>
      ))}
      {onSplit && (
        <>
          <div className="my-1 border-t border-[color:var(--line)]" />
          <button className={itemCls} onClick={() => onSplit("row")}>
            Split Right
          </button>
          <button className={itemCls} onClick={() => onSplit("col")}>
            Split Down
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** The app's crab mark, in the accent colour — shown before each tab's name. */
/** Coffee-cup glyph in Java orange, shown on `.java` tabs. */
function JavaCoffeeGlyph() {
  return (
    <svg viewBox="-5 0 32 32" width="13" height="13" className="shrink-0" fill="#f89820" aria-hidden>
      <path d="M12.406 14.75c-0.094-2.094-0.219-3.219-1.469-4.594-1.594-1.781-2.188-3.5-0.875-6.156 0.344 1.781 0.469 3.375 1.719 4.344s2.281 3.594 0.625 6.406zM10.063 14.75c-0.063-1.125-0.125-1.688-0.813-2.469-0.844-0.938-1.188-1.844-0.469-3.281 0.188 0.969 0.219 1.813 0.906 2.313s1.281 1.938 0.375 3.438zM15.719 24.625h5.688c0.344 0 0.469 0.25 0.25 0.531 0 0-2.219 2.844-5.281 2.844h-10.969s-5.281-2.844-5.281-2.844c-0.219-0.281-0.125-0.531 0.219-0.531h5.625c-0.781-0.406-1.938-2.188-1.938-4.406v-4.688h13.688v0.375c0.438-0.375 0.969-0.563 1.531-0.563 0.781 0 2.25 0.813 2.25 2.219 0 2.031-1.344 2.781-2.125 3.313 0 0-1.469 1.156-2.5 2.5-0.344 0.594-0.75 1.063-1.156 1.25zM19.25 16.188c-0.5 0-1.125 0.219-1.531 1.219v2.594c0 0.344-0.031 0.75-0.094 1.094 0.688-0.688 1.5-1.156 1.5-1.156 0.5-0.344 1.5-1 1.5-2.281 0.031-0.906-0.813-1.469-1.375-1.469zM6.406 16.563h-0.875v1.281h0.875v-1.281zM6.406 18.594h-0.875v2.094s0.25 2.813 2.031 3.656c-1.094-1.281-1.156-2.75-1.156-3.656v-2.094z" />
    </svg>
  );
}

/** Horizontal divider for the output panel (the shared Resizer is vertical). */
function VResizer({ height, setHeight }: { height: number; setHeight: (n: number) => void }) {
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) =>
      setHeight(Math.max(80, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className="v-resizer shrink-0" onMouseDown={onDown} onDoubleClick={() => setHeight(OUTPUT_DEFAULT)} />;
}
