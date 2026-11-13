/**
 * 公共限流层：滑动窗口计数，次数作为参数由各接口传入。
 * 桶按「接口作用域 + IP」隔离，保证各接口额度互不串扰（plan 10/min、recognize 10/min、
 * goal 5/min、advise 5/min）。
 */

/** 限流窗口（毫秒）。 */
const RATE_WINDOW_MS = 60_000;

/** 桶表：key = `${scope}\u0000${ip}`，value 为该来源在窗口内的请求时间戳。 */
const rateBuckets = new Map<string, number[]>();

/** 是否本地开发（本地不限流，方便调试）。 */
const IS_DEV =
  process.env.NODE_ENV !== "production" || process.env.DISABLE_RATE_LIMIT === "1";

/**
 * 兼容 IPv6 简写（::1）与 IPv4。
 * 优先取 x-real-ip，其次取 XFF 的最后一段（离服务器最近的一跳），
 * 都取不到时退化为 "unknown"（所有未知来源共享一个桶，宁可误伤不可放开）。
 */
export function getClientIp(req: Request): string {
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
export function checkRateLimit(
  req: Request,
  scope: string,
  max: number,
  label: string,
): string | null {
  if (IS_DEV) return null;
  const ip = getClientIp(req);
  const now = Date.now();
  const key = `${scope}\u0000${ip}`;
  const bucket = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= max) {
    rateBuckets.set(key, bucket);
    return `${label}过于频繁（每分钟最多 ${max} 次），请稍后再试`;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return null;
}
