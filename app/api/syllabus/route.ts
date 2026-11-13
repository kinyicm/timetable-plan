/**
 * 课表规划 · 知识点大纲接口
 *
 * 把一个学习目标拆成一份可执行的知识点清单，放在方案咨询（/api/advise）之前。
 * 动机：可行性判断原先靠模型自己估「学高数需要 80 小时」，主观且不稳定；
 * 改为先出知识点清单，总需求时长由程序把每条的 estimatedMinutes 求和得到，可行性才有客观依据。
 *
 * 职责边界：
 *   模型只负责拆知识点（name / category / difficulty / estimatedMinutes）；
 *   数量截断、estimatedMinutes 夹取、order 重排、totalEstimatedMinutes 求和全部由程序完成，模型不许编。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），绝不接受客户端传入密钥。
 */

import { chatOnce, desensitize, LlmError } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";
import type { KnowledgePoint } from "@/lib/types";

// Vercel 最长执行时间（秒）。与上游 fetch 超时（50s）对齐。
export const maxDuration = 60;

/** 模型名：可换模型而不改代码。 */
const MODEL = process.env.ZHIPU_TEXT_MODEL ?? "glm-4-flash";

/** 知识点拆解是轻量步骤，超时 50 秒。 */
const FETCH_TIMEOUT_MS = 50_000;

/** 请求体上限（字节）。syllabusText 可能是粘贴的教材目录，故放宽到 16KB。 */
const MAX_BODY_BYTES = 16 * 1024;

/** 知识点数量合法区间：程序夹取下限（过少视为失败）与上限（超出截断）。 */
const MIN_POINTS = 4;
const MAX_POINTS = 30;

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

/** 生成知识点 id（服务端 Node 环境可用 crypto.randomUUID）。 */
function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `kp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 拼出「拆知识点」的提示词（只出清单，不出任何时间/事件/时长汇总）。 */
function buildPrompt(ctx: { title: string; syllabusText: string }): string {
  const hasOutline = ctx.syllabusText.trim() !== "";
  const outlineSection = hasOutline
    ? `教材目录 / 考纲（这是唯一来源，只能拆它，不得添加它没有的内容）：
${ctx.syllabusText}`
    : "（未提供教材目录/考纲，按该科目主流教材与考纲生成通用大纲）";

  const countRule = hasOutline
    ? "必须恰好包含 8-20 个知识点"
    : "必须恰好包含 8-15 个知识点";

  const categoryRule = hasOutline
    ? "必须取自上面目录里的章标题，不要自己编造章节"
    : "用该科目主流教材的章节名";

  const scopeRule = hasOutline
    ? "只能拆分上面提供的目录内容，严禁添加目录里没有的知识点"
    : "这是一份通用大纲，可能与本校实际教学进度不同；请覆盖该科目的主干章节，按学习依赖排序（先修在前）";

  return `你是「课表规划」应用的知识点拆解引擎。请把一个学习目标拆成一份可执行的知识点清单。只输出一个严格的 JSON 对象，不要任何解释文字，不要用 markdown 代码块包裹。

目标：${ctx.title}

${outlineSection}

JSON 结构固定如下：
{
  "subject": "科目名，如「高等数学」",
  "points": [
    { "name": "具体知识点", "category": "所属章节", "difficulty": "基础", "estimatedMinutes": 60 }
  ]
}

必须遵守的规则：
- subject 用简洁的科目名（如「高等数学」「大学英语」），不要写目标全文。
- points 数组${countRule}。
- name 必须具体到一次能学完的粒度：用「洛必达法则」「隐函数求导」这类，禁止用「导数」「积分」这类过粗的表述。
- estimatedMinutes 是学完该知识点的预估分钟数，范围 30-240，按难度递增（基础偏短、难点偏长）。
- difficulty 只能是 "基础" / "进阶" / "难点" 三档之一。
- category 是所属章节名；${categoryRule}。
- ${scopeRule}。
- 不要输出任何日期、时间点、任务安排、时长汇总或 order 字段——这些全部由程序计算。
- 所有文字用简体中文。
- 只输出上面这一个 JSON。`;
}

/**
 * 校验并规范化模型返回的知识点：数量截断、estimatedMinutes 夹取、difficulty 兜底、
 * name 空值丢弃、order 重排、totalEstimatedMinutes 求和全部在此完成。
 */
function parsePoints(raw: unknown): { points: KnowledgePoint[]; droppedCount: number } {
  const rawPoints = Array.isArray(raw) ? raw : [];
  const points: KnowledgePoint[] = [];
  let droppedCount = 0;

  for (const item of rawPoints) {
    const p = (item ?? {}) as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    // name 为空：直接丢弃并计入 droppedCount，不产出没有名字的知识点。
    if (!name) {
      droppedCount++;
      continue;
    }

    const category = typeof p.category === "string" ? p.category.trim() : "";
    const difficultyRaw = typeof p.difficulty === "string" ? p.difficulty.trim() : "";
    const difficulty: KnowledgePoint["difficulty"] =
      difficultyRaw === "进阶" || difficultyRaw === "难点" ? difficultyRaw : "基础";

    let estimatedMinutes = asInt(p.estimatedMinutes);
    if (!Number.isFinite(estimatedMinutes)) estimatedMinutes = 60;
    // 夹取到 15..480，程序侧确定性约束，不信任模型给的数值。
    estimatedMinutes = Math.min(480, Math.max(15, estimatedMinutes));

    points.push({
      id: genId(),
      name,
      category,
      difficulty,
      estimatedMinutes,
      order: 0, // 稍后统一重排为 1..n
    });
  }

  // 数量上限 30：超出截断并计入 droppedCount。
  if (points.length > MAX_POINTS) {
    droppedCount += points.length - MAX_POINTS;
    points.splice(MAX_POINTS);
  }

  // order 一律按数组顺序重排为 1..n，忽略模型给出的顺序。
  points.forEach((p, i) => {
    p.order = i + 1;
  });

  return { points, droppedCount };
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
  const limited = checkRateLimit(req, "syllabus", 5, "请求");
  if (limited) {
    return Response.json({ ok: false, error: limited }, { status: 429 });
  }

  const rawText = await req.text().catch(() => "");
  if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "请求体过大（最多 16KB）" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const goal = (body.goal ?? {}) as Record<string, unknown>;
  const title = typeof goal.title === "string" ? goal.title.trim() : "";
  const syllabusText = typeof body.syllabusText === "string" ? body.syllabusText : "";

  if (!title) {
    return Response.json({ ok: false, error: "请填写目标标题" }, { status: 400 });
  }

  const hasOutline = syllabusText.trim() !== "";

  try {
    const data = await chatOnce({
      key,
      model: MODEL,
      content: buildPrompt({ title, syllabusText }),
      timeoutMs: FETCH_TIMEOUT_MS,
      service: "知识点大纲",
      timeoutMessage: "知识点大纲生成超时，请稍后重试",
      timeoutStatus: 200,
    });
    const d = (data ?? {}) as Record<string, unknown>;

    const subject = typeof d.subject === "string" && d.subject.trim() ? d.subject.trim() : title;

    const { points, droppedCount } = parsePoints(d.points);

    // 知识点过少（<4）说明模型未能产出可用大纲，返回友好错误而非 500。
    if (points.length < MIN_POINTS) {
      throw new LlmError("未能生成有效知识点清单（知识点过少），请重试", 500);
    }

    const totalEstimatedMinutes = points.reduce((s, p) => s + p.estimatedMinutes, 0);

    return Response.json({
      ok: true,
      subject,
      points,
      totalEstimatedMinutes,
      source: hasOutline ? "outline-provided" : "ai-generated",
      droppedCount,
    });
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError("知识点大纲生成失败，请稍后重试");
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}
