import { useEffect, useRef } from "react";
import { EditorState, StateField, type Extension, type Range } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { convertFileSrc } from "@tauri-apps/api/core";
import { QuickSearchPanel } from "./QuickSearchPanel";
import { HighlightStyle, syntaxHighlighting, syntaxTree, type Language } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { tags as t } from "@lezer/highlight";
import { highlightStyle, darkHighlightStyle } from "./CodeEditor";

// Highlight fenced code blocks in their own language.
const javaLang = java().language;
const jsonLang = json().language;
const xmlLang = xml().language;
function codeLanguages(info: string): Language | null {
  switch (info.toLowerCase()) {
    case "java": return javaLang;
    case "json": return jsonLang;
    case "xml":
    case "html":
    case "pom": return xmlLang;
    default: return null;
  }
}

interface Props {
  initial: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCursor?: (line: number, col: number) => void;
  readOnly?: boolean;
  /** Directory of the file, for resolving relative `<img src>` in HTML blocks. */
  basePath?: string;
}

/** Resolve a possibly-relative asset `src` to a webview-loadable URL. Absolute
 *  URLs / data URIs pass through; a relative path is resolved against `base` and
 *  converted to Tauri's asset:// URL. */
function resolveAsset(base: string | undefined, src: string): string {
  if (!src || /^[a-z]+:/i.test(src) || src.startsWith("//") || src.startsWith("/") || !base) return src;
  const parts = `${base}/${src.replace(/^\.\//, "")}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  try {
    return convertFileSrc("/" + out.join("/"));
  } catch {
    return src;
  }
}

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.6em" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.35em" },
  { tag: t.heading3, fontWeight: "700", fontSize: "1.18em" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700", color: "var(--text-primary)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent-strong)", textDecoration: "underline" },
  { tag: t.url, color: "var(--text-tertiary)" },
  { tag: t.monospace, color: "var(--accent-strong)" },
  { tag: t.quote, color: "var(--text-secondary)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent-strong)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--text-tertiary)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-primary)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
      fontSize: "14.5px",
      lineHeight: "1.7",
    },
    ".cm-content": { padding: "20px 32px 200px", caretColor: "var(--accent)", maxWidth: "824px", margin: "0 auto", boxSizing: "border-box" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(228,85,31,0.2)" },
    ".cm-activeLine": { backgroundColor: "transparent" },
  },
  { dark: false },
);

// Syntax-marker node names hidden in Live Preview (revealed on the cursor's node).
const MARK_NODES = new Set(["EmphasisMark", "CodeMark", "HeaderMark", "QuoteMark", "LinkMark", "URL", "StrikethroughMark"]);

/** A rendered thematic break (`---`). */
class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "md-hr";
    return el;
  }
}

/** A rendered raw-HTML block (e.g. an HTML `<table>`). Click to edit the source. */
type ImgItem = { alt: string; img: string; link?: string };

const LINKED_IMG = /^\[!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)$/;
const PLAIN_IMG = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)$/;

/** If `text` (a paragraph) is nothing but image / linked-image lines, return the
 *  items — a "badge row" to render inline. Otherwise null. */
function imageRowItems(text: string): ImgItem[] | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return null;
  const items: ImgItem[] = [];
  for (const l of lines) {
    const linked = LINKED_IMG.exec(l);
    if (linked) { items.push({ alt: linked[1], img: linked[2], link: linked[3] }); continue; }
    const plain = PLAIN_IMG.exec(l);
    if (plain) { items.push({ alt: plain[1], img: plain[2] }); continue; }
    return null; // a non-image line → not a pure image row
  }
  return items;
}

/** A row of rendered images (badges) laid out inline, replacing an image-only
 *  paragraph so consecutive `![…]` lines don't stack. */
class ImageRowWidget extends WidgetType {
  constructor(readonly items: ImgItem[], readonly basePath?: string) { super(); }
  eq(o: ImageRowWidget) { return o.basePath === this.basePath && JSON.stringify(o.items) === JSON.stringify(this.items); }
  toDOM(view: EditorView) {
    const row = document.createElement("div");
    row.className = "md-img-row md-preview";
    for (const it of this.items) {
      const img = document.createElement("img");
      img.src = resolveAsset(this.basePath, it.img);
      img.alt = it.alt;
      img.className = "md-img";
      if (it.link) {
        const a = document.createElement("a");
        a.href = it.link;
        a.appendChild(img);
        row.appendChild(a);
      } else {
        row.appendChild(img);
      }
    }
    row.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      const pos = view.posAtDOM(row);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return row;
  }
  ignoreEvent() { return false; }
}

/** An inline rendered Markdown image (`![alt](url)`), incl. remote badges. */
class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string, readonly basePath?: string) { super(); }
  eq(o: ImageWidget) { return o.url === this.url && o.alt === this.alt && o.basePath === this.basePath; }
  toDOM() {
    const img = document.createElement("img");
    img.src = resolveAsset(this.basePath, this.url);
    img.alt = this.alt;
    img.className = "md-img";
    img.style.maxWidth = "100%";
    img.style.verticalAlign = "text-bottom";
    return img;
  }
  ignoreEvent() { return false; }
}

class HtmlWidget extends WidgetType {
  constructor(readonly html: string, readonly basePath?: string) { super(); }
  eq(o: HtmlWidget) { return o.html === this.html && o.basePath === this.basePath; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-html md-preview";
    wrap.innerHTML = this.html;
    // Resolve relative image sources against the file's directory so local
    // images (e.g. a README logo) load in the webview.
    wrap.querySelectorAll("img").forEach((img) => {
      const raw = img.getAttribute("src");
      if (raw) img.setAttribute("src", resolveAsset(this.basePath, raw));
    });
    // Click (outside a link) reveals the raw source for editing.
    wrap.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return false; }
}

// --- Diagrams: mermaid (rendered locally) + PlantUML (via a server) ----------

const PLANTUML_SERVER = "https://www.plantuml.com/plantuml";
const DIAGRAM_LANGS = new Set(["mermaid", "plantuml", "puml", "uml"]);

/* eslint-disable @typescript-eslint/no-explicit-any */
let mermaidPromise: Promise<any> | null = null;
function loadMermaid(): Promise<any> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** PlantUML's server URL for a diagram, using hex (`~h`) encoding — no client
 *  compression needed. Note: the diagram text is sent to PLANTUML_SERVER. */
function plantumlUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${PLANTUML_SERVER}/svg/~h${hex}`;
}

let diagramSeq = 0;

/** A rendered diagram block replacing a ```mermaid / ```plantuml fence. */
class DiagramWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) { super(); }
  eq(o: DiagramWidget) { return o.lang === this.lang && o.code === this.code; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-diagram md-preview";

    // Zoom toolbar (top-right, on hover).
    const bar = document.createElement("div");
    bar.className = "cm-diagram-tools";
    bar.addEventListener("mousedown", (e) => e.stopPropagation());

    const scroll = document.createElement("div");
    scroll.className = "cm-diagram-scroll";
    const stage = document.createElement("div");
    stage.className = "cm-diagram-stage";
    stage.textContent = "Rendering diagram…";
    scroll.appendChild(stage);

    // Click on the diagram (not the toolbar) reveals the source for editing.
    scroll.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });

    let zoom = 1;
    let base = 0;
    let userZoomed = false;
    // Fit-to-width: shrink a diagram wider than the pane down to fit; never
    // upscale a small one past its natural size.
    const fitZoom = () => (base ? Math.min(1, Math.max(0.1, (scroll.clientWidth - 4) / base)) : 1);
    const apply = () => {
      const el = stage.querySelector("svg, img") as HTMLElement | null;
      if (el && base) el.style.width = `${Math.round(base * zoom)}px`;
      label.textContent = `${Math.round(zoom * 100)}%`;
    };
    const fit = () => { zoom = fitZoom(); apply(); };
    const setZoom = (z: number) => { userZoomed = true; zoom = Math.min(4, Math.max(0.1, +z.toFixed(2))); apply(); };
    const mk = (txt: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "cm-diagram-btn";
      b.type = "button";
      b.textContent = txt;
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    bar.appendChild(mk("−", "Zoom out", () => setZoom(zoom - 0.25)));
    const label = mk("100%", "Reset zoom (fit to width)", () => { userZoomed = false; fit(); });
    label.classList.add("cm-diagram-reset");
    bar.appendChild(label);
    bar.appendChild(mk("+", "Zoom in", () => setZoom(zoom + 0.25)));

    wrap.appendChild(bar);
    wrap.appendChild(scroll);

    // Re-fit when the pane resizes, unless the user set their own zoom.
    const ro = new ResizeObserver(() => { if (!userZoomed && base) fit(); });
    ro.observe(scroll);
    (wrap as unknown as { _ro?: ResizeObserver })._ro = ro;

    const fail = (msg: string) => {
      bar.remove();
      stage.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "cm-diagram-error";
      pre.textContent = `${msg}\n\n${this.code}`;
      stage.appendChild(pre);
    };

    if (this.lang === "mermaid") {
      const id = `mmd-${diagramSeq++}`;
      loadMermaid()
        .then((m) => m.render(id, this.code))
        .then(({ svg }: { svg: string }) => {
          stage.innerHTML = svg;
          const el = stage.querySelector("svg");
          if (el) {
            base = el.viewBox?.baseVal?.width || el.getBoundingClientRect().width || 640;
            el.removeAttribute("height");
            el.style.maxWidth = "none";
            fit();
          }
        })
        .catch((e: unknown) => fail(`Mermaid error: ${e instanceof Error ? e.message : String(e)}`));
    } else {
      const img = document.createElement("img");
      img.className = "cm-diagram-img";
      img.alt = "PlantUML diagram";
      img.loading = "lazy";
      img.onload = () => { base = img.naturalWidth || 640; stage.textContent = ""; stage.appendChild(img); fit(); };
      img.onerror = () => fail("PlantUML: couldn't render (server unreachable?)");
      img.src = plantumlUrl(this.code);
    }
    return wrap;
  }
  destroy(dom: HTMLElement) {
    (dom as unknown as { _ro?: ResizeObserver })._ro?.disconnect();
  }
  ignoreEvent() { return false; }
}

/** The info string (language) of a fenced code block, lowercased. */
function fenceInfo(doc: EditorState["doc"], from: number): string {
  return doc.lineAt(from).text.replace(/^[`~]+/, "").trim().toLowerCase();
}
/** The inner text of a fenced code block (between the fence lines). */
function fenceCode(doc: EditorState["doc"], from: number, to: number): string {
  const first = doc.lineAt(from);
  const last = doc.lineAt(Math.max(from, to - 1));
  if (last.number <= first.number + 1) return "";
  return doc.sliceString(doc.line(first.number + 1).from, doc.line(last.number - 1).to);
}

/** Obsidian-style inline rendering: hide markdown markers, style content, and
 *  reveal the raw source wherever the selection is. */
function buildDecorations(view: EditorView, basePath?: string): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const { doc } = view.state;
  const sel = view.state.selection;
  const editing = (from: number, to: number) => sel.ranges.some((r) => r.from <= to && r.to >= from);
  const addLine = (pos: number, cls: string) => deco.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const addLines = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      addLine(line.from, cls);
      pos = line.to + 1;
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        // A pure image row is drawn as one block widget — don't also add inline
        // decorations inside it (unless the caret is there, editing the source).
        if (name === "Paragraph") {
          if (!editing(node.from, node.to)) {
            const items = imageRowItems(doc.sliceString(node.from, node.to));
            if (items && (items.length > 1 || items.some((i) => i.link))) return false;
          }
          return;
        }
        if (/^ATXHeading[1-6]$/.test(name)) {
          addLine(node.from, `cm-h${name.slice(-1)}`);
        } else if (name === "Blockquote") {
          addLines(node.from, node.to, "cm-quote");
        } else if (name === "FencedCode" || name === "CodeBlock") {
          const codeEditing = editing(node.from, node.to);
          // A mermaid/plantuml fence renders as a diagram block (from the block
          // decoration field); don't also style it as a code block.
          if (name === "FencedCode" && !codeEditing && DIAGRAM_LANGS.has(fenceInfo(doc, node.from))) {
            return false;
          }
          addLines(node.from, node.to, codeEditing ? "cm-codeblock cm-codeblock-editing" : "cm-codeblock");
          if (name === "FencedCode" && !codeEditing) {
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(Math.max(node.from, node.to - 1));
            if (last.number > first.number) {
              if (first.length) deco.push(Decoration.replace({}).range(first.from, first.to));
              if (last.length) deco.push(Decoration.replace({}).range(last.from, last.to));
            }
          }
        } else if (name === "Image") {
          if (editing(node.from, node.to)) return false;
          const m = PLAIN_IMG.exec(doc.sliceString(node.from, node.to));
          if (m) {
            deco.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1], basePath) }).range(node.from, node.to));
          }
          return false; // don't descend into the image's marks
        } else if (name === "LinkReference") {
          // A link *reference definition* (`[label]: url`) is metadata — hide it
          // from the rendered view (revealed when the caret is on the line).
          if (!editing(node.from, node.to)) addLines(node.from, node.to, "cm-md-refdef");
          return false;
        } else if (name === "InlineCode") {
          deco.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
        } else if (name === "ListMark") {
          deco.push(Decoration.mark({ class: "cm-list-mark" }).range(node.from, node.to));
        } else if (name === "Link") {
          deco.push(Decoration.mark({ class: "cm-md-link" }).range(node.from, node.to));
        } else if (MARK_NODES.has(name)) {
          const parent = node.node.parent;
          if (!parent) return;
          if (name === "CodeMark" && parent.name !== "InlineCode") return;
          if ((name === "LinkMark" || name === "URL") && parent.name !== "Link") return;
          if (editing(parent.from, parent.to)) return;
          let end = node.to;
          if (name === "HeaderMark" || name === "QuoteMark") {
            while (doc.sliceString(end, end + 1) === " ") end++;
          }
          if (end > node.from) deco.push(Decoration.replace({}).range(node.from, end));
        }
      },
    });
  }
  return Decoration.set(deco, true);
}

function livePreview(basePath?: string): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, basePath);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
          this.decorations = buildDecorations(u.view, basePath);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Block widgets (HR, raw-HTML blocks) — these MUST be provided by a StateField,
 *  not a ViewPlugin (CodeMirror forbids block decorations from plugins). */
function buildBlockDecos(state: EditorState, basePath?: string): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const { doc } = state;
  const sel = state.selection;
  // Reveal the raw source only when the caret is *strictly inside* the block, so
  // a block that starts at the very top (caret at 0 on open) still renders.
  const editing = (from: number, to: number) => sel.ranges.some((r) => r.to > from && r.from < to);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "HorizontalRule") {
        if (!editing(node.from, node.to)) {
          deco.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(node.from, node.to));
        }
      } else if (node.name === "HTMLBlock") {
        if (!editing(node.from, node.to)) {
          deco.push(Decoration.replace({ widget: new HtmlWidget(doc.sliceString(node.from, node.to), basePath), block: true }).range(node.from, node.to));
        }
      } else if (node.name === "FencedCode") {
        // ```mermaid / ```plantuml → render as a diagram (reveal source on click).
        if (!editing(node.from, node.to)) {
          const lang = fenceInfo(doc, node.from);
          if (DIAGRAM_LANGS.has(lang)) {
            const code = fenceCode(doc, node.from, node.to).trim();
            if (code) {
              deco.push(Decoration.replace({ widget: new DiagramWidget(lang, code), block: true }).range(node.from, node.to));
              return false;
            }
          }
        }
      } else if (node.name === "Paragraph") {
        // A paragraph of only images (a badge row) → lay them out inline as one
        // block, instead of one stacked line per source line.
        if (!editing(node.from, node.to)) {
          const items = imageRowItems(doc.sliceString(node.from, node.to));
          if (items && (items.length > 1 || items.some((i) => i.link))) {
            deco.push(Decoration.replace({ widget: new ImageRowWidget(items, basePath), block: true }).range(node.from, node.to));
            return false;
          }
        }
      }
    },
  });
  return Decoration.set(deco, true);
}

function makeBlockDecoField(basePath?: string) {
  return StateField.define<DecorationSet>({
    create: (state) => buildBlockDecos(state, basePath),
    update(value, tr) {
      if (tr.docChanged || tr.selection) return buildBlockDecos(tr.state, basePath);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** A single-view Markdown editor with Obsidian-style Live Preview — you edit
 *  inline the moment you open the file. App remounts it per file via `key`. */
export default function MarkdownEditor({ initial, onChange, onSave, onCursor, readOnly, basePath }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown({ base: markdownLanguage, codeLanguages }),
          syntaxHighlighting(mdHighlight),
          // Colour tokens inside fenced code (java/json/xml), theme-aware.
          syntaxHighlighting(document.documentElement.dataset.theme === "dark" ? darkHighlightStyle : highlightStyle),
          EditorView.lineWrapping,
          livePreview(basePath),
          makeBlockDecoField(basePath),
          search({ top: true, createPanel: (v) => new QuickSearchPanel(v) }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              onCursorRef.current?.(line.number, head - line.from + 1);
            }
          }),
        ],
      }),
    });
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="md-cm h-full overflow-hidden" />;
}
