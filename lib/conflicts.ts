import type { ScheduleEvent } from "./types";

/** 一处时间冲突：两个事件的 id 与冲突原因。 */
export interface Conflict {
  aId: string;
  bId: string;
  reason: string;
}

/**
 * 找出所有时间冲突。
 * 规则：同一天、时间区间有交集即视为冲突；
 * 只要一方是 course，就归因为「与上课时间重叠」，否则为「两个安排时间重叠」。
 */
export function findConflicts(events: ScheduleEvent[]): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (a.date !== b.date) continue;
      const overlap = a.startMin < b.endMin && b.startMin < a.endMin;
      if (!overlap) continue;
      const reason =
        a.kind === "course" || b.kind === "course"
          ? "与上课时间重叠"
          : "两个安排时间重叠";
      conflicts.push({ aId: a.id, bId: b.id, reason });
    }
  }
  return conflicts;
}
