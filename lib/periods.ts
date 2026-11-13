import { labelToMinutes } from "./time";

/**
 * 默认作息：数组下标 0 对应第 1 节，以此类推。
 *
 * 数据来源：作者本人所在院校（广东生态工程职业学院）2026-2027 学年第一学期
 * 真实课表左侧的节次时间，由作者逐节核对确认。
 *
 * 这些值只是「兜底默认」：导入课表时，如果识别结果里带了 periods
 * （图片左侧印着的真实时间），校对界面会优先展示识别值，并允许在校对时修改；
 * 修改只影响当次导入，不落库。
 *
 * 注意：第 11 节在原课表上未标注时间，此处按「第 10 节结束后休息 10 分钟」
 * 推算填入，仅用于兜底，实际以用户校对或识别值为准。
 */
export type Period = { start: string; end: string };

export const DEFAULT_PERIODS: Period[] = [
  { start: "08:30", end: "09:10" }, // 1
  { start: "09:10", end: "09:50" }, // 2
  { start: "10:20", end: "11:00" }, // 3
  { start: "11:10", end: "11:50" }, // 4
  { start: "14:10", end: "14:50" }, // 5
  { start: "15:00", end: "15:40" }, // 6
  { start: "16:00", end: "16:40" }, // 7
  { start: "16:50", end: "17:30" }, // 8
  { start: "18:30", end: "19:10" }, // 9
  { start: "19:20", end: "20:00" }, // 10
  { start: "20:10", end: "20:50" }, // 11（原表未标注，按第10节推算）
];

/** 第 slot 节（从 1 开始）对应的起止分钟数；越界时收敛到最近的有效节次。 */
export function slotToRange(
  slot: number,
  periods?: Period[],
): { startMin: number; endMin: number } {
  const list = periods && periods.length > 0 ? periods : DEFAULT_PERIODS;
  const idx = Math.min(Math.max(Math.round(slot) - 1, 0), list.length - 1);
  const p = list[idx];
  return { startMin: labelToMinutes(p.start), endMin: labelToMinutes(p.end) };
}
