export type HistoryEntry = {
  label: string;
  undo: () => void;
  redo: () => void;
};

const MAX_HISTORY = 20;

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];

/** 提交一次操作：记录回滚与重放闭包，并清空 redo 栈。 */
export function pushHistory(entry: HistoryEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_HISTORY) {
    undoStack = undoStack.slice(-MAX_HISTORY);
  }
  redoStack = [];
}

/** 撤销：弹出最近一次操作并回滚，返回该操作（无操作时返回 null）。 */
export function undoHistory(): HistoryEntry | null {
  const entry = undoStack.pop();
  if (!entry) return null;
  entry.undo();
  redoStack.push(entry);
  return entry;
}

/** 重做：弹出最近一次撤销并重放，返回该操作（无可重做操作时返回 null）。 */
export function redoHistory(): HistoryEntry | null {
  const entry = redoStack.pop();
  if (!entry) return null;
  entry.redo();
  undoStack.push(entry);
  return entry;
}
