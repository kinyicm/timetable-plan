/**
 * 课表规划 · 目标规划接口
 *
 * 调用智谱 GLM（OpenAI 兼容接口）把「学习目标」拆成若干子任务，并排进前端算好的空闲时段。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），绝不接受客户端传入密钥。
 *
 * 职责边界：
 *   模型只负责「把目标拆成子任务」并给出日期/时段语义；
 *   时段是否落在空闲块内、越界搬迁、每日超时丢弃、总时长偏差提示等校验全部由服务端程序完成。
 */

// Vercel 最长执行时间（秒）。
export const maxDuration = 60;

/** 模型名：可换模型而不改代码。 */
const MODEL = process.env.ZHIPU_TEXT_MODEL ?? "glm-4-flash";
/** 智谱 OpenAI 兼容 `chat/completions` 接口。 */
const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/** 与智谱接口基准超时（秒）对齐。 */
const FETCH_TIMEOUT_MS = 50_000;

/** 请求体上限（字节）。 */
const MAX_BODY_BYTES = 8 * 1024;

/** 是否本地开发（本地不限流，方便调试）。 */
const IS_DEV =
  process.env.NODE_ENV !== "production" || process.env.DISABLE_RATE_LIMIT === "1";

/** 限流窗口与额度：单 IP 每分钟最多 5 次目标规划。 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const rateBuckets = new Map<string, number[]>();

/** 单天最多安排的累计时长（分钟）。 */
const MAX_DAILY_MIN = 240;

/** 兼容 IPv6 简写（::1）与 IPv4。 */
function getClientIp(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}

/** 滑动窗口限流：返回 null 表示放行，返回字符串表示拒绝原因。 */
function checkRateLimit(req: Request): string | null {
  if (IS_DEV) return null;
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) {
    rateBuckets.set(ip, bucket);
    return `请求过于频繁（每分钟最多 ${RATE_MAX} 次），请稍后再试`;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return null;
}

/** 把可能出现在错误文本里的密钥替换成 ***，避免上游报错把密钥透回浏览器。 */
function desensitize(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("***");
}

// 规划错误：带 HTTP 状态码，便于外层区分 401/429 等。
class PlanError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** 从模型回复里截取第一个 "{" 到最后一个 "}" 之间的内容再 parse。 */
function parseLoose(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new PlanError("JSON 解析失败：模型未返回可用的 JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

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

function dateToUtcMs(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 两个日期相差的天数（绝对值）。 */
function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(dateToUtcMs(a) - dateToUtcMs(b)) / 86400000);
}

/** 分钟数 → "HH:MM"（仅用于提示词里展示空闲时段）。 */
function padHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 找到「时间上最接近」且长度足够的空闲块：
 * 距离 = 日期相差天数 * 1440 + 开始分钟差值；取距离最小者。
 * 找不到（长度都不够）返回 null。
 */
function findClosestSlot(
  startMin: number,
  date: string,
  duration: number,
  freeSlots: FreeSlotInput[],
): FreeSlotInput | null {
  let best: FreeSlotInput | null = null;
  let bestDist = Infinity;
  for (const slot of freeSlots) {
    if (slot.endMin - slot.startMin < duration) continue;
    const dist = daysBetween(date, slot.date) * 1440 + Math.abs(slot.startMin - startMin);
    if (dist < bestDist) {
      bestDist = dist;
      best = slot;
    }
  }
  return best;
}

/**
 * 程序侧完成时段校验：
 * 1. 逐个 action：完全落在某个 freeSlot 内 → 保留；否则找最近空档挪过去（movedCount++）；
 *    找不到 → 丢弃（droppedCount++）。
 * 2. 同一天累计时长 > 240 分钟 → 丢弃该天最晚的子任务（droppedCount++），直到不再超。
 */
function validateActions(
  rawActions: unknown,
  freeSlots: FreeSlotInput[],
): { actions: GoalAction[]; movedCount: number; droppedCount: number } {
  const list = Array.isArray(rawActions) ? rawActions : [];
  const kept: GoalAction[] = [];
  let movedCount = 0;
  let droppedCount = 0;

  for (const raw of list) {
    const a = (raw ?? {}) as Record<string, unknown>;
    if (a.op !== "add") {
      droppedCount++;
      continue;
    }
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const detail = typeof a.detail === "string" ? a.detail.trim() : "";
    const date = typeof a.date === "string" ? a.date : "";
    const startMin = asInt(a.startMin);
    const endMin = asInt(a.endMin);

    if (!title || !date) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
      droppedCount++;
      continue;
    }

    const duration = endMin - startMin;
    const fits = freeSlots.some(
      (s) => s.date === date && s.startMin <= startMin && endMin <= s.endMin,
    );

    let finalDate = date;
    let finalStart = startMin;
    if (!fits) {
      const slot = findClosestSlot(startMin, date, duration, freeSlots);
      if (!slot) {
        droppedCount++;
        continue;
      }
      finalDate = slot.date;
      finalStart = slot.startMin;
      movedCount++;
    }

    kept.push({
      op: "add",
      date: finalDate,
      startMin: finalStart,
      endMin: finalStart + duration,
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

  return { actions: final, movedCount, droppedCount };
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
}): string {
  const slotsText = ctx.freeSlots
    .map((s) => `${s.date} ${padHHMM(s.startMin)}-${padHHMM(s.endMin)}`)
    .join("、");
  const existingText = ctx.existingTitles.length ? ctx.existingTitles.join("、") : "（暂无）";
  const weeklyText = Number.isFinite(ctx.hoursPerWeek) ? `${ctx.hoursPerWeek} 小时` : "未指定";

  return `你是「课表规划」应用的学习规划助手。请把一个学习目标拆解成具体可执行的子任务，并排进给定的空闲时段。只输出一个严格的 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。

目标信息：
- 目标：${ctx.title}
- 截止日期：${ctx.deadline || "未指定"}
- 每周投入：${weeklyText}
- 优先级：${ctx.priority || "未指定"}
- 今天：${ctx.today || "未知"}

可用的空闲时段（只能在这些时段内安排，不得越界）：
${slotsText || "（无）"}

已有事件标题（避免重复）：${existingText}

JSON 结构固定如下：
{
  "feasible": boolean,
  "actions": [
    { "op": "add", "date": "YYYY-MM-DD", "startMin": number, "endMin": number, "title": string, "kind": "task", "detail": string }
  ],
  "reason": "为什么这样排（2-4 句）",
  "advice": "若不可行或需要调整，给替代方案"
}

必须遵守的规则：
- 把目标拆成 4-12 个具体子任务，每个子任务 30-120 分钟。
- 每个 action 的 date、startMin、endMin 必须完全落在上面某个空闲时段内；startMin 和 endMin 都是自当天 00:00 起的分钟数。
- kind 一律写 "task"。
- title 写子任务名称，detail 写这一子任务具体做什么（一两句）。
- feasible=true 表示能完整安排；feasible=false 时 actions 可以为空数组或只排一部分，并且必须在 advice 里说明为什么不可行、给出替代建议。
- 所有数字字段输出数字类型，不要加引号。
- 只输出上面这一个 JSON。`;
}

/** 单次调用智谱接口并返回解析后的 JSON（不做重试）。 */
async function chatOnce(key: string, prompt: string): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new PlanError("规划超时，请稍后重试");
    }
    throw new PlanError("无法连接规划服务，请检查网络");
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (resp.status === 401) {
      throw new PlanError("密钥无效（401）：服务端 ZHIPU_API_KEY 配置不正确", 401);
    }
    if (resp.status === 429) {
      throw new PlanError("请求过于频繁，模型限流（429），请稍后再试", 429);
    }
    throw new PlanError(
      `规划服务返回错误（${resp.status}）：${desensitize(detail, key).slice(0, 200)}`,
    );
  }

  const json = await resp.json().catch(() => {
    throw new PlanError("模型接口响应不是合法 JSON");
  });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new PlanError("模型未返回内容");
  }
  return parseLoose(text);
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

export async function POST(req: Request) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) {
    return Response.json(
      { ok: false, error: "服务端未配置 ZHIPU_API_KEY，无法调用大模型" },
      { status: 500 },
    );
  }

  // 限流放在解析请求体之前：非法/超量请求不应消耗配额。
  const limited = checkRateLimit(req);
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

  try {
    const data = await chatOnce(
      key,
      buildPrompt({ title, deadline, hoursPerWeek, priority, freeSlots, existingTitles, today }),
    );
    const d = (data ?? {}) as Record<string, unknown>;
    const feasible = d.feasible === true;
    let reason = typeof d.reason === "string" ? d.reason.trim() : "";
    const advice = typeof d.advice === "string" ? d.advice.trim() : "";

    const { actions, movedCount, droppedCount } = validateActions(d.actions, freeSlots);

    // 总时长与 hoursPerWeek*60 偏差超过 30% → 在 reason 后追加提示。
    if (Number.isFinite(hoursPerWeek) && hoursPerWeek > 0) {
      const totalMin = actions.reduce((s, x) => s + (x.endMin - x.startMin), 0);
      const target = hoursPerWeek * 60;
      if (Math.abs(totalMin - target) / target > 0.3) {
        const note = `（注意：已排总时长约 ${Math.round(totalMin / 60)} 小时，与目标每周 ${hoursPerWeek} 小时偏差较大）`;
        reason = reason ? `${reason} ${note}` : note;
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
    const err = e instanceof PlanError ? e : new PlanError("目标规划失败，请稍后重试");
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}
