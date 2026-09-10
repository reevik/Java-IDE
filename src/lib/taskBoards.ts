/** A Trello-style task board, persisted per project in localStorage. */

export interface Task {
  id: string;
  title: string;
  description?: string;
}

export interface Column {
  id: string;
  name: string;
  tasks: Task[];
}

export interface Board {
  id: string;
  name: string;
  columns: Column[];
}

const KEY = (root: string) => `taskboards:${root}`;
const SEL_KEY = (root: string) => `taskboards.selected:${root}`;

export function newId(): string {
  return `tb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** A fresh board with the default Backlog / In Progress / Done columns. */
export function newBoard(name = "Board"): Board {
  return {
    id: newId(),
    name,
    columns: [
      { id: newId(), name: "Backlog", tasks: [] },
      { id: newId(), name: "In Progress", tasks: [] },
      { id: newId(), name: "Done", tasks: [] },
    ],
  };
}

export function loadBoards(root: string): Board[] {
  try {
    const raw = localStorage.getItem(KEY(root));
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list) && list.length) return list;
  } catch {
    /* ignore */
  }
  return [newBoard()];
}

export function saveBoards(root: string, boards: Board[]) {
  try {
    localStorage.setItem(KEY(root), JSON.stringify(boards));
  } catch {
    /* ignore */
  }
}

export function loadSelectedBoardId(root: string): string | null {
  try {
    return localStorage.getItem(SEL_KEY(root));
  } catch {
    return null;
  }
}

export function saveSelectedBoardId(root: string, id: string) {
  try {
    localStorage.setItem(SEL_KEY(root), id);
  } catch {
    /* ignore */
  }
}
