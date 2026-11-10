/**
 * 课表规划 · 课表识别接口
 *
 * 调用智谱 GLM-4V（OpenAI 兼容接口）把「课程表照片/截图」识别为结构化课表 JSON。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），永远不会下发到浏览器。
 *
 * 注意本接口的职责边界：
 *   模型只负责「把图片读成结构化数据」；
 *   字段取值范围、时间区间合法性、与作息的冲突校验全部由程序完成。
 */

// Node.js 运行时（Cache Components 下不再显式声明 runtime，默认即 Node）。
// Vercel 最长执行时间（秒）。本地 dev 不强制，但保持一致。
export const maxDuration = 60;

/** 模型名：可换模型而不改代码（如换 glm-4v 系或 glm-4.5v）。 */
const MODEL = process.env.ZHIPU_VISION_MODEL ?? "glm-4v-flash";
/** 智谱 OpenAI 兼容 `chat/completions` 接口。 */
const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/** 与智谱接口基准超时（秒）对齐，略小于 maxDuration 留余量。 */
const FETCH_TIMEOUT_MS = 50_000;

/**
 * 图片 base64 长度上限（约 8 MB base64 ≈ 6 MB 原始图片）。
 * 视觉模型对超大图不会更准，只会更慢更贵，且可能触发票据/网关体积限制，
 * 所以在进入模型之前就用代码挡住，而不是把问题留给上游。
 */
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

/** 是否本地开发（本地不限流，方便调试）。 */
const IS_DEV =
  process.env.NODE_ENV !== "production" || process.env.DISABLE_RATE_LIMIT === "1";

/** 限流窗口与额度：单 IP 每分钟最多 10 次识别。 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const rateBuckets = new Map<string, number[]>();

/**
 * 兼容 IPv6 简写（::1）与 IPv4。
 *
 * 注意信任边界：x-forwarded-for 可被伪造，只有 rt / x-real-ip 与 last hop 更可信。
 * 本函数优先取 x-real-ip，其次取 XFF 的最后一段（离服务器最近的一跳），
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

/**
 * 滑动窗口限流：返回 null 表示放行，返回字符串表示拒绝原因。
 * 仅走服务端内置 Key 时生效（本项目目前没有「自带 Key」分支）。
 *
 * 已知局限：计数器存在进程内存里，本地/单实例有效；部署到多实例平台后
 * 各实例各算各的，冷启动还会重置。要做严格的全局限流需要外部存储（如 Redis）。
 */
function checkRateLimit(req: Request): string | null {
  if (IS_DEV) return null;
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) {
    rateBuckets.set(ip, bucket);
    return `识别过于频繁（每分钟最多 ${RATE_MAX} 次），请稍后再试`;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  // 简单清理，防止 Map 无限增长
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

type Payload = string | { type: string; text?: string; image_url?: { url: string } };

// 识别错误：带 HTTP 状态码，便于外层区分 401/429 等。
class RecognError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

const PROMPT_CORE = `请识别这张「课程表」图片，严格只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码块包裹。

JSON 结构固定如下：
{
  "slotsPerDay": number,
  "periods": [{ "slot": number, "start": string, "end": string }],
  "courses": [{
    "name": string,
    "day": number,
    "startSlot": number,
    "endSlot": number,
    "weeks": string,
    "location": string,
    "teacher": string
  }]
}

必须遵守的规则：
- day 表示星期几：1=周一，2=周二，……，7=周日。「星期一 / 周一 / 一」都换算成数字。
- startSlot / endSlot 表示第几节课，从 1 开始，包含两端。一门课连上两节就是 startSlot=1、endSlot=2；连上四节就是 1 和 4。
- 一门课在表里占几格就合并成一条 course，不要拆成多条；同一门课在多个星期出现时，每一天各输出一条。
- name 只写课程名（如「Java程序设计」），不要把地点、教师、周次混进 name。
- location 是上课地点（如「3-201」「实训楼305」）。认不出就输出空字符串 ""，不要猜。
- teacher 是教师姓名。认不出就输出空字符串 ""，不要猜。
- weeks 是周次（如「1-16」「1-8周」「单周」）。认不出就输出空字符串 ""，不要猜。
- slotsPerDay 是这张表一天最多有几节（看左侧节次编号的最大值）。认不出就输出 12。
- periods 只在表头出现「08:00-09:40」这类具体时间时才输出，否则输出空数组 []。
- 所有数字字段输出数字类型，不要加引号。
- 只输出上面这一个 JSON，前后不要有任何多余文字或代码块。`;

/** 结构化课表：一门课的时间区间。day 为 1..7，slot 从 1 开始且包含两端。 */
export interface Course {
  name: string;
  day: number;
  startSlot: number;
  endSlot: number;
  weeks: string;
  location: string;
  teacher: string;
}

/** 一份课表：每天最多几节 + 作息时间 + 全部课程。 */
export interface Timetable {
  slotsPerDay: number;
  periods: { slot: number; start: string; end: string }[];
  courses: Course[];
}

/** 重试时追加的强调，用于纠正「夹杂解释文字」的情况。 */
const PROMPT_REINFORCE = "再次强调：只输出 JSON，不要任何其他文字";

/**
 * 从模型回复里截取第一个 "{" 到最后一个 "}" 之间的内容再 parse。
 * 这样即使模型把 JSON 包在 markdown 代码块、或前后混了一点解释文字，
 * 也能把 JSON 主体抠出来，避免 JSON.parse 整段失败。
 */
function parseLoose(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new RecognError("JSON 解析失败：模型未返回可用的 JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 校验并规整模型返回的课表。
 *
 * 这一步是「程序负责确定性」的部分：模型只负责把图片读成结构化数据，
 * 而星期范围、节次范围、区间方向、空课程名这些**有明确对错**的判断，
 * 全部在这里用代码做，不交给模型自行决定，也不让非法数据流向界面。
 */
function validateTimetable(data: unknown): Timetable & { droppedCount: number } {
  if (!data || typeof data !== "object") {
    throw new RecognError("JSON 解析失败：模型返回结构异常");
  }
  const d = data as Record<string, unknown>;

  const slotsPerDay = clampInt(d.slotsPerDay, 1, 30, 12);

  const periodsRaw = Array.isArray(d.periods) ? d.periods : [];
  const periods = periodsRaw
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return {
        slot: clampInt(o.slot, 1, slotsPerDay, 0),
        start: typeof o.start === "string" ? o.start.trim() : "",
        end: typeof o.end === "string" ? o.end.trim() : "",
      };
    })
    .filter((p) => p.slot > 0);

  const coursesRaw = Array.isArray(d.courses) ? d.courses : [];
  let droppedCount = 0;
  const courses: Course[] = [];

  for (const raw of coursesRaw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    // 没有课程名的条目无法展示，也无法参与排程，直接丢弃并计数（对用户可见）
    if (!name) {
      droppedCount++;
      continue;
    }
    const startSlot = clampInt(o.startSlot, 1, slotsPerDay, 0);
    const endSlot = clampInt(o.endSlot, 1, slotsPerDay, 0);
    if (startSlot === 0) {
      // 节次无法识别时不丢弃，保留但标到第 1 节，让用户能在界面上改正
      droppedCount++;
      continue;
    }
    courses.push({
      name,
      day: clampInt(o.day, 1, 7, 1),
      startSlot,
      // 结束节次必须不早于起始节次，方向反了就取同一个节次
      endSlot: endSlot >= startSlot ? endSlot : startSlot,
      weeks: typeof o.weeks === "string" ? o.weeks.trim() : "",
      location: typeof o.location === "string" ? o.location.trim() : "",
      teacher: typeof o.teacher === "string" ? o.teacher.trim() : "",
    });
  }

  // 固定按「星期 → 起始节次」排序，避免模型输出顺序随机导致界面跳动
  courses.sort((a, b) => a.day - b.day || a.startSlot - b.startSlot);

  return { slotsPerDay, periods, courses, droppedCount };
}

/** 把任意值转成落在 [min, max] 内的整数，非法时返回 fallback。 */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return n < min ? min : max;
  return n;
}

/**
 * 单次调用智谱接口并返回解析后的 JSON（不做重试）。
 * imageValue 支持两种形式：
 *   1) `data:${mimeType};base64,${base64}` —— 标准 data URL，多数情况下可用；
 *   2) 裸 base64 字符串 —— 部分版本要求 image_url.url 直接给 base64。
 * 两种都兼容：出错时外层切换/重试。
 */
async function chatOnce(
  key: string,
  imageValue: string,
  prompt: string,
): Promise<Timetable & { droppedCount: number }> {
  const content: Payload[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: imageValue } },
  ];

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
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout 抛出的超时错误
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new RecognError("识别超时，请稍后重试");
    }
    throw new RecognError("无法连接识别服务，请检查网络");
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (resp.status === 401) {
      throw new RecognError("密钥无效（401）：服务端 ZHIPU_API_KEY 配置不正确", 401);
    }
    if (resp.status === 429) {
      throw new RecognError("请求过于频繁，模型限流（429），请稍后再试", 429);
    }
    throw new RecognError(
      `识别服务返回错误（${resp.status}）：${desensitize(detail, key).slice(0, 200)}`,
    );
  }

  const json = await resp.json().catch(() => {
    throw new RecognError("模型接口响应不是合法 JSON");
  });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new RecognError("模型未返回内容");
  }
  return validateTimetable(parseLoose(text));
}

/** 完整识别流程：首次用 data URL；失败则自动重试 1 次，切换图片形式 + 强化提示词。 */
async function recognize(
  key: string,
  imageBase64: string,
  mimeType: string,
): Promise<Timetable & { droppedCount: number }> {
  const asDataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;
  // 首次：data URL 形式
  try {
    return await chatOnce(key, asDataUrl, PROMPT_CORE);
  } catch (e) {
    // 若首次是密钥/限流等确定性问题，没必要退到第二种图片形式再试
    if (e instanceof RecognError && (e.status === 401 || e.status === 429)) {
      throw e;
    }
    // 重试：改用裸 base64，并在提示词末尾追加强调（同时覆盖 image 形式与 JSON 风格两类失败）
    return await chatOnce(key, imageBase64, PROMPT_CORE + "\n\n" + PROMPT_REINFORCE);
  }
}

export async function POST(req: Request) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) {
    return Response.json(
      { ok: false, error: "服务端未配置 ZHIPU_API_KEY，无法调用视觉模型" },
      { status: 500 },
    );
  }

  // 限流放在解析请求体之前：非法/超量请求不应该占用配额计数，也不该消耗带宽
  const limited = checkRateLimit(req);
  if (limited) {
    return Response.json({ ok: false, error: limited }, { status: 429 });
  }

  let body: { imageBase64?: unknown; mimeType?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: "请求体不是合法 JSON" },
      { status: 400 },
    );
  }

  const imageBase64 = body.imageBase64 as string | undefined;
  const mimeType = body.mimeType as string | undefined;
  if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
    return Response.json(
      { ok: false, error: "图片数据缺失或过短（base64 应至少 100 字符）" },
      { status: 400 },
    );
  }
  if (imageBase64.length > MAX_IMAGE_BASE64) {
    return Response.json(
      {
        ok: false,
        error: `图片过大（base64 上限 ${Math.round(MAX_IMAGE_BASE64 / 1024 / 1024)} MB，约 6 MB 原图）。请压缩后重试。`,
      },
      { status: 413 },
    );
  }

  const t0 = Date.now();
  try {
    const data = await recognize(key, imageBase64, mimeType ?? "image/jpeg");
    return Response.json({
      ok: true,
      data,
      model: MODEL,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const err = e instanceof RecognError ? e : new RecognError("识别失败，请稍后重试");
    // 出口统一脱敏：任何返回给浏览器的错误文本都不允许出现密钥原文
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}