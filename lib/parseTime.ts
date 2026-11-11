/**
 * 时间输入解析（纯函数）：把用户手输的时间字符串容错地转成「当天分钟数」。
 *
 * 支持的写法：
 *   "19:30" -> 1170   （标准 hh:mm）
 *   "1930"  -> 1170   （四位数字）
 *   "930"   -> 570    （三位数字：第一位是小时，后两位是分钟）
 *   "9:5"   -> 545    （分钟可省略前导零）
 *   "19"    -> 1140   （只给小时）
 *
 * 非法输入（如 "abc"、"2560"）返回 null，由调用方决定如何提示。
 */
export function parseTime(input: string): number | null {
  // 兼容中文全角冒号，并去掉首尾空白。
  const s = input.trim().replace(/：/g, ":");
  if (!s) return null;

  let hourStr: string;
  let minuteStr: string;

  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length !== 2) return null;
    hourStr = parts[0];
    minuteStr = parts[1];
  } else if (/^\d+$/.test(s)) {
    if (s.length <= 2) {
      hourStr = s;
      minuteStr = "0";
    } else if (s.length === 3) {
      hourStr = s.slice(0, 1);
      minuteStr = s.slice(1);
    } else if (s.length === 4) {
      hourStr = s.slice(0, 2);
      minuteStr = s.slice(2);
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (!hourStr || !minuteStr) return null;
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}
