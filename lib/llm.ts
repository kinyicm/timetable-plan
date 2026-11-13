/**
 * 公共 LLM 调用层：把智谱 OpenAI 兼容接口的调用、错误映射、JSON 容错解析与
 * 密钥脱敏抽到一处，供 plan / recognize / goal / advise 四个接口复用。
 * 各接口只需传入自己的模型名、超时、服务名与超时文案，行为与拆分前保持一致。
 */

/** 智谱 OpenAI 兼容 `chat/completions` 接口。 */
const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

export type LlmMessage =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatOnceConfig {
  key: string;
  model: string;
  /** 消息内容：纯文本任务传字符串，视觉任务传 LlmMessage[]。 */
  content: string | LlmMessage[];
  timeoutMs: number;
  /** 服务名，用于「无法连接X服务」「X服务返回错误」文案。 */
  service: string;
  /** 超时错误文案（各接口不同）。 */
  timeoutMessage: string;
  /** 超时错误 HTTP 状态码，默认 500。 */
  timeoutStatus?: number;
}

/** LLM 调用错误：带 HTTP 状态码，便于外层区分 401/429/超时等。 */
export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** 把可能出现在错误文本里的密钥替换成 ***，避免上游报错把密钥透回浏览器。 */
export function desensitize(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("***");
}

/** 从模型回复里截取第一个 "{" 到最后一个 "}" 之间的内容再 parse。 */
export function parseLoose(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new LlmError("JSON 解析失败：模型未返回可用的 JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/** 单次调用智谱接口并返回解析后的 JSON（不做重试）。 */
export async function chatOnce(config: ChatOnceConfig): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: config.content }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new LlmError(config.timeoutMessage, config.timeoutStatus ?? 500);
    }
    throw new LlmError(`无法连接${config.service}服务，请检查网络`);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (resp.status === 401) {
      throw new LlmError("密钥无效（401）：服务端 ZHIPU_API_KEY 配置不正确", 401);
    }
    if (resp.status === 429) {
      throw new LlmError("请求过于频繁，模型限流（429），请稍后再试", 429);
    }
    throw new LlmError(
      `${config.service}服务返回错误（${resp.status}）：${desensitize(detail, config.key).slice(0, 200)}`,
    );
  }

  const json = await resp.json().catch(() => {
    throw new LlmError("模型接口响应不是合法 JSON");
  });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new LlmError("模型未返回内容");
  }
  return parseLoose(text);
}
