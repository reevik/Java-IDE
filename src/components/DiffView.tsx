/** A read-only unified-diff viewer (git patch text), colored like a diff tool. */
export default function DiffView({ text }: { text: string }) {
  const lines = text.length ? text.split("\n") : [];
  return (
    <div className="h-full overflow-auto py-1 font-mono text-[12px] leading-[1.55]">
      {lines.length === 0 ? (
        <p className="px-3 py-6 text-center text-[var(--text-tertiary)]">No changes in this file.</p>
      ) : (
        <div className="w-max min-w-full">
          {lines.map((l, i) => (
            <div key={i} className={`whitespace-pre px-3 ${lineClass(l)}`}>
              {l || " "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function lineClass(l: string): string {
  if (l.startsWith("@@")) return "bg-[color:#1c7ed6]/10 text-[color:#1565c0]";
  if (
    l.startsWith("diff ") ||
    l.startsWith("index ") ||
    l.startsWith("new file") ||
    l.startsWith("deleted file") ||
    l.startsWith("similarity ") ||
    l.startsWith("rename ") ||
    l.startsWith("--- ") ||
    l.startsWith("+++ ")
  )
    return "text-[var(--text-tertiary)]";
  if (l.startsWith("+")) return "bg-green-500/12 text-green-800";
  if (l.startsWith("-")) return "bg-red-500/12 text-red-700";
  return "text-[var(--text-secondary)]";
}
