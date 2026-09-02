import type { ReactNode } from "react";

export interface ActivityItem {
  id: string;
  title: string;
  icon: ReactNode;
  /** Highlighted when its panel is open. */
  active: boolean;
  onClick: () => void;
}

/** A thin vertical strip on the far right; each button toggles a side panel. */
export default function ActivityBar({ items }: { items: ActivityItem[] }) {
  return (
    <div className="activity-bar flex shrink-0 flex-col items-center gap-1 pt-2" data-tauri-drag-region>
      {items.map((it) => (
        <button
          key={it.id}
          onClick={it.onClick}
          title={it.title}
          aria-label={it.title}
          aria-pressed={it.active}
          className={`activity-btn ${it.active ? "activity-btn-active" : ""}`}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
}
