import { useQuery } from "@tanstack/react-query";
import { mcpServers, type McpServer } from "../lib/api";

interface Props {
  root: string;
}

const STATUS: Record<McpServer["status"], { label: string; color: string }> = {
  connected: { label: "Connected", color: "#1a7f37" },
  failed: { label: "Failed", color: "#d1242f" },
  unknown: { label: "Unknown", color: "var(--text-tertiary)" },
};

/** The MCP panel: the Model Context Protocol servers configured for the Claude
 *  CLI in this project (user, project `.mcp.json`, and local scopes), each with
 *  its live connection status from the CLI's health check. */
export default function McpPanel({ root }: Props) {
  const { data: servers, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["mcp-servers", root],
    queryFn: () => mcpServers(root),
    staleTime: 30_000,
  });

  const connected = (servers ?? []).filter((s) => s.status === "connected").length;

  return (
    <aside className="agent-pane flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
        <McpIcon />
        <h2 className="flex-1 text-[12.5px] font-semibold text-[var(--text-primary)]" data-tauri-drag-region>MCP Servers</h2>
        <button onClick={() => void refetch()} title="Re-check" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]">
          <RefreshIcon spinning={isFetching} />
        </button>
      </header>

      <p className="shrink-0 px-3 pb-2 text-[10.5px] text-[var(--text-tertiary)]">
        {error
          ? "Claude CLI not available."
          : `${servers?.length ?? 0} server${(servers?.length ?? 0) === 1 ? "" : "s"} · ${connected} connected. From the Claude CLI (user, project .mcp.json, local).`}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <p className="px-2 py-4 text-[12px] leading-relaxed text-[var(--text-tertiary)]">{String(error)}</p>
        ) : isLoading ? (
          <p className="px-2 py-4 text-[12px] text-[var(--text-tertiary)]">Checking servers…</p>
        ) : (servers?.length ?? 0) === 0 ? (
          <p className="px-2 py-4 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            No MCP servers configured. Add one with <code className="font-mono">claude mcp add</code>, or a project <code className="font-mono">.mcp.json</code>.
          </p>
        ) : (
          servers!.map((s) => <McpRow key={s.name} server={s} />)
        )}
      </div>
    </aside>
  );
}

function McpRow({ server }: { server: McpServer }) {
  const meta = STATUS[server.status];
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5">
      <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} title={meta.label} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">{server.name}</span>
          <span className="shrink-0 text-[10px]" style={{ color: meta.color }}>{meta.label}</span>
        </span>
        {server.detail && <span className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--text-tertiary)]" title={server.detail}>{server.detail}</span>}
      </span>
    </div>
  );
}

function McpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4M8 9l2.5 2.5L8 14M13 14h3" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={spinning ? "animate-spin" : ""}><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" /></svg>;
}
