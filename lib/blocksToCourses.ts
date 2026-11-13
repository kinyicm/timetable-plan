/**
 * 课程块列表 → 课程列表（纯函数）。
 *
 * 不再用比例坐标去「算」列与节次——实测比例坐标系统性偏左、且节次跨度读不出，
 * 改由模型直接判断 colIndex / rowStart / rowEnd，比例 leftRatio 仅作交叉校验。
 * 程序侧负责：判断优先、比例兜底、矛盾时标记可疑。
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
  /** 该行识别结果需要人工核对（列判断与比例矛盾，或节次跨度没读出来）。 */
  suspect?: boolean;
}

/** 把任意值转成数字；null / undefined / 非数字返回 NaN。 */
function toNumber(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** 把值夹取到 [min, max]，越界时钳到边界；非有限数返回 min。 */
function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export interface BlocksResult {
  courses: Course[];
  invalidCount: number;
  /** 模型识别到的列数（可能为 NaN）；调用方负责校验是否为 6 或 7。 */
  colCount: number;
  /** 课程数 >= 3 且所有课程都被识别成单节时置 true，提示「跨度未识别」。 */
  spanSuspect: boolean;
  /** 被标记为「需人工核对」的课程条数。 */
  suspectCount: number;
}

/**
 * 把模型返回的课程块列表转成课程列表。
 *
 * 星期（day）确定顺序：
 *   1) colIndex 落在 1..colCount -> 直接采用；
 *   2) colIndex 缺失/非法 -> 回退 leftRatio：col = clamp(floor(leftRatio*colCount)+1, 1, colCount)；
 *   3) colIndex 合法且 leftRatio 也给了：若两者换算出的列差 >= 2 -> 标 suspect（仍采用 colIndex）。
 *
 * 节次确定顺序：
 *   1) rowEnd > rowStart -> 采用模型跨度；
 *   2) rowEnd === rowStart（或缺失/反了，模型没读出高度）-> endSlot = startSlot + 1（不超过 slotCount），标 suspect；
 *   3) rowStart 缺失 -> 丢弃并计入 invalidCount。
 */
export function blocksToCourses(data: unknown): BlocksResult {
  if (!data || typeof data !== "object") {
    return { courses: [], invalidCount: 0, colCount: NaN, spanSuspect: false, suspectCount: 0 };
  }
  const d = data as Record<string, unknown>;

  // slotCount 不在 1..30 或缺失 -> 默认 11。
  const slotCountRaw = toNumber(d.slotCount);
  const slotCount = Number.isFinite(slotCountRaw) ? clamp(slotCountRaw, 1, 30) : 11;
  // 列数不静默夹取：保留识别值，由调用方校验（6/7 之外应失败而非压列）。
  const colCount = toNumber(d.colCount);
  const effectiveColCount = Number.isFinite(colCount) ? colCount : 7;

  const blocksRaw = Array.isArray(d.blocks) ? d.blocks : [];
  const courses: Course[] = [];
  let invalidCount = 0;
  let suspectCount = 0;

  for (const raw of blocksRaw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) {
      invalidCount++;
      continue;
    }

    // 1. 星期：colIndex 优先，leftRatio 兜底 + 交叉校验
    const colIndex = toNumber(o.colIndex);
    const leftRatio = toNumber(o.leftRatio);
    const hasRatio = Number.isFinite(leftRatio) && leftRatio >= 0 && leftRatio <= 1;
    const ratioCol = hasRatio
      ? clamp(Math.floor(leftRatio * effectiveColCount) + 1, 1, effectiveColCount)
      : NaN;

    let day: number;
    let suspect = false;

    const colIndexInt = Number.isFinite(colIndex) ? Math.round(colIndex) : NaN;
    const colIndexValid =
      Number.isFinite(colIndexInt) && colIndexInt >= 1 && colIndexInt <= effectiveColCount;

    if (colIndexValid) {
      day = colIndexInt;
      if (hasRatio && Math.abs(ratioCol - colIndexInt) >= 1) {
        suspect = true; // 模型判断与比例矛盾（哪怕偏 1 列），仍以模型判断为准，仅标黄提示
      }
    } else if (hasRatio) {
      day = ratioCol;
    } else {
      // 既无 colIndex 也无 leftRatio，无法定位星期
      invalidCount++;
      continue;
    }

    // 2. 节次：rowStart/rowEnd 判断优先，读不出高度则 +1 并标可疑
    const rowStart = toNumber(o.rowStart);
    if (!Number.isFinite(rowStart)) {
      invalidCount++;
      continue;
    }
    const startSlot = clamp(Math.round(rowStart), 1, slotCount);
    const rowEnd = toNumber(o.rowEnd);
    const endRaw = Math.round(rowEnd);
    let endSlot: number;
    if (Number.isFinite(rowEnd) && endRaw > startSlot) {
      endSlot = clamp(endRaw, startSlot, slotCount);
    } else {
      // 模型没读出高度（rowEnd === rowStart 或缺失/反向）：默认跨 1 节，标可疑
      endSlot = Math.min(startSlot + 1, slotCount);
      suspect = true;
    }

    const location = typeof o.location === "string" ? o.location.trim() : "";
    const weeks = typeof o.weeks === "string" ? o.weeks.trim() : "";

    if (suspect) suspectCount++;

    courses.push({
      name,
      day,
      startSlot,
      endSlot,
      weeks,
      location,
      teacher: "",
      suspect,
    });
  }

  // 固定按「星期 → 起始节次」排序，避免模型输出顺序随机导致界面跳动。
  courses.sort((a, b) => a.day - b.day || a.startSlot - b.startSlot);

  // 课程数达标且每一门都被标可疑时，说明「跨度」整体没读出来，需要提示。
  const spanSuspect = courses.length >= 3 && courses.every((c) => c.suspect);

  return { courses, invalidCount, colCount, spanSuspect, suspectCount };
}
