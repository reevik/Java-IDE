import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from "@codemirror/search";

function input(value: string, placeholder: string): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "cm-textfield";
  el.value = value;
  el.placeholder = placeholder;
  el.spellcheck = false;
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocapitalize", "off");
  return el;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "cm-button";
  el.textContent = label;
  el.title = title;
  el.onclick = (e) => {
    e.preventDefault();
    onClick();
  };
  return el;
}

/** A search/replace panel that searches as you type and shows a live match
 *  count ("3 of 12" / "No results"), plus prev/next, case/regex/word toggles,
 *  and replace. Wired to the standard @codemirror/search state + commands. */
export class QuickSearchPanel implements Panel {
  dom: HTMLElement;
  top = true;

  private view: EditorView;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseChk: HTMLInputElement;
  private reChk: HTMLInputElement;
  private wordChk: HTMLInputElement;
  private count: HTMLElement;

  constructor(view: EditorView) {
    this.view = view;
    const q = getSearchQuery(view.state);

    this.dom = document.createElement("div");
    this.dom.className = "cm-search cm-panel cm-qsearch";
    this.dom.onkeydown = (e) => this.onKey(e);

    this.searchField = input(q.search, "Find");
    this.searchField.setAttribute("main-field", "true"); // CM focuses this on open
    this.searchField.oninput = () => this.commit();

    this.count = document.createElement("span");
    this.count.className = "cm-qsearch-count";

    const check = (labelText: string, title: string, on: boolean): HTMLLabelElement => {
      const wrap = document.createElement("label");
      wrap.className = "cm-qsearch-check";
      wrap.title = title;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = on;
      box.onchange = () => this.commit();
      wrap.append(box, document.createTextNode(labelText));
      (wrap as unknown as { box: HTMLInputElement }).box = box;
      return wrap;
    };
    const caseWrap = check("Match case", "Match case", q.caseSensitive);
    const reWrap = check("Regex", "Regular expression", q.regexp);
    const wordWrap = check("Whole word", "Whole word", q.wholeWord);
    this.caseChk = (caseWrap as unknown as { box: HTMLInputElement }).box;
    this.reChk = (reWrap as unknown as { box: HTMLInputElement }).box;
    this.wordChk = (wordWrap as unknown as { box: HTMLInputElement }).box;

    const prev = button("‹", "Previous match (⇧⏎)", () => findPrevious(this.view));
    const next = button("›", "Next match (⏎)", () => findNext(this.view));
    const close = button("✕", "Close (Esc)", () => closeSearchPanel(this.view));
    close.classList.add("cm-qsearch-close");

    const controls1 = document.createElement("div");
    controls1.className = "cm-qsearch-controls";
    controls1.append(caseWrap, reWrap, wordWrap, prev, next, close);

    this.replaceField = input(q.replace, "Replace");
    const replace = button("Replace", "Replace next match", () => {
      this.commit();
      replaceNext(this.view);
    });
    const replaceAllBtn = button("Replace all", "Replace all matches", () => {
      this.commit();
      replaceAll(this.view);
    });
    const controls2 = document.createElement("div");
    controls2.className = "cm-qsearch-controls";
    controls2.append(replace, replaceAllBtn);

    // The count floats inside the search field's right edge; both inputs reserve the
    // same right padding, so they stay identical and the box extends right up to the
    // controls (only a small gap between).
    const fieldWrap = document.createElement("div");
    fieldWrap.className = "cm-qsearch-field";
    fieldWrap.append(this.searchField, this.count);

    // Grid: [ input | controls ] × 2 rows. Inputs share the 1fr column (equal width,
    // filling the width); controls hug the right and align across both rows.
    this.dom.append(fieldWrap, controls1, this.replaceField, controls2);
  }

  mount() {
    this.searchField.focus();
    this.searchField.select();
    this.updateCount();
  }

  update(u: ViewUpdate) {
    // Recompute the count/current-index on edits, cursor moves, and query changes.
    if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) {
      this.updateCount();
    }
  }

  private query(): SearchQuery {
    return new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseChk.checked,
      regexp: this.reChk.checked,
      wholeWord: this.wordChk.checked,
    });
  }

  private commit() {
    this.view.dispatch({ effects: setSearchQuery.of(this.query()) });
    this.updateCount();
  }

  private updateCount() {
    const q = this.query();
    this.count.classList.remove("cm-qsearch-none");
    if (!q.valid) {
      // Empty query, or a regex still being typed — nothing to report.
      this.count.textContent = this.searchField.value && this.reChk.checked ? "…" : "";
      return;
    }
    const main = this.view.state.selection.main;
    let total = 0;
    let current = 0;
    try {
      const cursor = q.getCursor(this.view.state);
      for (let it = cursor.next(); !it.done; it = cursor.next()) {
        total++;
        if (it.value.from === main.from && it.value.to === main.to) current = total;
      }
    } catch {
      this.count.textContent = "…";
      return;
    }
    if (total === 0) {
      this.count.textContent = "0";
      this.count.classList.add("cm-qsearch-none");
    } else {
      // Compact so it fits inside the field (e.g. "3/12", or just "12").
      this.count.textContent = current ? `${current}/${total}` : `${total}`;
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target === this.searchField) {
      e.preventDefault();
      if (e.shiftKey) findPrevious(this.view);
      else findNext(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      this.commit();
      replaceNext(this.view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(this.view);
    }
  }
}
