import type { ScheduleEvent } from "./types";

export interface FreeSlot {
  date: string;
  startMin: number;
  endMin: number;
}

/** 把「YYYY-MM-DD」加上若干天（UTC 计算，避免时区/夏令时干扰）。 */
function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * 计算从 startDate 起连续 days 天的空闲时间段（纯函数，不访问 window）。
 * 每天取 [dayStartMin, dayEndMin] 区间，减去当天所有事件的占用，得到空闲块；
 * 跨出边界的占用会被裁剪；短于 minSlotMin 的碎片丢弃。
 * 结果按日期升序、同一天内按开始时间升序返回。
 */
export function computeFreeSlots(
  events: ScheduleEvent[],
  startDate: string,
  days: number,
  dayStartMin = 480,
  dayEndMin = 1380,
  minSlotMin = 30,
): FreeSlot[] {
  const result: FreeSlot[] = [];

  for (let i = 0; i < days; i++) {
    const date = addDaysToDateKey(startDate, i);

    // 收集当天与 [dayStartMin, dayEndMin] 有交集的占用，并裁剪到边界。
    const occupied: Array<{ startMin: number; endMin: number }> = [];
    for (const ev of events) {
      if (ev.date !== date) continue;
      const s = Math.max(ev.startMin, dayStartMin);
      const e = Math.min(ev.endMin, dayEndMin);
      if (e > s) occupied.push({ startMin: s, endMin: e });
    }
    occupied.sort((a, b) => a.startMin - b.startMin);

    let cursor = dayStartMin;
    for (const occ of occupied) {
      if (occ.startMin > cursor) {
        if (occ.startMin - cursor >= minSlotMin) {
          result.push({ date, startMin: cursor, endMin: occ.startMin });
        }
      }
      if (occ.endMin > cursor) cursor = occ.endMin;
    }
    if (dayEndMin - cursor >= minSlotMin) {
      result.push({ date, startMin: cursor, endMin: dayEndMin });
    }
  }

  return result;
}
