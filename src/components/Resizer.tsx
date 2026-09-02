import { useRef } from "react";

interface Props {
  width: number;
  setWidth: (w: number) => void;
  /** +1: dragging right grows the panel (left panel); -1: dragging left grows it (right panel). */
  dir: 1 | -1;
  min: number;
  max: number;
  onReset?: () => void;
}

/** A thin vertical drag handle between two panels. Double-click resets the width. */
export default function Resizer({ width, setWidth, dir, min, max, onReset }: Props) {
  const active = useRef(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    active.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      active.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="resizer"
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
