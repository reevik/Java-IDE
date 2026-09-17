import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import Resizer from "./Resizer";

const PLANTUML_SERVER = "https://www.plantuml.com/plantuml";

/** PlantUML server hex encoding (`~h<hex>`) — no compression lib needed. */
function plantumlUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${PLANTUML_SERVER}/svg/~h${hex}`;
}

interface Props {
  initial: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCursor?: (line: number, col: number) => void;
  readOnly?: boolean;
}

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: "13px", lineHeight: "1.6" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--text-tertiary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(228,85,31,0.2)" },
  ".cm-activeLine": { backgroundColor: "rgba(0,0,0,0.03)" },
});

/** A split view for PlantUML files: the source on the left, the live-rendered
 *  diagram on the right (fit-to-width by default, with zoom + drag-to-pan). */
export default function PlantUmlEditor({ initial, onChange, onSave, onCursor, readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;

  const [code, setCode] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  const [codeWidth, setCodeWidth] = useState(() => {
    const v = Number(localStorage.getItem("puml.codeWidth"));
    return v >= 240 ? v : 460;
  });
  useEffect(() => localStorage.setItem("puml.codeWidth", String(codeWidth)), [codeWidth]);

  // Debounce the preview so it doesn't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 450);
    return () => clearTimeout(t);
  }, [code]);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          search({ top: true }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              setCode(text);
              onChangeRef.current(text);
            }
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

  return (
    <div className="flex h-full min-h-0">
      <div ref={hostRef} className="min-h-0 min-w-0 shrink-0 overflow-hidden" style={{ width: codeWidth }} />
      <Resizer width={codeWidth} setWidth={setCodeWidth} dir={1} min={240} max={Math.max(400, window.innerWidth - 360)} onReset={() => setCodeWidth(460)} />
      <div className="min-h-0 min-w-0 flex-1 border-l border-[color:var(--line)]">
        <PlantUmlPreview code={debounced} />
      </div>
    </div>
  );
}

function PlantUmlPreview({ code }: { code: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const [userZoomed, setUserZoomed] = useState(false);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const baseRef = useRef(0); // natural width of the rendered SVG

  const empty = !code.trim() || !/@start\w+/i.test(code);

  const applyFit = () => {
    const el = scrollRef.current;
    const img = imgRef.current;
    if (!el || !img || !baseRef.current) return;
    const fit = Math.min(1, Math.max(0.1, (el.clientWidth - 8) / baseRef.current));
    setZoom(fit);
  };

  useEffect(() => {
    setStatus(empty ? "ok" : "loading");
    setUserZoomed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (!userZoomed) applyFit(); });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userZoomed]);

  const width = baseRef.current ? Math.round(baseRef.current * zoom) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[color:var(--line)] px-2">
        <span className="text-[11px] text-[var(--text-tertiary)]">Preview</span>
        <div className="ml-auto flex items-center gap-0.5">
          <ZoomBtn onClick={() => { setUserZoomed(true); setZoom((z) => Math.max(0.1, +(z - 0.25).toFixed(2))); }}>−</ZoomBtn>
          <button
            onClick={() => { setUserZoomed(false); applyFit(); }}
            title="Fit to width"
            className="min-w-[42px] rounded px-1 py-0.5 text-center text-[10.5px] tabular-nums text-[var(--text-secondary)] hover:bg-[var(--hover)]"
          >
            {Math.round(zoom * 100)}%
          </button>
          <ZoomBtn onClick={() => { setUserZoomed(true); setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2))); }}>+</ZoomBtn>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-[var(--surface-2)] p-2">
        {empty ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--text-tertiary)]">Write a diagram between <code className="font-mono">@startuml</code> and <code className="font-mono">@enduml</code>.</p>
        ) : status === "error" ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--danger,#c22)]">Couldn’t render — check the syntax, or the PlantUML server may be unreachable.</p>
        ) : null}
        {!empty && (
          <img
            ref={imgRef}
            src={plantumlUrl(code)}
            alt="PlantUML diagram"
            style={{ width, maxWidth: "none", display: status === "error" ? "none" : "block", margin: "0 auto" }}
            onLoad={(e) => {
              baseRef.current = e.currentTarget.naturalWidth || 640;
              setStatus("ok");
              if (!userZoomed) applyFit();
            }}
            onError={() => setStatus("error")}
          />
        )}
      </div>
    </div>
  );
}

function ZoomBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="grid h-5 w-5 place-items-center rounded text-[13px] text-[var(--text-secondary)] hover:bg-[var(--hover)]">
      {children}
    </button>
  );
}
