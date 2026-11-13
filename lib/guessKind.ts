import type { ScheduleEvent } from "./types";

/**
 * 根据日期与开始时间猜测事件类型与默认时长（纯函数）。
 * 规则：
 *   - 周一至周五 08:00-17:40 且开始时间落在该区间 → kind="course"，时长 90 分钟
 *   - 其余（晚上、周末，含周末白天）→ kind="task"，时长 60 分钟
 */
export function guessKind(
  date: string,
  startMin: number,
): { kind: ScheduleEvent["kind"]; durationMin: number } {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=周日 … 6=周六
  const isWeekday = dow >= 1 && dow <= 5;
  const inDaytime = startMin >= 8 * 60 && startMin <= 17 * 60 + 40;

  if (isWeekday && inDaytime) {
    return { kind: "course", durationMin: 90 };
  }
  return { kind: "task", durationMin: 60 };
}
