function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

export function labelToMinutes(label: string): number {
  const [h, m] = label.split(":").map((part) => parseInt(part, 10));
  return h * 60 + m;
}

/** 使用本地时区手拼 YYYY-MM-DD，不使用 toISOString（避免 UTC 偏移导致日期错误）。 */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 返回该周周一 00:00 的 Date。 */
export function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay(); // 0=周日，1=周一，...
  const diff = (day + 6) % 7; // 距离周一的天数
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(d: Date, n: number): Date {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

export function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const month = weekStart.getMonth() + 1;
  const startDay = weekStart.getDate();
  const endDay = end.getDate();
  return `${month} 月 ${startDay} 日 - ${endDay} 日`;
}
