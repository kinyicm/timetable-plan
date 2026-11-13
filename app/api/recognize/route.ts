import { blocksToCourses, type Course } from "@/lib/blocksToCourses";
import { chatOnce, desensitize, LlmError, type LlmMessage } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * 课表规划 · 课表识别接口
 *
 * 调用智谱 GLM-4V（OpenAI 兼容接口）把「课程表照片/截图」识别为结构化课表 JSON。
 * 密钥只从服务端环境变量读取（ZHIPU_API_KEY），永远不会下发到浏览器。
 *
 * 注意本接口的职责边界：
 *   模型只负责「把每一门课抽成一条课程块」；
 *   星期 / 节次取值范围、区间方向等确定性校验全部由程序完成。
 */

// Node.js 运行时（Cache Components 下不再显式声明 runtime，默认即 Node）。
// Vercel 最长执行时间（秒）。本地 dev 不强制，但保持一致。
export const maxDuration = 60;

/** 模型名：可换模型而不改代码（如换 glm-4v 系或 glm-4.5v）。 */
const MODEL = process.env.ZHIPU_VISION_MODEL ?? "glm-4v-flash";

/** 与智谱接口基准超时（秒）对齐，略小于 maxDuration 留余量。 */
const FETCH_TIMEOUT_MS = 50_000;

/**
 * 图片 base64 长度上限（约 8 MB base64 ≈ 6 MB 原始图片）。
 * 视觉模型对超大图不会更准，只会更慢更贵，且可能触发票据/网关体积限制，
 * 所以在进入模型之前就用代码挡住，而不是把问题留给上游。
 */
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

const PROMPT_CORE = `请识别这张「课程表」图片，把每一门课抽成一条记录。严格只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码块包裹。

JSON 结构固定如下：
{
  "slotCount": number,
  "colCount": number,
  "periods": [{ "slot": number, "start": string, "end": string }],
  "blocks": [{
    "name": string,
    "colIndex": number,
    "rowStart": number,
    "rowEnd": number,
    "leftRatio": number,
    "location": string,
    "weeks": string
  }]
}

必须遵守的规则：
- 一门课输出一条 block。
- colIndex 是你自己判断的「第几列」，1=周一、2=周二 … 7=周日。优先看表头里的「一/二/三/…/日」文字来定，忽略表头里的日期数字。
- rowStart / rowEnd 是你自己判断的「第几节」：看该块在纵向对应的左侧节次编号。rowStart 是起始节次，rowEnd 是结束节次（含两端）。若某块明显占到多行，rowEnd 要相应增大，不要永远等于 rowStart。
- leftRatio 只填一个数：该块中心相对「表体」横向的比例（0..1）。以表体为准：第 1 列左边界 = 0，最后一列右边界 = 1；不要包含左侧节次文字区与表头。它只用于程序校验你的 colIndex，允许有误差。
- slotCount 是整张表一共几行节次（看左侧节次编号的最大值，例如 11）。
- colCount 是一共几列（周一到周日就是 7）。
- location 是上课地点；认不出就输出空字符串 ""，不要猜。
- 「非本周」「单周」「双周」写进 weeks，并从 name 里去掉；没有就输出空字符串 ""。
- name 只写课程名，不要带地点、不要带「（一）」这类序号后缀。
- periods 只在左侧出现「08:00-09:40」这类具体时间时才输出，否则输出空数组 []。
- 所有数字字段输出数字类型，不要加引号。
- 只输出上面这一个 JSON，前后不要有任何多余文字或代码块。`;

/** 重试时追加的强调，用于纠正「夹杂解释文字」的情况。 */
const PROMPT_REINFORCE = "再次强调：只输出 JSON，不要任何其他文字";

/**
 * 程序侧把模型返回的课程块列表规整成最终结构，并调用 blocksToCourses 换算坐标。
 *
 * 这一步是「程序负责确定性」的部分：模型只负责抽出每一门课，
 * 而星期 / 节次取值范围、区间方向这些**有明确对错**的判断，
 * 全部在这里用代码做，不交给模型自行决定，也不让非法数据流向界面。
 */
function buildData(raw: unknown): {
  slotsPerDay: number;
  periods: { slot: number; start: string; end: string }[];
  courses: Course[];
  invalidCount: number;
  colCount: number;
  spanSuspect: boolean;
  suspectCount: number;
} {
  if (!raw || typeof raw !== "object") {
    throw new LlmError("JSON 解析失败：模型返回结构异常");
  }
  const d = raw as Record<string, unknown>;

  const slotsPerDay = clampInt(d.slotCount, 1, 30, 11);

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

  const { courses, invalidCount, colCount, spanSuspect, suspectCount } = blocksToCourses(raw);

  return { slotsPerDay, periods, courses, invalidCount, colCount, spanSuspect, suspectCount };
}

/** 识别成功后的最终返回结构。 */
type RecognizedTimetable = ReturnType<typeof buildData>;

/** 把任意值转成落在 [min, max] 内的整数，非法时返回 fallback。 */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return n < min ? min : max;
  return n;
}

/**
 * 单次调用视觉模型（不做重试）。
 * imageValue 支持两种形式：
 *   1) `data:${mimeType};base64,${base64}` —— 标准 data URL，多数情况下可用；
 *   2) 裸 base64 字符串 —— 部分版本要求 image_url.url 直接给 base64。
 * 两种都兼容：出错时外层切换/重试。
 */
function visionChat(key: string, imageValue: string, prompt: string): Promise<unknown> {
  const content: LlmMessage[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: imageValue } },
  ];
  return chatOnce({
    key,
    model: MODEL,
    content,
    timeoutMs: FETCH_TIMEOUT_MS,
    service: "识别",
    timeoutMessage: "识别超时，请稍后重试",
  });
}

/** 完整识别流程：首次用 data URL；失败则自动重试 1 次，切换图片形式 + 强化提示词。 */
async function recognize(
  key: string,
  imageBase64: string,
  mimeType: string,
): Promise<RecognizedTimetable> {
  const asDataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;
  // 首次：data URL 形式
  try {
    return buildData(await visionChat(key, asDataUrl, PROMPT_CORE));
  } catch (e) {
    // 若首次是密钥/限流等确定性问题，没必要退到第二种图片形式再试
    if (e instanceof LlmError && (e.status === 401 || e.status === 429)) {
      throw e;
    }
    // 重试：改用裸 base64，并在提示词末尾追加强调（同时覆盖 image 形式与 JSON 风格两类失败）
    return buildData(
      await visionChat(key, imageBase64, PROMPT_CORE + "\n\n" + PROMPT_REINFORCE),
    );
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
  const limited = checkRateLimit(req, "recognize", 10, "识别");
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

    // 列数必须在 6..7：图里有时间列 / 周六日拆开等导致列数异常时，
    // 显式失败而不是把第 8 列静默压到周日。
    if (!Number.isFinite(data.colCount) || (data.colCount !== 6 && data.colCount !== 7)) {
      const detail = Number.isFinite(data.colCount)
        ? `识别到 ${data.colCount} 列`
        : "未能识别列数";
      return Response.json(
        {
          ok: false,
          error: `课表列数识别异常（${detail}），请换一张更清晰的截图或改用手动录入`,
        },
        { status: 422 },
      );
    }

    // 绝不再静默清零：一门课都没识别出来时，明确返回失败，而不是让前端看到空表格。
    if (data.courses.length === 0) {
      return Response.json(
        {
          ok: false,
          error: "未能从图片中识别出任何课程，请换一张更清晰的截图，或改用手动录入",
        },
        { status: 422 },
      );
    }

    return Response.json({
      ok: true,
      data,
      model: MODEL,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError("识别失败，请稍后重试");
    // 出口统一脱敏：任何返回给浏览器的错误文本都不允许出现密钥原文
    return Response.json(
      { ok: false, error: desensitize(err.message, key) },
      { status: err.status },
    );
  }
}