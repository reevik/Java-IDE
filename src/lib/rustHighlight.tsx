import { rustLanguage } from "@codemirror/lang-rust";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { type ReactNode } from "react";

/** Token classes (styled in App.css) mirroring the editor's highlight colors. */
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.self], class: "tok-kw" },
  { tag: [t.string, t.special(t.string), t.character], class: "tok-str" },
  { tag: [t.lineComment, t.blockComment], class: "tok-com" },
  { tag: [t.number, t.bool, t.atom], class: "tok-num" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: "tok-type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-fn" },
  { tag: [t.meta, t.macroName, t.annotation], class: "tok-macro" },
  { tag: [t.operator, t.punctuation, t.bracket, t.derefOperator], class: "tok-op" },
  { tag: [t.propertyName], class: "tok-prop" },
]);

/** Statically syntax-highlight a Rust snippet into React spans (no editor). */
export function highlightRust(code: string): ReactNode[] {
  const tree = rustLanguage.parser.parse(code);
  const out: ReactNode[] = [];
  let pos = 0;
  let key = 0;
  highlightTree(tree, highlighter, (from, to, cls) => {
    if (from > pos) out.push(code.slice(pos, from));
    out.push(
      <span key={key++} className={cls}>
        {code.slice(from, to)}
      </span>,
    );
    pos = to;
  });
  if (pos < code.length) out.push(code.slice(pos));
  return out;
}
