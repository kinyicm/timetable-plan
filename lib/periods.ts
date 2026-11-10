import { labelToMinutes } from "./time";

/** 默认作息：数组下标 0 对应第 1 节，以此类推。 */
export const DEFAULT_PERIODS: { start: string; end: string }[] = [
  { start: "08:00", end: "08:45" },
  { start: "08:55", end: "09:40" },
  { start: "10:00", end: "10:45" },
  { start: "10:55", end: "11:40" },
  { start: "14:00", end: "14:45" },
  { start: "14:55", end: "15:40" },
  { start: "16:00", end: "16:45" },
  { start: "16:55", end: "17:40" },
  { start: "19:00", end: "19:45" },
  { start: "19:55", end: "20:40" },
  { start: "20:50", end: "21:35" },
  { start: "21:45", end: "22:30" },
];

/** 第 slot 节（从 1 开始）对应的起止分钟数；越界时收敛到最近的有效节次。 */
export function slotToRange(slot: number): { startMin: number; endMin: number } {
  const idx = Math.min(Math.max(Math.round(slot) - 1, 0), DEFAULT_PERIODS.length - 1);
  const p = DEFAULT_PERIODS[idx];
  return { startMin: labelToMinutes(p.start), endMin: labelToMinutes(p.end) };
}
