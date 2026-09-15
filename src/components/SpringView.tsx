import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { springOverview, type SpringBean } from "../lib/api";

interface Props {
  root: string;
  onOpen: (path: string, line: number) => void;
}

const BEAN_META: Record<string, { label: string; letter: string; color: string }> = {
  component: { label: "Components", letter: "C", color: "#0a66c2" },
  service: { label: "Services", letter: "S", color: "#1a7f37" },
  repository: { label: "Repositories", letter: "R", color: "#8250df" },
  controller: { label: "Controllers", letter: "W", color: "#c2410c" },
  configuration: { label: "Configuration", letter: "K", color: "#6b7280" },
  bean: { label: "@Bean methods", letter: "B", color: "#b45309" },
};
const BEAN_ORDER = ["controller", "service", "repository", "component", "configuration", "bean"];

const METHOD_COLOR: Record<string, string> = {
  GET: "#1a7f37", POST: "#0a66c2", PUT: "#b45309", DELETE: "#c22", PATCH: "#8250df", ANY: "#6b7280",
};

/** The Spring panel: beans (stereotypes + @Bean methods) and REST endpoints,
 *  both clickable to jump to the declaration. */
export default function SpringView({ root, onOpen }: Props) {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["spring", root],
    queryFn: () => springOverview(root),
    staleTime: 30_000,
  });
  const [tab, setTab] = useState<"beans" | "endpoints">("beans");

  const beanGroups = useMemo(() => {
    const g: Record<string, SpringBean[]> = {};
    for (const b of data?.beans ?? []) (g[b.kind] ??= []).push(b);
    return g;
  }, [data]);

  const beanCount = data?.beans.length ?? 0;
  const epCount = data?.endpoints.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[color:var(--line)] px-2 py-1.5">
        <SpringLeaf />
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Spring</span>
        <div className="ml-auto flex items-center gap-1">
          <TabBtn active={tab === "beans"} onClick={() => setTab("beans")}>Beans {beanCount > 0 && <Count n={beanCount} />}</TabBtn>
          <TabBtn active={tab === "endpoints"} onClick={() => setTab("endpoints")}>Endpoints {epCount > 0 && <Count n={epCount} />}</TabBtn>
          <button onClick={() => void refetch()} title="Re-scan" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]">
            <RefreshIcon spinning={isFetching} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <p className="px-3 py-4 text-[12px] text-[var(--text-tertiary)]">Scanning…</p>
        ) : tab === "beans" ? (
          beanCount === 0 ? (
            <Empty>No Spring beans found.</Empty>
          ) : (
            BEAN_ORDER.filter((k) => beanGroups[k]?.length).map((k) => (
              <div key={k} className="mb-2">
                <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{BEAN_META[k].label}</div>
                {beanGroups[k].map((b, i) => (
                  <button key={`${b.path}:${b.line}:${i}`} onClick={() => onOpen(b.path, b.line)} className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--hover)]">
                    <Badge letter={BEAN_META[k].letter} color={BEAN_META[k].color} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]">{b.name}</span>
                    {b.owner && <span className="shrink-0 truncate text-[10px] text-[var(--text-tertiary)]">{b.owner}</span>}
                  </button>
                ))}
              </div>
            ))
          )
        ) : epCount === 0 ? (
          <Empty>No REST endpoints found.</Empty>
        ) : (
          (data?.endpoints ?? []).map((e, i) => (
            <button key={`${e.file}:${e.line}:${i}`} onClick={() => onOpen(e.file, e.line)} className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--hover)]">
              <span className="w-[52px] shrink-0 rounded px-1 text-center text-[9.5px] font-bold text-white" style={{ background: METHOD_COLOR[e.method] ?? METHOD_COLOR.ANY }}>{e.method}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-primary)]" title={e.path}>{e.path}</span>
              <span className="shrink-0 truncate text-[10px] text-[var(--text-tertiary)]" title={e.handler}>{e.handler.split("#")[1] ?? e.handler}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"}`}>{children}</button>
  );
}
function Count({ n }: { n: number }) { return <span className="rounded-full bg-[var(--surface-2)] px-1 text-[9.5px] text-[var(--text-tertiary)]">{n}</span>; }
function Empty({ children }: { children: React.ReactNode }) { return <p className="px-3 py-4 text-[12px] text-[var(--text-tertiary)]">{children}</p>; }
function Badge({ letter, color }: { letter: string; color: string }) {
  return <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white" style={{ background: color }}>{letter}</span>;
}
function SpringLeaf() {
  return <svg viewBox="0 0 24 24" width="14" height="14" className="shrink-0 text-[#6db33f]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20.2 3.8a10 10 0 0 1-1.9 13.4c-3.5 3.2-9 3.2-12.4-.2C2.9 14 3 9 5.8 6.2 8 4 11.5 3.5 14 5" /><path d="M12 12c3-3 7-3 9-2" /></svg>;
}
function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={spinning ? "animate-spin" : ""}><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" /></svg>;
}
