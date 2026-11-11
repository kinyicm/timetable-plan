/**
 * 课表规划 · 自然语言安排接口
 *
 * 调用智谱 GLM（OpenAI 兼容接口）把用户的一句话排程需求转成结构化「增删」动作。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），绝不接受客户端传入密钥。
 *
 * 职责边界：
 *   模型只负责「把自然语言翻译成语义」——输出「本周几 / 几点 / 多久」；
 *   日期算术、时间换算、字段合法性校验全部由服务端程序完成，不交给模型自行保证。
 */

// Vercel 最长执行时间（秒）。本地 dev 不强制，但保持一致。
export const maxDuration = 60;

/** 模型名：可换模型而不改代码（文本任务用对话模型即可）。 */
const MODEL = process.env.ZHIPU_TEXT_MODEL ?? "glm-4-flash";
/** 智谱 OpenAI 兼容 `chat/completions` 接口。 */
const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/** 与智谱接口基准超时（秒）对齐，略小于 maxDuration 留余量。 */
const FETCH_TIMEOUT_MS = 50_000;

/** 用户输入的自然语言长度上限（字数）。 */
const MAX_TEXT_LENGTH = 500;

/** 是否本地开发（本地不限流，方便调试）。 */
const IS_DEV =
  process.env.NODE_ENV !== "production" || process.env.DISABLE_RATE_LIMIT === "1";

/** 限流窗口与额度：单 IP 每分钟最多 5 次安排。 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const rateBuckets = new Map<string, number[]>();

/**
 * 兼容 IPv6 简写（::1）与 IPv4。
 * 优先取 x-real-ip，其次取 XFF 的最后一段（离服务器最近的一跳），
 * 都取不到时退化为 "unknown"（所有未知来源共享一个桶，宁可误伤不可放开）。
 */
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
    return `安排过于频繁（每分钟最多 ${RATE_MAX} 次），请稍后再试`;
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

// 安排错误：带 HTTP 状态码，便于外层区分 401/429 等。
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

/** 把「YYYY-MM-DD」加上若干天（用 UTC 计算，避免时区/夏令时干扰）。 */
function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** 把任意值转成整数；非法返回 NaN。 */
function asInt(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

type ConvertedAddAction = {
  op: "add";
  date: string;
  startMin: number;
  endMin: number;
  title: string;
  kind: "course" | "task" | "event";
  location: string;
  remindBeforeMin?: number;
};

type ConvertedDeleteAction = {
  op: "delete";
  date: string;
  matchTitle: string;
};

type ConvertedAction = ConvertedAddAction | ConvertedDeleteAction;

/**
 * 程序侧完成日期/时间换算与校验：
 * date = weekStart + (day-1) 天，startMin = startHour*60 + startMinute，
 * endMin = startMin + durationMin；不合法的条目丢弃并计数。
 */
function convertActions(
  rawActions: unknown,
  weekStart: string,
): { actions: ConvertedAction[]; droppedCount: number } {
  const actions = Array.isArray(rawActions) ? rawActions : [];
  const result: ConvertedAction[] = [];
  let droppedCount = 0;

  for (const raw of actions) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const op = a.op;

    if (op === "delete") {
      const matchTitle = typeof a.matchTitle === "string" ? a.matchTitle.trim() : "";
      const day = asInt(a.day);
      if (!matchTitle || !Number.isFinite(day) || day < 1 || day > 7) {
        droppedCount++;
        continue;
      }
      result.push({ op: "delete", date: addDaysToDateKey(weekStart, day - 1), matchTitle });
      continue;
    }

    if (op !== "add") {
      droppedCount++;
      continue;
    }

    const ev = (a.event ?? {}) as Record<string, unknown>;
    const title = typeof ev.title === "string" ? ev.title.trim() : "";
    const day = asInt(ev.day);
    const startHour = asInt(ev.startHour);
    const durationMin = asInt(ev.durationMin);
    const startMinuteRaw = asInt(ev.startMinute);
    const startMinute = Number.isFinite(startMinuteRaw)
      ? Math.max(0, Math.min(59, startMinuteRaw))
      : 0;

    if (!title) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(day) || day < 1 || day > 7) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(startHour) || startHour < 0 || startHour > 23) {
      droppedCount++;
      continue;
    }
    if (!Number.isFinite(durationMin) || durationMin < 15 || durationMin > 720) {
      droppedCount++;
      continue;
    }

    const startMin = startHour * 60 + startMinute;
    const endMin = startMin + durationMin;
    if (endMin > 1440) {
      droppedCount++;
      continue;
    }

    const kindRaw = typeof ev.kind === "string" ? ev.kind : "";
    const kind: ConvertedAddAction["kind"] =
      kindRaw === "course" || kindRaw === "task" || kindRaw === "event" ? kindRaw : "event";
    const location = typeof ev.location === "string" ? ev.location.trim() : "";
    const remindBeforeRaw = asInt(ev.remindBeforeMin);

    result.push({
      op: "add",
      date: addDaysToDateKey(weekStart, day - 1),
      startMin,
      endMin,
      title,
      kind,
      location,
      remindBeforeMin:
        Number.isFinite(remindBeforeRaw) && remindBeforeRaw > 0 ? remindBeforeRaw : undefined,
    });
  }

  return { actions: result, droppedCount };
}

/** 依据背景上下文拼出「把一句话转成语义（不涉及日期算术）」的提示词。 */
function buildPrompt(
  text: string,
  ctx: { today: string; weekStart: string; weekEnd: string; existing: string },
): string {
  return `你是「课表规划」应用的排程助手。请把用户的一句话需求翻译成一个严格的 JSON 对象，只输出 JSON，不要任何解释文字，不要用 markdown 代码块包裹。

背景信息（必须以此为准）：
- 今天是 ${ctx.today || "未知"}。
- 本周日期范围：${ctx.weekStart || "未知"}（周一）到 ${ctx.weekEnd || "未知"}（周日）。
- 本周已有事件摘要：
${ctx.existing || "（暂无）"}

用户的话：「${text}」

JSON 结构固定如下：
{
  "actions": [
    { "op": "add", "event": { "day": number, "startHour": number, "startMinute": number, "durationMin": number, "title": string, "kind": "course" | "task" | "event", "location": string, "remindBeforeMin": number } },
    { "op": "delete", "matchTitle": string, "day": number }
  ],
  "reply": "一句简短的中文回复"
}

必须遵守的规则：
- 绝对不要输出 date、startMin、endMin 这些字段，也不要自己算日期或分钟数；你只给「本周几 / 几点 / 持续多久」的语义。
- day 表示本周几：1=周一，2=周二，……，7=周日。用户说「周三」就写 day=3。
- startHour 是开始的小时（0-23）。用户说「晚上 7 点」就写 startHour=19；「上午 9 点」= 9；「下午 3 点」= 15。
- startMinute 是开始的分钟（0 或 30）。用户没说分钟就写 0。
- durationMin 是持续分钟数。用户说「到 9 点」（从 19 点开始）就写 durationMin=120；「一小时」= 60。
- title 必须是非空字符串，写清楚安排内容。
- kind 取值：course（课程）、task（任务）、event（一般事件）；拿不准就用 event。
- location 是地点；认不出就写空字符串 ""，不要猜。
- remindBeforeMin 是提前提醒分钟数（0 表示不提醒）；用户没提就写 0。
- op=add 表示新增一条安排；op=delete 表示删除一条已有安排，此时给 matchTitle（要删的标题）和 day（星期几），不要给 event。
- 若用户的话无需操作或无法理解，actions 返回空数组 []，reply 里说明原因。
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
      throw new PlanError("安排超时，请稍后重试");
    }
    throw new PlanError("无法连接安排服务，请检查网络");
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
      `安排服务返回错误（${resp.status}）：${desensitize(detail, key).slice(0, 200)}`,
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

export async function POST(req: Request) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) {
    return Response.json(
      { ok: false, error: "服务端未配置 ZHIPU_API_KEY，无法调用大模型" },
      { status: 500 },
    );
  }

  // 限流放在解析请求体之前：非法/超量请求不应该占用配额计数，也不该消耗带宽
  const limited = checkRateLimit(req);
  if (limited) {
    return Response.json({ ok: false, error: limited }, { status: 429 });
  }

  let body: { text?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ ok: false, error: "请输入要安排的内容" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { ok: false, error: `内容过长（最多 ${MAX_TEXT_LENGTH} 字）` },
      { status: 400 },
    );
  }

  const ctx = (body.context ?? {}) as Record<string, unknown>;
  const today = typeof ctx.today === "string" ? ctx.today : "";
  const weekStart = typeof ctx.weekStart === "string" ? ctx.weekStart : "";
  const weekEnd = typeof ctx.weekEnd === "string" ? ctx.weekEnd : "";
  const existing = typeof ctx.existing === "string" ? ctx.existing : "";

  try {
    const data = await chatOnce(key, buildPrompt(text, { today, weekStart, weekEnd, existing }));
    const d = (data ?? {}) as Record<string, unknown>;
    const reply = typeof d.reply === "string" ? d.reply.trim() : "";
    const { actions, droppedCount } = convertActions(d.actions, weekStart);
    return Response.json({ ok: true, actions, reply, droppedCount });
  } catch (e) {
    const err = e instanceof PlanError ? e : new PlanError("安排失败，请稍后重试");
    // 出口统一脱敏：任何返回给浏览器的错误文本都不允许出现密钥原文
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}
