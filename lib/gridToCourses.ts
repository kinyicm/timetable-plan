/**
 * 课表网格 → 课程列表（纯函数）。
 *
 * 模型只负责「照抄格子」，把二维课表读成 grid（columns + rows）；
 * 星期、节次区间、纵向合并、课程名/地点/周次拆分等确定性工作全部在这里完成。
 */

/** 一门课的时间区间。day 为 1..7，slot 从 1 开始且包含两端。 */
export interface Course {
  name: string;
  day: number;
  startSlot: number;
  endSlot: number;
  weeks: string;
  location: string;
  teacher: string;
}

export interface GridColumn {
  index: number;
  label: string;
}

export interface GridRow {
  slot: number;
  cells: string[];
}

export interface TimetableGrid {
  slotsPerDay: number;
  periods: { slot: number; start: string; end: string }[];
  columns: GridColumn[];
  rows: GridRow[];
}

/** 把任意值转成整数；null / undefined / 非数字返回 NaN。 */
function asInt(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }
  return NaN;
}

/** 把任意值转成落在 [min, max] 内的整数，非法时返回 fallback。 */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = asInt(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** 地点形态：以「楼/室/馆/场」结尾、可带编号的短 token（如 实训楼305、3号楼201、体育馆）。 */
const LOCATION_RE = /^[\u4e00-\u9fa5A-Za-z0-9]{0,6}[楼室馆场][0-9A-Za-z-]{0,8}$/;

/** 周次形态：非本周 / 单周 / 双周 / 全周 / 第N周 / N-M周。 */
const WEEKS_RE =
  /(非本周|单周|双周|全周|第[0-9一二三四五六七八九十]+周|[0-9]{1,2}-[0-9]{1,2}周)/;

/** 把一格文字拆成 name / location / weeks。 */
function splitCell(text: string): { name: string; location: string; weeks: string } {
  let name = text.trim();
  let location = "";
  let weeks = "";

  // 1) 以最后一个 "@" 为界，之后是地点，之前是课程名。
  const atIdx = name.lastIndexOf("@");
  if (atIdx !== -1) {
    location = name.slice(atIdx + 1).trim();
    name = name.slice(0, atIdx).trim();
  } else {
    // 2) 最后一个空白分隔的词若像「楼/室/馆/场」形态，视为地点。
    const tokens = name.split(/\s+/);
    const last = tokens[tokens.length - 1] ?? "";
    if (tokens.length > 1 && LOCATION_RE.test(last)) {
      location = last;
      tokens.pop();
      name = tokens.join(" ");
    }
  }

  // 3) 去掉括号内的序号后缀（「体育（一）」→「体育」）。
  name = name.replace(/[（(]\s*[一二三四五六七八九十\d]+\s*[)）]\s*$/g, "").trim();

  // 4) 提取周次并从课程名中移除。
  const weekMatch = name.match(WEEKS_RE);
  if (weekMatch) {
    weeks = weekMatch[1];
    name = name.replace(weekMatch[0], "").trim();
  }

  return { name, location, weeks };
}

/**
 * 把网格转成课程列表。
 * 纵向合并：同一列相邻行、去掉首尾空格后文字完全相同的格子视为同一门课。
 */
export function gridToCourses(
  data: unknown,
): { courses: Course[]; droppedCount: number } {
  if (!data || typeof data !== "object") {
    return { courses: [], droppedCount: 0 };
  }
  const d = data as Record<string, unknown>;
  const slotsPerDay = clampInt(d.slotsPerDay, 1, 30, 12);

  const columnsRaw = Array.isArray(d.columns) ? d.columns : [];
  const columns: GridColumn[] = columnsRaw.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return {
      index: asInt(o.index),
      label: typeof o.label === "string" ? o.label.trim() : "",
    };
  });

  const rowsRaw = Array.isArray(d.rows) ? d.rows : [];
  const rows: GridRow[] = rowsRaw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const cells = Array.isArray(o.cells)
      ? o.cells.map((cell) => (typeof cell === "string" ? cell : ""))
      : [];
    return { slot: asInt(o.slot), cells };
  });

  const courses: Course[] = [];
  let droppedCount = 0;

  for (let c = 0; c < columns.length; c++) {
    const day = columns[c].index;
    let i = 0;
    while (i < rows.length) {
      const cellText = (rows[i].cells[c] ?? "").trim();
      if (!cellText) {
        i++;
        continue;
      }
      // 向下合并相邻、文字完全相同的格子。
      let j = i;
      while (j + 1 < rows.length && (rows[j + 1].cells[c] ?? "").trim() === cellText) {
        j++;
      }
      const startSlot = rows[i].slot;
      const endSlot = rows[j].slot;

      const dayOk = Number.isInteger(day) && day >= 1 && day <= 7;
      const startOk =
        Number.isInteger(startSlot) && startSlot >= 1 && startSlot <= slotsPerDay;
      const endOk =
        Number.isInteger(endSlot) && endSlot >= 1 && endSlot <= slotsPerDay;
      const rangeOk =
        Number.isInteger(startSlot) && Number.isInteger(endSlot) && endSlot >= startSlot;

      if (!dayOk || !startOk || !endOk || !rangeOk) {
        droppedCount++;
      } else {
        const { name, location, weeks } = splitCell(cellText);
        if (name) {
          courses.push({ name, day, startSlot, endSlot, weeks, location, teacher: "" });
        } else {
          droppedCount++;
        }
      }
      i = j + 1;
    }
  }

  // 固定按「星期 → 起始节次」排序，避免模型输出顺序随机导致界面跳动。
  courses.sort((a, b) => a.day - b.day || a.startSlot - b.startSlot);
  return { courses, droppedCount };
}
