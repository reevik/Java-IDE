import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery } from "@tanstack/react-query";
import { aiBackend, explainCode, reviewCode } from "../lib/api";
import { parsePartialJson } from "../lib/partialJson";
import type { Quality, Review, Suggestion } from "../lib/types";

interface Props {
  /** Active file, or null when nothing is open. */
  file: { path: string; name: string; content: string } | null;
  /** Currently selected text in the editor, "" if none. */
  selection: string;
  /** Apply a suggestion: replace `original` with `replacement` in the file. */
  onApply: (original: string, replacement: string) => void;
}

/** Review is the default; ⌘⇧E explains the selection/file. */
type Mode = "review" | "explain";

export default function AiPanel({ file, selection, onApply }: Props) {
  const [mode, setMode] = useState<Mode>("review");
  const [streaming, setStreaming] = useState<Partial<Review> | null>(null);
  const [explainText, setExplainText] = useState("");
  const [applied, setApplied] = useState<Set<number>>(new Set());
  // Reviews/errors cached per file path, so switching tabs shows that file's last
  // analysis. `reviewingPath` is the file whose review is currently in-flight.
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewingPath, setReviewingPath] = useState<string | null>(null);

  const { data: backend } = useQuery({ queryKey: ["ai-backend"], queryFn: aiBackend });
  const noBackend = backend === "none";

  const review = useMutation<Review, Error, { path: string; code: string }>({
    mutationFn: ({ path, code }) => reviewCode(path, code),
    onMutate: ({ path }) => {
      setReviewingPath(path);
      setStreaming(null);
    },
    onSuccess: (data, { path }) => {
      setReviews((prev) => ({ ...prev, [path]: data }));
      setErrors((prev) => {
        const n = { ...prev };
        delete n[path];
        return n;
      });
      setApplied(new Set());
    },
    onError: (err, { path }) => setErrors((prev) => ({ ...prev, [path]: errText(err) })),
    onSettled: () => {
      setReviewingPath(null);
      setStreaming(null);
    },
  });
  const explain = useMutation<string, Error, { label: string; code: string }>({
    mutationFn: ({ label, code }) => explainCode(label, code),
  });

  const fileRef = useRef(file);
  fileRef.current = file;
  const selRef = useRef(selection);
  selRef.current = selection;

  // On file switch: clear transient explain output + applied markers, but KEEP the
  // per-file review cache so returning to a tab shows its last analysis.
  useEffect(() => {
    explain.reset();
    setExplainText("");
    setApplied(new Set());
    setMode("review");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path]);

  // Streaming decoders.
  useEffect(() => {
    const un = listen<string>("ai:review-progress", (e) => setStreaming(parsePartialJson<Review>(e.payload)));
    return () => void un.then((off) => off());
  }, []);
  useEffect(() => {
    const un = listen<string>("ai:text-progress", (e) => setExplainText(e.payload));
    return () => void un.then((off) => off());
  }, []);

  // Trigger a review of the current file (manual only — no auto-analysis).
  const runReview = () => {
    const f = fileRef.current;
    if (!f || noBackend || review.isPending) return;
    setMode("review");
    review.mutate({ path: f.path, code: f.content });
  };

  // Palette / menu triggers.
  useEffect(() => {
    const doReview = () => runReview();
    const doExplain = () => {
      const f = fileRef.current;
      if (!f || noBackend || explain.isPending) return;
      const sel = selRef.current.trim();
      setMode("explain");
      setExplainText("");
      explain.mutate({ label: sel ? "selection" : "file", code: sel || f.content });
    };
    window.addEventListener("rustade:ai-review", doReview);
    window.addEventListener("rustade:ai-explain", doExplain);
    return () => {
      window.removeEventListener("rustade:ai-review", doReview);
      window.removeEventListener("rustade:ai-explain", doExplain);
    };
  }, [noBackend, review, explain]);

  function apply(i: number, s: Suggestion) {
    if (!s.original || !fileRef.current?.content.includes(s.original)) return;
    onApply(s.original, s.replacement);
    setApplied((prev) => new Set(prev).add(i));
  }

  // Everything below is bound to the CURRENT file: its in-flight stream (if it's the
  // one being reviewed), else its cached result / error.
  const inFlight = !!file && reviewingPath === file.path;
  const cached = file ? reviews[file.path] : undefined;
  const shown = (inFlight ? streaming : null) ?? cached;
  const reviewError = file ? errors[file.path] : undefined;
  const suggestions = (shown?.suggestions ?? []).filter(
    (s) => s && typeof s.title === "string" && typeof s.replacement === "string",
  );
  const busy = mode === "review" ? inFlight : explain.isPending;

  return (
    <aside className="agent-pane flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
        <SparkIcon />
        <h2 className="flex-1 text-[12.5px] font-semibold text-[var(--text-primary)]" data-tauri-drag-region>
          Intelligent Review
        </h2>
        <BackendBadge backend={backend} />
      </header>

      <p className="shrink-0 px-3 pb-2 text-[10.5px] text-[var(--text-tertiary)]">
        <Key on={mode === "review"}>⌘⇧A</Key> Review · <Key on={mode === "explain"}>⌘⇧E</Key> Explain
      </p>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
        {noBackend && (
          <p className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-[11px] leading-relaxed text-yellow-800">
            No AI backend. Install the <code className="rounded bg-black/10 px-1">claude</code> CLI, or add an
            Anthropic API key in Settings.
          </p>
        )}
        {!file && !noBackend && <p className="text-[12px] text-[var(--text-tertiary)]">Open a file to get started.</p>}
        {busy && (
          <p className="mb-3 text-[11.5px] text-[var(--text-tertiary)]">
            {mode === "review" ? "Reviewing the file…" : "Thinking…"}
          </p>
        )}

        {mode === "review" ? (
          <>
            {reviewError && <ErrorNote message={reviewError} />}
            {shown && (
              <div className="flex flex-col gap-3">
                {shown.quality?.score ? <QualityCard q={shown.quality} /> : null}
                {shown.summary && (
                  <p className="text-[12px] italic leading-relaxed text-[var(--text-secondary)]">{shown.summary}</p>
                )}
                {suggestions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                      Click to apply
                    </p>
                    {suggestions.map((s, i) => {
                      const isApplied = applied.has(i);
                      const canApply = !!s.original && (file?.content.includes(s.original) ?? false);
                      return (
                        <button
                          key={i}
                          onClick={() => apply(i, s)}
                          disabled={isApplied || !canApply}
                          title={isApplied ? "Applied" : canApply ? "Apply this change" : "Original code not found (edited?)"}
                          className={`card p-2.5 text-left transition-colors ${
                            isApplied ? "opacity-55" : canApply ? "cursor-pointer hover:border-[var(--accent)]" : "cursor-not-allowed opacity-55"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <KindTag kind={s.kind} />
                              <span className="truncate text-[12px] font-semibold text-[var(--text-primary)]">{s.title}</span>
                            </span>
                            <span className={`shrink-0 text-[10px] font-semibold ${isApplied ? "text-green-600" : canApply ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}`}>
                              {isApplied ? "Applied ✓" : canApply ? "Apply →" : "n/a"}
                            </span>
                          </div>
                          {s.detail && <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{s.detail}</p>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {!inFlight && shown && suggestions.length === 0 && shown.quality?.score ? (
                  <p className="text-[12px] text-[var(--text-tertiary)]">No changes suggested — looks solid.</p>
                ) : null}
                {/* Re-run on demand once a result exists. */}
                {!inFlight && file?.path.endsWith(".rs") && !noBackend && (
                  <button onClick={runReview} className="btn-bezel w-full py-1.5 text-[12px]">
                    Re-run review
                  </button>
                )}
              </div>
            )}
            {/* No cached result yet → the user triggers the first analysis. */}
            {!shown && !busy && file?.path.endsWith(".rs") && !noBackend && (
              <div className="flex flex-col gap-2">
                <p className="text-[12px] text-[var(--text-tertiary)]">No analysis yet for this file.</p>
                <button onClick={runReview} className="btn-accent w-full py-1.5 text-[12px]">
                  Review this file
                </button>
              </div>
            )}
            {file && !file.path.endsWith(".rs") && !noBackend && (
              <p className="text-[12px] text-[var(--text-tertiary)]">Open a Java file to review.</p>
            )}
          </>
        ) : (
          <>
            {explain.isError && <ErrorNote message={errText(explain.error)} />}
            {explainText ? (
              <div className="prose-mini whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-primary)]">
                {explainText}
              </div>
            ) : (
              !busy && (
                <p className="text-[12px] text-[var(--text-tertiary)]">
                  Press ⌘⇧E to explain the selection, or the whole file if nothing is selected.
                </p>
              )
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function QualityCard({ q }: { q: Quality }) {
  const tone = q.score >= 75 ? "text-green-600" : q.score >= 50 ? "text-yellow-600" : "text-red-500";
  const bar = q.score >= 75 ? "bg-green-500" : q.score >= 50 ? "bg-yellow-500" : "bg-red-400";
  return (
    <div className="card p-2.5">
      <div className="flex items-center gap-2">
        <Stars score={q.score} />
        <span className={`text-[15px] font-semibold tabular-nums ${tone}`}>{q.score}%</span>
      </div>
      {q.verdict && <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">{q.verdict}</p>}
      <div className="mt-2 flex flex-col gap-1">
        {(
          [
            ["Correctness", q.correctness],
            ["Idiomatic", q.idiomatic],
            ["Clarity", q.clarity],
            ["Error handling", q.error_handling],
          ] as const
        )
          .filter(([, v]) => v > 0)
          .map(([label, v]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-[92px] shrink-0 text-[10px] text-[var(--text-tertiary)]">{label}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-black/10">
                <span className={`block h-full rounded-full ${bar}`} style={{ width: `${v}%` }} />
              </span>
              <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]">{v}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

function Stars({ score }: { score: number }) {
  const row = (fill: string) => (
    <span className="flex gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" width="14" height="14" className={fill}>
          <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4 6.2 20.5l1.1-6.5L2.6 9.4l6.5-.9z" fill="currentColor" />
        </svg>
      ))}
    </span>
  );
  return (
    <span className="relative inline-flex" title={`${score} / 100`}>
      {row("text-black/12")}
      <span className="absolute left-0 top-0 overflow-hidden" style={{ width: `${Math.max(0, Math.min(100, score))}%` }}>
        {row("text-yellow-500")}
      </span>
    </span>
  );
}

const KIND_TONE: Record<string, string> = {
  bug: "bg-red-500/15 text-red-600",
  perf: "bg-orange-500/15 text-orange-600",
  refactor: "bg-indigo-500/15 text-indigo-600",
  idiom: "bg-violet-500/15 text-violet-600",
  style: "bg-[var(--surface-2)] text-[var(--text-tertiary)]",
  docs: "bg-sky-500/15 text-sky-600",
};

function KindTag({ kind }: { kind: string }) {
  if (!kind) return null;
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${KIND_TONE[kind] ?? "bg-[var(--surface-2)] text-[var(--text-tertiary)]"}`}>
      {kind}
    </span>
  );
}

/** Robustly stringify a thrown value — Tauri rejects invoke() with a raw string,
 *  which has no `.message`, so `error.message` would render blank. */
function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : typeof e === "string" ? e : e == null ? "" : String(e);
  return s.trim() || "Something went wrong.";
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-700">
      {message.trim() || "Something went wrong."}
    </p>
  );
}

function Key({ children, on }: { children: ReactNode; on: boolean }) {
  return (
    <kbd className={`rounded px-1 py-0.5 font-sans text-[10px] ${on ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "bg-[var(--surface-2)] text-[var(--text-tertiary)]"}`}>
      {children}
    </kbd>
  );
}

function BackendBadge({ backend }: { backend?: string }) {
  if (!backend) return null;
  const label = backend === "cli" ? "Claude CLI" : backend === "api" ? "API key" : "offline";
  const tone = backend === "none" ? "bg-black/10 text-[var(--text-tertiary)]" : "bg-green-400/15 text-green-700";
  return <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${tone}`}>{label}</span>;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6z" />
    </svg>
  );
}
