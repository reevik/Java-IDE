import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import { aiBackend, chatAgent, chatCancel, chatSend, type ChatMsg } from "../lib/api";
import Markdown from "./Markdown";

interface Props {
  /** Active file, sent as grounding context, or null. */
  file: { path: string; name: string; content: string } | null;
  /** Project root, so the chat can see the whole project's source. */
  root: string | null;
  /** Resolve a cited path/filename to a real absolute file path, or null. */
  resolveRef: (cited: string) => string | null;
  /** Open a resolved source path at an optional 1-based line. */
  onOpen: (path: string, line?: number) => void;
  /** Apply a code block to the focused editor; returns what it did. */
  onApplyCode?: (code: string, lang: string) => "applied" | "inserted" | "none";
  /** Called after the agent may have edited files on disk, to reload buffers. */
  onWorkspaceChanged?: () => void;
  /** Toggled true while an agent run is in progress (drives collaborative view). */
  onAgentActive?: (active: boolean) => void;
}

/** "AI Assistant" — a conversational Java pair-programmer, grounded in the open file + project. */
export default function ChatPanel({ file, root, resolveRef, onOpen, onApplyCode, onWorkspaceChanged, onAgentActive }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [pending, setPending] = useState(false);
  // The agent's current activity (e.g. "Editing files"), shown as one live line.
  const [activity, setActivity] = useState("");
  // "Plan first": for big changes, propose a plan and wait for approval.
  const [planFirst, setPlanFirst] = useState(() => localStorage.getItem("ai.planFirst") === "1");
  const [pendingPlan, setPendingPlan] = useState<{ baseMsgs: ChatMsg[] } | null>(null);
  // When the agent needs to know the scope (this file vs whole project), it asks.
  const [clarify, setClarify] = useState<{ question: string; options: string[] } | null>(null);

  const { data: backend } = useQuery({ queryKey: ["ai-backend"], queryFn: aiBackend });
  const noBackend = backend === "none";
  // Agent mode (CLI edits files itself) when the CLI backend + a project are present.
  const agentMode = backend === "cli";

  const fileRef = useRef(file);
  fileRef.current = file;
  const rootRef = useRef(root);
  rootRef.current = root;
  const agentRef = useRef(agentMode);
  agentRef.current = agentMode;
  const planFirstRef = useRef(planFirst);
  planFirstRef.current = planFirst;
  const onWorkspaceChangedRef = useRef(onWorkspaceChanged);
  onWorkspaceChangedRef.current = onWorkspaceChanged;
  const onAgentActiveRef = useRef(onAgentActive);
  onAgentActiveRef.current = onAgentActive;
  const togglePlanFirst = () =>
    setPlanFirst((v) => {
      localStorage.setItem("ai.planFirst", v ? "0" : "1");
      return !v;
    });
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    const un = listen<string>("ai:chat-progress", (e) => setStreaming(e.payload));
    return () => void un.then((off) => off());
  }, []);
  useEffect(() => {
    const un = listen<string>("ai:chat-status", (e) => setActivity(e.payload));
    return () => void un.then((off) => off());
  }, []);
  // Clear the activity line whenever the agent stops working.
  useEffect(() => {
    if (!pending) setActivity("");
  }, [pending]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  const sendText = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || pendingRef.current || noBackend) return;
      const next: ChatMsg[] = [...messagesRef.current, { role: "user", content: t }];
      setMessages(next);
      setStreaming("");
      setPending(true);
      setPendingPlan(null);
      setClarify(null);
      const useAgent = agentRef.current && !!rootRef.current;
      const root = rootRef.current!;
      const fp = fileRef.current?.path ?? null;
      if (useAgent) onAgentActiveRef.current?.(true);
      // Finish an agent turn: if it asked to clarify scope, show options; else show
      // the reply and (when it may have edited) reload the workspace.
      const finish = (base: ChatMsg[], reply: string, didEdit: boolean) => {
        const clar = parseClarify(reply);
        if (clar) {
          setMessages([...base, { role: "assistant", content: clar.question }]);
          setClarify(clar);
        } else {
          setMessages([...base, { role: "assistant", content: reply }]);
          if (didEdit) onWorkspaceChangedRef.current?.();
        }
      };
      try {
        if (useAgent && planFirstRef.current) {
          // Plan phase (no edits): assess size + propose a plan.
          const plan = await chatAgent(next, root, fp, true);
          if (parseClarify(plan)) {
            finish(next, plan, false);
            return;
          }
          const planBody = plan.replace(/^\s*SCALE:\s*(small|large)\s*/i, "").trim() || plan.trim();
          if (/SCALE:\s*large/i.test(plan)) {
            // Big change → show the plan and wait for approval.
            const withPlan: ChatMsg[] = [...next, { role: "assistant", content: planBody }];
            setMessages(withPlan);
            setPendingPlan({ baseMsgs: withPlan });
            return;
          }
          // Small change → execute now.
          const reply = await chatAgent([...next, { role: "assistant", content: planBody }, { role: "user", content: "Proceed and make the change." }], root, fp, false);
          finish(next, reply, true);
        } else if (useAgent) {
          const reply = await chatAgent(next, root, fp, false);
          finish(next, reply, true);
        } else {
          const reply = await chatSend(next, fileRef.current?.content ?? null, rootRef.current);
          setMessages([...next, { role: "assistant", content: reply }]);
        }
      } catch (e) {
        setMessages([...next, { role: "assistant", content: `⚠️ ${errText(e)}` }]);
      } finally {
        setPending(false);
        setStreaming("");
        if (useAgent) onAgentActiveRef.current?.(false);
      }
    },
    [noBackend],
  );

  // "Explain" from a diagnostic hover (or elsewhere) asks Vibe Coder directly.
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string") void sendText(detail);
    };
    window.addEventListener("rustade:vibe-ask", h);
    return () => window.removeEventListener("rustade:vibe-ask", h);
  }, [sendText]);

  function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void sendText(text);
  }

  // Approve a proposed plan → execute it (agent edits files).
  const approvePlan = async () => {
    const base = pendingPlan?.baseMsgs;
    if (!base) return;
    setPendingPlan(null);
    setPending(true);
    setStreaming("");
    onAgentActiveRef.current?.(true);
    try {
      const reply = await chatAgent([...base, { role: "user", content: "Approved — execute the plan now." }], rootRef.current!, fileRef.current?.path ?? null, false);
      const clar = parseClarify(reply);
      if (clar) {
        setMessages([...base, { role: "assistant", content: clar.question }]);
        setClarify(clar);
      } else {
        setMessages([...base, { role: "assistant", content: reply }]);
        onWorkspaceChangedRef.current?.();
      }
    } catch (e) {
      setMessages([...base, { role: "assistant", content: `⚠️ ${errText(e)}` }]);
    } finally {
      setPending(false);
      setStreaming("");
      onAgentActiveRef.current?.(false);
    }
  };

  return (
    <aside className="agent-pane flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
        <BoltIcon />
        <h2 className="flex-1 text-[12.5px] font-semibold text-[var(--text-primary)]" data-tauri-drag-region>
          AI Assistant
        </h2>
        {messages.length > 0 && (
          <button
            onClick={() => { setMessages([]); setStreaming(""); }}
            className="btn-bezel px-2 py-0.5 text-[11px]"
          >
            Clear
          </button>
        )}
        <BackendBadge backend={backend} />
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {noBackend ? (
          <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-[11px] leading-relaxed text-yellow-800">
            No AI backend. Install the <code className="rounded bg-black/10 px-1">claude</code> CLI, or add an
            Anthropic API key in Settings.
          </p>
        ) : messages.length === 0 && !pending ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-[12.5px] font-medium text-[var(--text-secondary)]">Let's build something.</p>
            <p className="max-w-[230px] text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
              {agentMode
                ? "Describe a change and I'll edit the files directly — then your open tabs refresh with the result."
                : "Ask about the open file, request a change, or paste an error. I've got the current file as context."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} text={m.content} resolveRef={resolveRef} onOpen={onOpen} onApplyCode={agentMode ? undefined : onApplyCode} />
            ))}
            {pending && <Bubble role="assistant" text={streaming} pending activity={activity} resolveRef={resolveRef} onOpen={onOpen} />}
          </div>
        )}
      </div>

      {clarify && (
        <div className="shrink-0 border-t border-[color:var(--line)] bg-[var(--accent-soft)] px-3 py-2">
          <p className="mb-1.5 text-[11px] text-[var(--text-secondary)]">Pick one (or type your own answer):</p>
          <div className="flex flex-col gap-1.5">
            {clarify.options.map((opt, i) => (
              <button
                key={i}
                onClick={() => { setClarify(null); void sendText(opt); }}
                className="btn-bezel px-3 py-1 text-left text-[12px]"
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingPlan && (
        <div className="shrink-0 border-t border-[color:var(--line)] bg-[var(--accent-soft)] px-3 py-2">
          <p className="mb-1.5 text-[11px] text-[var(--text-secondary)]">Review the plan above. Proceed?</p>
          <div className="flex gap-2">
            <button onClick={() => void approvePlan()} className="btn-accent px-3 py-1 text-[12px]">
              Approve &amp; Execute
            </button>
            <button onClick={() => setPendingPlan(null)} className="btn-bezel px-3 py-1 text-[12px]">
              Cancel
            </button>
          </div>
        </div>
      )}

      {agentMode && (
        <label className="flex shrink-0 items-center gap-1.5 border-t border-[color:var(--line)] px-3 py-1 text-[11px] text-[var(--text-secondary)]">
          <input type="checkbox" checked={planFirst} onChange={togglePlanFirst} className="accent-[var(--accent)]" />
          Plan first for big changes
        </label>
      )}

      <form
        className="shrink-0 border-t border-[color:var(--line)] p-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={file ? `Ask about ${file.name}…` : "Ask the AI Assistant…"}
            rows={2}
            disabled={noBackend}
            className="field block max-h-40 min-h-[46px] w-full resize-none py-2 pl-2.5 pr-16 text-[12.5px] leading-relaxed disabled:opacity-50"
          />
          {pending ? (
            <button
              type="button"
              onClick={() => void chatCancel()}
              title="Stop the agent"
              className="btn-bezel absolute bottom-2 right-2 flex items-center gap-1 px-2.5 py-1 text-[12px] text-red-500"
            >
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-red-500" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || noBackend}
              title="Send (Enter · Shift+Enter for newline)"
              className="btn-accent absolute bottom-2 right-2 px-2.5 py-1 text-[12px] disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function Bubble({ role, text, pending, activity, resolveRef, onOpen, onApplyCode }: { role: "user" | "assistant"; text: string; pending?: boolean; activity?: string; resolveRef: (cited: string) => string | null; onOpen: (path: string, line?: number) => void; onApplyCode?: (code: string, lang: string) => "applied" | "inserted" | "none" }) {
  const user = role === "user";
  return (
    <div className={`flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={`min-w-0 break-words rounded-2xl px-3 py-2 text-[12px] leading-relaxed ${
          user
            ? "max-w-[85%] bg-[var(--accent-soft)] text-[var(--text-primary)]"
            : "w-full border border-[color:var(--line)] bg-[var(--surface-2)] text-[var(--text-primary)]"
        }`}
      >
        {text ? (
          <>
            <Markdown text={text} resolveRef={resolveRef} onOpen={onOpen} onApplyCode={!user ? onApplyCode : undefined} />
            {pending && !user && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
          </>
        ) : pending ? (
          <span className="flex items-center gap-1.5 text-[var(--text-tertiary)]">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent-soft)] border-t-[var(--accent)]" />
            {activity ? `${activity}…` : "Thinking…"}
          </span>
        ) : null}
        {/* Once text is streaming, keep the current activity as a single live line. */}
        {text && pending && !user && activity && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent-soft)] border-t-[var(--accent)]" />
            {activity}…
          </p>
        )}
      </div>
    </div>
  );
}

/** Parse an agent `CLARIFY:` reply into a question + selectable options. */
function parseClarify(reply: string): { question: string; options: string[] } | null {
  const m = /^\s*CLARIFY:\s*(.+)/i.exec(reply);
  if (!m) return null;
  const question = m[1].trim();
  const options = reply
    .split("\n")
    .map((l) => l.match(/^\s*-\s+(.*\S)\s*$/)?.[1])
    .filter((s): s is string => !!s)
    .slice(0, 4);
  return { question, options };
}

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : typeof e === "string" ? e : e == null ? "" : String(e);
  return s.trim() || "Something went wrong.";
}

function BackendBadge({ backend }: { backend?: string }) {
  if (!backend) return null;
  const label = backend === "cli" ? "Agent" : backend === "api" ? "API key" : "offline";
  const tone = backend === "none" ? "bg-black/10 text-[var(--text-tertiary)]" : "bg-green-400/15 text-green-700";
  return <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${tone}`}>{label}</span>;
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
      <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" />
    </svg>
  );
}
