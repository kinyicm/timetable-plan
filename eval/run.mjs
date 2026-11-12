#!/usr/bin/env node
/**
 * eval/run.mjs —— 调用 /api/recognize 抓取一次真实识别结果并落盘
 *
 * 为什么要把「抓取」和「比对」分开：
 *   识别结果依赖模型，每次调用都可能不同。把响应原样存下来之后，
 *   比对脚本就能在离线、可重复的条件下跑，调提示词时也能对比前后两版。
 *
 * 用法：
 *   node eval/run.mjs <图片路径> [用例名]
 *   node eval/run.mjs "C:\...\课表.jpg" baseline
 *
 * 前置：本地服务已在 http://localhost:3000 运行（npm run dev 或 npm start）
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 允许通过环境变量覆盖服务地址与超时 */
const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 180_000);

/** 根据扩展名推断 MIME，缺省按 jpeg（手机照片与截图最常见） */
function mimeOf(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function main() {
  const [imagePath, caseName] = process.argv.slice(2);
  if (!imagePath) {
    console.error("用法: node eval/run.mjs <图片路径> [用例名]");
    process.exit(1);
  }

  const name = caseName || basename(imagePath).replace(/\.[^.]+$/, "");
  const buf = await readFile(imagePath);
  const imageBase64 = buf.toString("base64");
  console.error(`[run] 图片 ${basename(imagePath)}  ${(buf.length / 1024).toFixed(1)} KB  → ${BASE}`);

  const t0 = Date.now();
  const resp = await fetch(`${BASE}/api/recognize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64, mimeType: mimeOf(imagePath) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const elapsedMs = Date.now() - t0;

  const body = await resp.json().catch(async () => ({ ok: false, error: await resp.text() }));
  const record = {
    case: name,
    image: basename(imagePath),
    httpStatus: resp.status,
    elapsedMs,
    capturedAt: new Date().toISOString(),
    baseUrl: BASE,
    response: body,
  };

  const casesDir = join(HERE, "cases");
  await mkdir(casesDir, { recursive: true });
  const outPath = join(casesDir, `${name}.json`);
  await writeFile(outPath, JSON.stringify(record, null, 2) + "\n", "utf8");

  if (!body.ok) {
    console.error(`[run] 失败 HTTP ${resp.status}: ${body.error ?? "(无错误信息)"}`);
    process.exit(2);
  }
  console.error(
    `[run] 成功  ${elapsedMs} ms  courses=${(body.data?.courses ?? []).length}  ` +
      `periods=${(body.data?.periods ?? []).length}  → ${outPath}`,
  );
}

main().catch((e) => {
  console.error("[run] 异常:", e?.message ?? e);
  process.exit(3);
});
