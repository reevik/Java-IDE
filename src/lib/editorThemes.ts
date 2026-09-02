import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** A code color scheme: base editor colors + syntax token colors. */
interface Spec {
  dark: boolean;
  bg: string;
  fg: string;
  caret: string;
  selection: string;
  gutter: string;
  activeLine: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  type: string;
  func: string;
  property: string;
  operator: string;
  meta: string;
}

export interface EditorTheme {
  id: string;
  name: string;
  theme: Extension;
  highlight: HighlightStyle;
}

function build(s: Spec): { theme: Extension; highlight: HighlightStyle } {
  const theme = EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: s.bg, color: s.fg },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: 'var(--code-font-family, "SF Mono", ui-monospace, Menlo, monospace)',
        fontSize: "var(--code-font-size, 13px)",
        lineHeight: "1.6",
      },
      ".cm-content": { padding: "12px 0 160px", caretColor: s.caret },
      ".cm-gutters": { backgroundColor: s.gutter, border: "none", color: s.dark ? "rgba(255,255,255,0.34)" : "rgba(0,0,0,0.34)" },
      ".cm-activeLine": { backgroundColor: s.activeLine },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: s.fg },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: s.caret, borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: s.selection },
    },
    { dark: s.dark },
  );
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: s.keyword },
    { tag: [t.string, t.special(t.string)], color: s.string },
    { tag: t.comment, color: s.comment, fontStyle: "italic" },
    { tag: [t.number, t.bool, t.atom], color: s.number },
    { tag: [t.typeName, t.className, t.namespace], color: s.type },
    { tag: t.function(t.variableName), color: s.func },
    { tag: t.propertyName, color: s.property },
    { tag: [t.operator, t.punctuation, t.bracket], color: s.operator },
    { tag: [t.meta, t.macroName], color: s.meta },
  ]);
  return { theme, highlight };
}

const SPECS: { id: string; name: string; spec: Spec }[] = [
  {
    id: "github-light", name: "GitHub Light",
    spec: { dark: false, bg: "#ffffff", fg: "#24292e", caret: "#044289", selection: "#b3d7ff", gutter: "#ffffff", activeLine: "#f6f8fa",
      keyword: "#d73a49", string: "#032f62", comment: "#6a737d", number: "#005cc5", type: "#6f42c1", func: "#6f42c1", property: "#005cc5", operator: "#24292e", meta: "#d73a49" },
  },
  {
    id: "github-dark", name: "GitHub Dark",
    spec: { dark: true, bg: "#0d1117", fg: "#c9d1d9", caret: "#58a6ff", selection: "#2d4b76", gutter: "#0d1117", activeLine: "#161b22",
      keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", number: "#79c0ff", type: "#ffa657", func: "#d2a8ff", property: "#79c0ff", operator: "#c9d1d9", meta: "#ff7b72" },
  },
  {
    id: "one-dark", name: "One Dark",
    spec: { dark: true, bg: "#282c34", fg: "#abb2bf", caret: "#528bff", selection: "#3e4451", gutter: "#282c34", activeLine: "#2c313a",
      keyword: "#c678dd", string: "#98c379", comment: "#7d8799", number: "#d19a66", type: "#e5c07b", func: "#61afef", property: "#56b6c2", operator: "#abb2bf", meta: "#e5c07b" },
  },
  {
    id: "dracula", name: "Dracula",
    spec: { dark: true, bg: "#282a36", fg: "#f8f8f2", caret: "#f8f8f2", selection: "#44475a", gutter: "#282a36", activeLine: "#343746",
      keyword: "#ff79c6", string: "#f1fa8c", comment: "#6272a4", number: "#bd93f9", type: "#8be9fd", func: "#50fa7b", property: "#f8f8f2", operator: "#ff79c6", meta: "#ffb86c" },
  },
  {
    id: "solarized-dark", name: "Solarized Dark",
    spec: { dark: true, bg: "#002b36", fg: "#93a1a1", caret: "#839496", selection: "#0b4150", gutter: "#002b36", activeLine: "#073642",
      keyword: "#859900", string: "#2aa198", comment: "#586e75", number: "#d33682", type: "#b58900", func: "#268bd2", property: "#268bd2", operator: "#93a1a1", meta: "#cb4b16" },
  },
  {
    id: "solarized-light", name: "Solarized Light",
    spec: { dark: false, bg: "#fdf6e3", fg: "#586e75", caret: "#657b83", selection: "#eee8d5", gutter: "#fdf6e3", activeLine: "#eee8d5",
      keyword: "#859900", string: "#2aa198", comment: "#93a1a1", number: "#d33682", type: "#b58900", func: "#268bd2", property: "#268bd2", operator: "#586e75", meta: "#cb4b16" },
  },
];

export const EDITOR_THEMES: EditorTheme[] = SPECS.map(({ id, name, spec }) => ({ id, name, ...build(spec) }));

/** Picker options for a given mode (Default + the schemes matching that mode). */
export function editorThemeOptions(dark: boolean): { id: string; name: string }[] {
  return [
    { id: "", name: "Default (adaptive)" },
    ...SPECS.filter((s) => s.spec.dark === dark).map((s) => ({ id: s.id, name: s.name })),
  ];
}

// Separate preferences per appearance, so a dark app auto-uses the dark scheme.
const LIGHT_KEY = "editor.theme.light";
const DARK_KEY = "editor.theme.dark";

export function loadEditorTheme(dark: boolean): string {
  // Migrate the old single key on first read.
  const legacy = localStorage.getItem("editor.theme");
  if (legacy) {
    const legacyDark = SPECS.find((s) => s.id === legacy)?.spec.dark;
    if (legacyDark != null) localStorage.setItem(legacyDark ? DARK_KEY : LIGHT_KEY, legacy);
    localStorage.removeItem("editor.theme");
  }
  return localStorage.getItem(dark ? DARK_KEY : LIGHT_KEY) ?? "";
}

export function saveEditorTheme(dark: boolean, id: string) {
  localStorage.setItem(dark ? DARK_KEY : LIGHT_KEY, id);
}
