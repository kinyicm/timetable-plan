/**
 * 课表规划 · 方案咨询接口
 *
 * 只做「可行性判断 + 2-3 个候选方案思路」，绝不生成事件/时间点。
 * 与 /api/goal 拆分：目标大时一次生成全部事件会超时，先出方案（轻），选定后再出事件（重）。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），绝不接受客户端传入密钥。
 *
 * 职责边界：
 *   模型只负责估「所需总时长」并给出 3 个方案思路（频次、单次时长、优缺点）；
 *   supplyHours / gapHours / verdict / 每个方案的 totalHours 全部由程序算出，模型不许编。
 */

import { chatOnce, desensitize, LlmError } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";

// Vercel 最长执行时间（秒）。方案咨询是轻量步骤，与上游 fetch 超时（50s）对齐。
export const maxDuration = 60;

/** 模型名：可换模型而不改代码。 */
const MODEL = process.env.ZHIPU_TEXT_MODEL ?? "glm-4-flash";

/** 方案咨询是轻量步骤，超时放宽到 50 秒即可。 */
const FETCH_TIMEOUT_MS = 50_000;

/** 请求体上限（字节）。 */
const MAX_BODY_BYTES = 8 * 1024;

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

/** 保留一位小数。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

type AdviseOption = {
  id: "A" | "B" | "C";
  name: string;
  strategy: "daily" | "weekly" | "sprint";
  summary: string;
  sessionsPerWeek: number;
  avgSessionMin: number;
  totalHours: number;
  pros: string[];
  cons: string[];
  risk: string;
};

/** 校验并规范化模型返回的方案：totalHours 由程序按 sessionsPerWeek × avgSessionMin × 周数 算出。 */
function parseOptions(raw: unknown, weeksUntilDeadline: number): AdviseOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AdviseOption[] = [];

  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim().toUpperCase() : "";
    if (id !== "A" && id !== "B" && id !== "C") continue;
    if (seen.has(id)) continue;
    const strategy = typeof o.strategy === "string" ? o.strategy : "";
    if (strategy !== "daily" && strategy !== "weekly" && strategy !== "sprint") continue;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const summary = typeof o.summary === "string" ? o.summary.trim() : "";
    const sessionsPerWeek = asInt(o.sessionsPerWeek);
    const avgSessionMin = asInt(o.avgSessionMin);
    if (!name || !summary) continue;
    if (!Number.isFinite(sessionsPerWeek) || sessionsPerWeek < 1 || sessionsPerWeek > 7) continue;
    if (!Number.isFinite(avgSessionMin) || avgSessionMin < 20 || avgSessionMin > 240) continue;

    const pros = (Array.isArray(o.pros) ? o.pros.filter((p): p is string => typeof p === "string") : []).slice(0, 3);
    const cons = (Array.isArray(o.cons) ? o.cons.filter((c): c is string => typeof c === "string") : []).slice(0, 3);
    const risk = typeof o.risk === "string" ? o.risk.trim() : "";

    seen.add(id);
    out.push({
      id,
      name,
      strategy,
      summary,
      sessionsPerWeek,
      avgSessionMin,
      totalHours: round1((sessionsPerWeek * avgSessionMin * weeksUntilDeadline) / 60),
      pros,
      cons,
      risk,
    });
  }

  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * 程序兜底的三个候选方案：当模型返回的方案缺失或不可用时，保证仍能给出自洽的 A/B/C 三选。
 * 数字全部由程序按 hoursPerWeek 反推并夹取到合法区间（20-240 分钟 / 每周 1-7 次），totalHours 由调用方补算。
 */
function synthesizeOptions(hoursPerWeek: number, weeksUntilDeadline: number): AdviseOption[] {
  const cap = (n: number) => Math.min(240, Math.max(20, Math.round(n)));
  const specs: Omit<AdviseOption, "totalHours">[] = [
    {
      id: "A",
      name: "分散式",
      strategy: "daily",
      summary: "每天投入固定时间，细水长流贯穿全程，适合养成稳定习惯。",
      sessionsPerWeek: 7,
      avgSessionMin: cap((hoursPerWeek * 60) / 7),
      pros: ["每天推进，遗忘率低", "易于形成长期习惯", "压力分散，更易坚持"],
      cons: ["要求每天坚持，中断代价高", "单次时间较短，深度有限"],
      risk: "连续中断几天后容易前功尽弃。",
    },
    {
      id: "B",
      name: "集中式",
      strategy: "weekly",
      summary: "每周集中 2-3 次深度学习，单次投入大、推进更快。",
      sessionsPerWeek: 3,
      avgSessionMin: cap((hoursPerWeek * 60) / 3),
      pros: ["单次深入，适合攻坚难点", "每周次数少，安排更灵活", "更容易进入心流状态"],
      cons: ["间隔较长，容易遗忘", "单次过长易疲劳"],
      risk: "两次学习之间遗忘较快，需额外安排复习衔接。",
    },
    {
      id: "C",
      name: "冲刺式",
      strategy: "sprint",
      summary: "前期打基础、后期高强度冲刺，适合临近截止的目标。",
      sessionsPerWeek: 4,
      avgSessionMin: cap((hoursPerWeek * 60) / 4),
      pros: ["前期压力小，容易启动", "后期集中突破，效率高"],
      cons: ["后期强度高，压力大", "基础不牢易崩盘"],
      risk: "冲刺期若状态不佳或时间不足，风险较高。",
    },
  ];
  return specs.map((s) => ({
    ...s,
    totalHours: round1((s.sessionsPerWeek * s.avgSessionMin * weeksUntilDeadline) / 60),
  }));
}

/** 拼出「可行性判断 + 3 个方案思路」的提示词（这一轮只出思路，不出事件）。 */
function buildPrompt(ctx: {
  title: string;
  deadline: string;
  hoursPerWeek: number;
  priority: string;
  today: string;
  freeHoursThisWeek: number;
  weeksUntilDeadline: number;
  existingTitles: string[];
}): string {
  const existingText = ctx.existingTitles.length ? ctx.existingTitles.join("、") : "（暂无）";
  // 给模型一个具体的「每天 / 每周 2-3 次」对应时长示例，避免它停留在 30-60 分钟的量级。
  const clampMin = (n: number) => Math.min(240, Math.max(20, Math.round(n)));
  const dailyExampleMin = clampMin((ctx.hoursPerWeek * 60) / 7);
  const weeklyExampleMin = clampMin((ctx.hoursPerWeek * 60) / 3);
  const weeklyLow = Math.max(1, Math.round(ctx.hoursPerWeek * 0.8));
  const weeklyHigh = Math.max(weeklyLow + 1, Math.round(ctx.hoursPerWeek * 1.15));
  return `你是「课表规划」应用的学习规划顾问。请针对一个学习目标，只输出可行性判断所需的信息与 3 个候选方案思路（这一轮只出思路，绝不输出任何事件、时间点或日期）。只输出一个严格的 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。

目标信息：
- 目标：${ctx.title}
- 截止日期：${ctx.deadline || "未指定"}
- 每周计划投入：${ctx.hoursPerWeek} 小时
- 优先级：${ctx.priority || "未指定"}
- 今天：${ctx.today || "未知"}
- 本周可用小时：${ctx.freeHoursThisWeek} 小时
- 距离截止日期：约 ${ctx.weeksUntilDeadline} 周

已有事件标题（避免方案与现有安排重复）：${existingText}

JSON 结构固定如下：
{
  "requiredHours": number,
  "options": [
    { "id": "A", "name": string, "strategy": "daily", "summary": string, "sessionsPerWeek": number, "avgSessionMin": number, "pros": [string], "cons": [string], "risk": string }
  ],
  "recommendation": "A",
  "recommendReason": string
}

必须遵守的规则：
- requiredHours 是你独立估计的「达成该目标大致需要的总小时数」，要基于目标本身的工作量，而不是套用可用时间。参考量级：备考一门课到 80 分约需 40-80 小时；学一门专业课约需 80-150 小时；「一个月内学完三门专业课」约需 300 小时以上。可用总时长是 ${(ctx.hoursPerWeek * ctx.weeksUntilDeadline).toFixed(1)} 小时，但 requiredHours 按目标难度如实估计，可以低于、接近或远超可用总时长。
- options 必须恰好 3 个，id 依次为 A、B、C，缺一不可，strategy 依次覆盖 daily / weekly / sprint 三种思路：
  · daily（分散式）：频率最高（每天），单次较短，记忆最牢但要求每天坚持；
  · weekly（集中式）：每周 2-3 次，单次最长，深入但间隔长易忘；
  · sprint（冲刺式）：前期频率低、后期频率高，单次时长中等。
- 三种方案的「每周总时长」尽量都接近 ${ctx.hoursPerWeek} 小时（落在 ${weeklyLow}~${weeklyHigh} 小时之间）：即 sessionsPerWeek × avgSessionMin ÷ 60 应在此区间。参考：每周 ${ctx.hoursPerWeek} 小时时，daily 约为 7 次 × ${dailyExampleMin} 分钟，weekly 约为 3 次 × ${weeklyExampleMin} 分钟，sprint 平均约 4 次（前期少、后期多）。sessionsPerWeek 是 1-7 的整数，avgSessionMin 是 20-240 的整数；若反推的单次时长超过 240 分钟，就填 240 并把次数提到上限 7。
- summary 用一句话（20-40 字）概括思路；pros 写 2-3 条优点；cons 写 2-3 条代价；risk 写一句话风险提示。
- recommendation 是三个方案里最推荐的一个 id；recommendReason 说明推荐理由（2-3 句）。如果时间明显不够，recommendReason 里必须给出三条可选的调整方向。
- 所有文字（name、summary、pros、cons、risk、recommendReason）一律用简体中文输出。
- 不要输出 verdict、note、totalHours 或任何时间点、日期、事件——这些由程序计算。
- 所有数字字段输出数字类型，不要加引号。
- 只输出上面这一个 JSON。`;
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
  const limited = checkRateLimit(req, "advise", 5, "请求");
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
  const hoursPerWeekRaw = asNumber(goal.hoursPerWeek);
  const hoursPerWeek = Number.isFinite(hoursPerWeekRaw) && hoursPerWeekRaw > 0 ? hoursPerWeekRaw : 10;

  if (!title) {
    return Response.json({ ok: false, error: "请填写目标标题" }, { status: 400 });
  }

  const context = (body.context ?? {}) as Record<string, unknown>;
  const today = typeof context.today === "string" ? context.today : "";
  const weeksRaw = asNumber(context.weeksUntilDeadline);
  const weeksUntilDeadline = Number.isFinite(weeksRaw) && weeksRaw > 0 ? weeksRaw : 4;
  const freeHoursRaw = asNumber(context.freeHoursThisWeek);
  const freeHoursThisWeek = Number.isFinite(freeHoursRaw) && freeHoursRaw >= 0 ? freeHoursRaw : 0;
  const existingTitles = Array.isArray(context.existingTitles)
    ? context.existingTitles.filter((t): t is string => typeof t === "string")
    : [];
  // 可选：来自知识点清单的客观需求时长（小时）。传入则不再让模型估。
  const requiredHoursRaw = asNumber(context.requiredHours);
  const providedRequiredHours =
    Number.isFinite(requiredHoursRaw) && requiredHoursRaw > 0 ? round1(requiredHoursRaw) : null;

  try {
    const data = await chatOnce({
      key,
      model: MODEL,
      content: buildPrompt({
        title,
        deadline,
        hoursPerWeek,
        priority,
        today,
        freeHoursThisWeek,
        weeksUntilDeadline,
        existingTitles,
      }),
      timeoutMs: FETCH_TIMEOUT_MS,
      service: "咨询",
      timeoutMessage: "方案咨询超时，请稍后重试",
      timeoutStatus: 200,
    });
    const d = (data ?? {}) as Record<string, unknown>;

    // 需求时长优先用传入的（来自知识点清单，客观）；缺失时才让模型估。
    let requiredHours: number;
    let fromSyllabus = false;
    if (providedRequiredHours !== null) {
      requiredHours = providedRequiredHours;
      fromSyllabus = true;
    } else {
      const estimated = asNumber(d.requiredHours);
      if (!Number.isFinite(estimated) || estimated <= 0) {
        throw new LlmError("模型未能给出所需总时长，请重试", 500);
      }
      requiredHours = round1(estimated);
    }

    // 供给 = 每周投入 × 剩余周数；缺口 = 供给 - 需求，程序侧确定性计算。
    const supplyHours = round1(hoursPerWeek * weeksUntilDeadline);
    const gapHours = round1(supplyHours - requiredHours);

    let verdict: "可行" | "紧张" | "不可行";
    if (gapHours < -0.2 * requiredHours) {
      verdict = "不可行";
    } else if (gapHours < 0) {
      verdict = "紧张";
    } else {
      verdict = "可行";
    }

    // 合并模型方案与程序兜底：始终保证 A/B/C 三个自洽方案，模型返回不全时用兜底补齐。
    const fallback = synthesizeOptions(hoursPerWeek, weeksUntilDeadline);
    const parsed = parseOptions(d.options, weeksUntilDeadline);
    const byId = new Map(parsed.map((o) => [o.id, o]));
    const options: AdviseOption[] = fallback.map((f) => byId.get(f.id) ?? f);

    let recommendation = typeof d.recommendation === "string" ? d.recommendation.trim().toUpperCase() : "";
    if (!options.some((o) => o.id === recommendation)) {
      recommendation = options[0].id;
    }

    let recommendReason = typeof d.recommendReason === "string" ? d.recommendReason.trim() : "";
    if (verdict === "不可行") {
      const hint = "建议从三方面调整：① 缩小目标范围或降低标准；② 延长截止日期；③ 增加每周投入时长。";
      if (!recommendReason.includes("①") && !recommendReason.includes("方向")) {
        recommendReason = recommendReason ? `${recommendReason} ${hint}` : hint;
      }
    }

    const noteBase =
      verdict === "不可行"
        ? `按每周 ${hoursPerWeek} 小时、距截止 ${weeksUntilDeadline} 周，可用约 ${supplyHours} 小时，而目标约需 ${requiredHours} 小时，缺口 ${round1(Math.abs(gapHours))} 小时，时间明显不足`
        : verdict === "紧张"
          ? `可用约 ${supplyHours} 小时，目标约需 ${requiredHours} 小时，时间偏紧，需要提高效率`
          : `可用约 ${supplyHours} 小时，目标约需 ${requiredHours} 小时，时间基本够用`;
    // 口径说明：需求时长来自知识点清单则为客观估算，否则标注为模型估算值。
    const note = `${noteBase}${fromSyllabus ? "（需求按知识点清单估算）" : "（需求时长为估算值）"}`;

    return Response.json({
      ok: true,
      feasibility: {
        verdict,
        requiredHours: round1(requiredHours),
        supplyHours,
        gapHours,
        note,
      },
      options,
      recommendation,
      recommendReason,
    });
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError("方案咨询失败，请稍后重试");
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}
