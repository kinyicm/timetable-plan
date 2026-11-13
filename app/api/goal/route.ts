/**
 * 课表规划 · 目标规划接口
 *
 * 调用智谱 GLM（OpenAI 兼容接口）把「学习目标」拆成若干子任务，并排进前端算好的空闲时段。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），绝不接受客户端传入密钥。
 *
 * 职责边界：
 *   模型只负责「把目标拆成子任务」并给出落在哪个空闲块（freeSlotIndex + 偏移 + 时长）；
 *   下标是否合法、时长是否在 30-120、区间是否重叠、每日超时丢弃、总时长偏差提示等
 *   全部由服务端程序完成。
 */

import { chatOnce, desensitize, LlmError } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";
import type { KnowledgePoint } from "@/lib/types";

// Vercel 最长执行时间（秒）。与上游 fetch 超时（120s）对齐。
export const maxDuration = 120;

/** 模型名：可换模型而不改代码。 */
const MODEL = process.env.ZHIPU_TEXT_MODEL ?? "glm-4-flash";

/** 与智谱接口基准超时（秒）对齐：目标规划可能较慢，放宽到 120 秒。 */
const FETCH_TIMEOUT_MS = 120_000;

/** 请求体上限（字节）。 */
const MAX_BODY_BYTES = 8 * 1024;

/** 单天最多安排的累计时长（分钟）。 */
const MAX_DAILY_MIN = 240;

/** 把数字或数字字符串转成整数；null / undefined / 非数字返回 NaN。 */
function asInt(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }
  return NaN;
}

/** 把数字或数字字符串转成浮点数；null / undefined / 非数字返回 NaN。 */
function asNumber(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

type FreeSlotInput = { date: string; startMin: number; endMin: number };

type GoalAction = {
  op: "add";
  date: string;
  startMin: number;
  endMin: number;
  title: string;
  kind: "task";
  detail: string;
};

/** 分钟数 → "HH:MM"（仅用于提示词里展示空闲时段）。 */
function padHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 任务标题是否命中某个知识点名称（允许「洛必达法则 · 练习」这类后缀）。 */
function titleMatchesPoint(title: string, points: KnowledgePoint[]): boolean {
  return points.some((p) => {
    if (!p.name) return false;
    if (title === p.name) return true;
    if (!title.startsWith(p.name)) return false;
    const rest = title.slice(p.name.length).trim();
    return rest === "" || rest.startsWith("·") || rest.startsWith("（") || rest.startsWith("(");
  });
}

/**
 * 程序侧完成时段换算与校验：
 * 1. 逐条把 freeSlotIndex + offsetMin + durationMin 换算成 date/startMin/endMin。
 * 2. 校验：下标合法、时长 30-120、偏移非负、区间不超出空档、不与已占用区间重叠、
 *    标题命中知识点清单。通过则记入「已占用区间」表；不通过丢弃（droppedCount++）。
 * 3. 模型返回超过 12 条 → 按时间顺序截断，多余的计入 droppedCount。
 * 4. 同一天累计时长 > 240 分钟 → 丢弃该天最晚的子任务（droppedCount++），直到不再超。
 * 注：不再做「吸附到最近空档」，movedCount 恒为 0（保留字段）。
 */
function validateActions(
  rawActions: unknown,
  freeSlots: FreeSlotInput[],
  points: KnowledgePoint[],
): { actions: GoalAction[]; movedCount: number; droppedCount: number } {
  const rawList = Array.isArray(rawActions) ? rawActions : [];
  let droppedCount = 0;

  // 超过 12 条：按时间顺序（空档下标 + 偏移）排序后截断，多余的计入 droppedCount。
  let list: unknown[] = rawList;
  if (rawList.length > 12) {
    const indexed = rawList.map((raw) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      const idx = asInt(a.freeSlotIndex);
      const off = asInt(a.offsetMin);
      return {
        raw,
        idx: Number.isFinite(idx) ? idx : Number.MAX_SAFE_INTEGER,
        off: Number.isFinite(off) ? off : 0,
      };
    });
    indexed.sort((x, y) => x.idx - y.idx || x.off - y.off);
    droppedCount += indexed.length - 12;
    list = indexed.slice(0, 12).map((x) => x.raw);
  }

  const kept: GoalAction[] = [];
  // 已占用区间表：按 date 分组，保证同一空档内任务不重叠。
  const occupied = new Map<string, [number, number][]>();

  for (const raw of list) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const idx = asInt(a.freeSlotIndex);
    const offsetMin = asInt(a.offsetMin);
    const durationMin = asInt(a.durationMin);
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const detail = typeof a.detail === "string" ? a.detail.trim() : "";

    if (!title) {
      droppedCount++;
      continue;
    }
    // 提供了知识点清单时，任务标题必须命中某个知识点名称，否则丢弃。
    if (points.length > 0 && !titleMatchesPoint(title, points)) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(idx) || idx < 0 || idx >= freeSlots.length) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(durationMin) || durationMin < 30 || durationMin > 120) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(offsetMin) || offsetMin < 0) {
      droppedCount++;
      continue;
    }

    const slot = freeSlots[idx];
    const startMin = slot.startMin + offsetMin;
    const endMin = startMin + durationMin;

    // 区间不得超出该空档边界
    if (endMin > slot.endMin) {
      droppedCount++;
      continue;
    }
    // 区间不得与已占用区间相交
    const dayOccupied = occupied.get(slot.date) ?? [];
    const overlaps = dayOccupied.some(([s, e]) => startMin < e && endMin > s);
    if (overlaps) {
      droppedCount++;
      continue;
    }

    dayOccupied.push([startMin, endMin]);
    occupied.set(slot.date, dayOccupied);

    kept.push({
      op: "add",
      date: slot.date,
      startMin,
      endMin,
      title,
      kind: "task",
      detail,
    });
  }

  // 同一天累计时长控制：按开始时间升序，超时从最晚的开始丢。
  const byDate = new Map<string, GoalAction[]>();
  for (const act of kept) {
    const arr = byDate.get(act.date) ?? [];
    arr.push(act);
    byDate.set(act.date, arr);
  }

  const final: GoalAction[] = [];
  for (const arr of byDate.values()) {
    arr.sort((x, y) => x.startMin - y.startMin || x.endMin - y.endMin);
    let total = arr.reduce((s, x) => s + (x.endMin - x.startMin), 0);
    const remaining = [...arr];
    while (total > MAX_DAILY_MIN && remaining.length > 0) {
      const latest = remaining.pop()!;
      total -= latest.endMin - latest.startMin;
      droppedCount++;
    }
    final.push(...remaining);
  }

  final.sort((x, y) =>
    x.date === y.date ? x.startMin - y.startMin : x.date < y.date ? -1 : 1,
  );

  return { actions: final, movedCount: 0, droppedCount };
}

/** 拼出「把目标拆成子任务并排进空闲时段」的提示词。 */
function buildPrompt(ctx: {
  title: string;
  deadline: string;
  hoursPerWeek: number;
  priority: string;
  freeSlots: FreeSlotInput[];
  existingTitles: string[];
  today: string;
  points: KnowledgePoint[];
  strategy?: { name: string; type: string; summary: string; sessionsPerWeek: number; avgSessionMin: number };
}): string {
  const slotsText = ctx.freeSlots
    .map(
      (s, i) =>
        `[${i}] ${s.date} ${padHHMM(s.startMin)}-${padHHMM(s.endMin)} 共 ${s.endMin - s.startMin} 分钟`,
    )
    .join("\n");
  const existingText = ctx.existingTitles.length ? ctx.existingTitles.join("、") : "（暂无）";
  const weeklyText = Number.isFinite(ctx.hoursPerWeek) ? `${ctx.hoursPerWeek} 小时` : "未指定";
  const pointsText = ctx.points.length
    ? ctx.points
        .map(
          (p, i) =>
            `${i + 1}. ${p.name}${p.category ? `（${p.category}）` : ""}，难度${p.difficulty}，约 ${
              Number.isFinite(p.estimatedMinutes) ? p.estimatedMinutes : 60
            } 分钟`,
        )
        .join("\n")
    : "（未提供知识点清单，请自行把目标拆成子任务）";
  const strategyText = ctx.strategy
    ? `\n用户已选定方案：strategy=${ctx.strategy.type}（${ctx.strategy.name}），每周 ${ctx.strategy.sessionsPerWeek} 次，每次约 ${ctx.strategy.avgSessionMin} 分钟。请严格按这个节奏安排，不要改成其他节奏。`
    : "";

  return `你是「课表规划」应用的学习规划助手。请把一个学习目标拆解成具体可执行的子任务，并排进给定的空闲时段。只输出一个严格的 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。

目标信息：
- 目标：${ctx.title}
- 截止日期：${ctx.deadline || "未指定"}
- 每周投入：${weeklyText}
- 优先级：${ctx.priority || "未指定"}
- 今天：${ctx.today || "未知"}${strategyText}

可用的空闲时段（编号从 0 开始，只能使用列出的编号）：
${slotsText || "（无）"}

已有事件标题（避免重复）：${existingText}

需要逐一安排的知识点清单（按学习顺序，逐条安排，不得跳过）：
${pointsText}

JSON 结构固定如下：
{
  "feasible": boolean,
  "actions": [
    { "freeSlotIndex": number, "offsetMin": number, "durationMin": number, "title": string, "detail": string }
  ],
  "reason": "为什么这样排（2-4 句）",
  "advice": "若不可行或需要调整，给替代方案"
}

必须遵守的规则：
- 把目标拆成具体子任务，每个子任务 30-120 分钟；actions 最多 12 条。
- 若提供了知识点清单：每条任务必须对应清单里的一个知识点，title 必须等于该知识点的 name（可加后缀如「· 练习」），按 order 顺序依次排入空闲时段；不得把 title 换成「复习高数」这类笼统说法。
- freeSlotIndex 只能是上面列出的编号；offsetMin 是在该空档内的偏移（0 或 30 的倍数），且 offsetMin + durationMin 不得超过该空档的长度。
- 总时长尽量接近「每周投入」的小时数。
- 同一个空档内可以放多个任务，但彼此不要重叠。
- title 写子任务名称，detail 写这一子任务具体做什么（一两句）。
- feasible=true 表示能完整安排；feasible=false 时 actions 可以为空数组或只排一部分，并且必须在 advice 里说明为什么不可行、给出替代建议。
- 所有数字字段输出数字类型，不要加引号。
- 只输出上面这一个 JSON。`;
}

function parseFreeSlots(raw: unknown): FreeSlotInput[] {
  if (!Array.isArray(raw)) return [];
  const slots: FreeSlotInput[] = [];
  for (const item of raw) {
    const s = (item ?? {}) as Record<string, unknown>;
    const date = typeof s.date === "string" ? s.date : "";
    const startMin = asInt(s.startMin);
    const endMin = asInt(s.endMin);
    if (!date || !Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
      continue;
    }
    slots.push({ date, startMin, endMin });
  }
  return slots;
}

/** 解析用户勾选的知识点清单（按 order 升序），忽略无效项。 */
function parsePoints(raw: unknown): KnowledgePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgePoint[] = [];
  for (const item of raw) {
    const p = (item ?? {}) as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) continue;
    const difficultyRaw = typeof p.difficulty === "string" ? p.difficulty.trim() : "";
    out.push({
      id: typeof p.id === "string" ? p.id : "",
      name,
      category: typeof p.category === "string" ? p.category.trim() : "",
      difficulty:
        (difficultyRaw === "进阶" || difficultyRaw === "难点" ? difficultyRaw : "基础") as KnowledgePoint["difficulty"],
      estimatedMinutes: asInt(p.estimatedMinutes),
      order: asInt(p.order),
    });
  }
  out.sort((a, b) => (Number.isFinite(a.order) && Number.isFinite(b.order) ? a.order - b.order : 0));
  return out;
}

export async function POST(req: Request) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) {
    return Response.json(
      { ok: false, error: "服务端未配置 ZHIPU_API_KEY，无法调用大模型" },
      { status: 500 },
    );
  }

  // 限流放在解析请求体之前：非法/超量请求不应消耗配额。
  const limited = checkRateLimit(req, "goal", 5, "请求");
  if (limited) {
    return Response.json({ ok: false, error: limited }, { status: 429 });
  }

  const rawText = await req.text().catch(() => "");
  if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "请求体过大（最多 8KB）" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const goal = (body.goal ?? {}) as Record<string, unknown>;
  const title = typeof goal.title === "string" ? goal.title.trim() : "";
  const deadline = typeof goal.deadline === "string" ? goal.deadline.trim() : "";
  const priority = typeof goal.priority === "string" ? goal.priority.trim() : "";
  const hoursPerWeek = asNumber(goal.hoursPerWeek);

  if (!title) {
    return Response.json({ ok: false, error: "请填写目标标题" }, { status: 400 });
  }

  const freeSlots = parseFreeSlots(body.freeSlots);
  if (freeSlots.length === 0) {
    return Response.json({ ok: false, error: "没有可用的空闲时段，无法规划" }, { status: 400 });
  }

  const existingTitles = Array.isArray(body.existingTitles)
    ? body.existingTitles.filter((t): t is string => typeof t === "string")
    : [];
  const today = typeof body.today === "string" ? body.today : "";

  // 用户勾选的知识点清单（可空：为空则回退到「自行拆子任务」）。
  const points = parsePoints(body.points);

  // 可选：用户在方案咨询阶段选定的执行方案，用于让任务拆分贴合该节奏。
  const strategyRaw = (body.strategy ?? undefined) as Record<string, unknown> | undefined;
  let strategy: { name: string; type: string; summary: string; sessionsPerWeek: number; avgSessionMin: number } | undefined;
  if (strategyRaw && typeof strategyRaw === "object") {
    const name = typeof strategyRaw.name === "string" ? strategyRaw.name.trim() : "";
    if (name) {
      strategy = {
        name,
        type: typeof strategyRaw.type === "string" ? strategyRaw.type.trim() : "",
        summary: typeof strategyRaw.summary === "string" ? strategyRaw.summary.trim() : "",
        sessionsPerWeek: asInt(strategyRaw.sessionsPerWeek),
        avgSessionMin: asInt(strategyRaw.avgSessionMin),
      };
    }
  }

  try {
    const data = await chatOnce({
      key,
      model: MODEL,
      content: buildPrompt({ title, deadline, hoursPerWeek, priority, freeSlots, existingTitles, today, points, strategy }),
      timeoutMs: FETCH_TIMEOUT_MS,
      service: "规划",
      timeoutMessage: "规划超时，请把目标拆小一点后重试",
      timeoutStatus: 200,
    });
    const d = (data ?? {}) as Record<string, unknown>;
    const feasible = d.feasible === true;
    let reason = typeof d.reason === "string" ? d.reason.trim() : "";
    const advice = typeof d.advice === "string" ? d.advice.trim() : "";

    const { actions, movedCount, droppedCount } = validateActions(d.actions, freeSlots, points);

    // 总时长与 hoursPerWeek*60 偏差超过 30% → 在 reason 后追加提示。
    if (Number.isFinite(hoursPerWeek) && hoursPerWeek > 0) {
      const totalMin = actions.reduce((s, x) => s + (x.endMin - x.startMin), 0);
      const target = hoursPerWeek * 60;
      if (Math.abs(totalMin - target) / target > 0.3) {
        const note = `（注意：已排总时长约 ${Math.round(totalMin / 60)} 小时，与目标每周 ${hoursPerWeek} 小时偏差较大）`;
        reason = reason ? `${reason} ${note}` : note;
      }
    }

    // 知识点数量多于可安排时段（有知识点未排入）→ 在 reason 里说明。
    if (points.length > 0) {
      const unscheduled = points.filter((p) => !actions.some((a) => titleMatchesPoint(a.title, [p]))).length;
      if (unscheduled > 0) {
        const hint = `还有 ${unscheduled} 个知识点未排入，建议延长周期或提高每周投入`;
        reason = reason ? `${reason} ${hint}` : hint;
      }
    }

    return Response.json({
      ok: true,
      feasible,
      actions,
      reason,
      advice,
      movedCount,
      droppedCount,
    });
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError("目标规划失败，请稍后重试");
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}
