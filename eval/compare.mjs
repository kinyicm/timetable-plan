#!/usr/bin/env node
/**
 * eval/compare.mjs —— 把一次识别结果与标准答案比成可引用的指标
 *
 * 指标定义（写在文档里也是这一套，避免口径漂移）：
 *   1. 课程名匹配    ：去括号序号与空白后，按「完全相等或互相包含」匹配；据此算
 *                      命中数、漏报数（真值有、结果没有）、多报数（结果有、真值没有）
 *   2. 星期准确率    ：在命中课程里，day 与真值相同的占比
 *   3. 节次跨度准确率：在命中课程里，startSlot 与 endSlot 同时相同的占比
 *   4. 时间误差      ：用结果自带 periods（缺失则回退真值 periods）把课换成分钟，
 *                      与真值 expectedEvents 比，取 |startMin 差| 与 |endMin 差| 的平均
 *
 * 为什么不用「整体准确率」一个数：星期、节次、时间三类错误互相独立，
 * 混成一个数会让「星期对但节次错」与「全错」看起来一样。
 *
 * 用法：
 *   node eval/compare.mjs                       # 默认比 eval/cases 下最新的用例
 *   node eval/compare.mjs eval/cases/xxx.json   # 指定用例
 *   node eval/compare.mjs --all                 # 比 cases 下全部用例
 */

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GT_PATH = join(HERE, "timetable-groundtruth.json");
const CASES_DIR = join(HERE, "cases");
const RESULTS_DIR = join(HERE, "results");

/** 把任意名字规整到可比较的形式：去括号、括号内序号、空白 */
function normName(s) {
  return String(s ?? "")
    .replace(/[（(][一二三四五六七八九十\d]+[)）]/g, "")
    .replace(/[（()）\s·・.、，,]/g, "")
    .trim();
}

/** "08:30" -> 510 */
function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 结果里可能用 periods 或直接给 startMin；统一换算成分钟对 */
function slotsToRange(slots, periods) {
  const map = new Map();
  for (const p of periods ?? []) {
    const s = toMin(p?.start);
    const e = toMin(p?.end);
    if (s != null && e != null) map.set(Number(p.slot), [s, e]);
  }
  const startSlot = Number(slots?.startSlot);
  const endSlot = Number(slots?.endSlot);
  const a = map.get(startSlot);
  const b = map.get(endSlot);
  if (!a || !b) return null;
  return [a[0], b[1]];
}

function pct(x, y) {
  if (!y) return "0/0";
  return `${x}/${y}（${((x / y) * 100).toFixed(0)}%）`;
}

/**
 * 核心比对。返回结构化指标，供打印与落盘共用。
 */
function compare(gt, data) {
  const courses = Array.isArray(data?.courses) ? data.courses : [];
  const gtCourses = gt.courses;

  // 结果 periods 优先（能反映「识别到的作息」），缺失则用真值
  const periods = (data?.periods ?? []).filter((p) => toMin(p?.start) != null);
  const usedPeriodsFrom = periods.length >= 3 ? "识别结果" : "标准答案";
  const periodsForCalc = usedPeriodsFrom === "识别结果" ? periods : gt.periods;

  const gtByName = new Map();
  for (const c of gtCourses) gtByName.set(normName(c.name), c);

  const matched = [];
  const extra = [];
  const usedGt = new Set();

  for (const c of courses) {
    const n = normName(c.name);
    let g = gtByName.get(n);
    if (!g) {
      for (const [k, v] of gtByName) {
        if (k && n && (k.includes(n) || n.includes(k))) {
          g = v;
          break;
        }
      }
    }
    if (!g) {
      extra.push(c);
      continue;
    }
    matched.push({ got: c, want: g });
    usedGt.add(normName(g.name));
  }

  const missing = gtCourses.filter((c) => !usedGt.has(normName(c.name)));

  let dayOk = 0;
  let slotOk = 0;
  let locOk = 0;
  const timeErrors = [];
  const rows = [];

  for (const { got, want } of matched) {
    const dOk = Number(got.day) === Number(want.day);
    const sOk =
      Number(got.startSlot) === Number(want.startSlot) &&
      Number(got.endSlot) === Number(want.endSlot);
    const gLoc = normName(want.location);
    const gotLoc = normName(got.location);
    const lOk = gLoc ? gotLoc === gLoc : gotLoc === "" || gotLoc.includes("未标注");
    if (dOk) dayOk++;
    if (sOk) slotOk++;
    if (lOk) locOk++;

    const range = slotsToRange(got, periodsForCalc);
    const exp = (gt.expectedEvents ?? []).find((e) => normName(e.name) === normName(want.name));
    if (range && exp) {
      timeErrors.push(Math.abs(range[0] - exp.startMin), Math.abs(range[1] - exp.endMin));
    }

    rows.push({
      name: want.name,
      day: { got: got.day, want: want.day, ok: dOk },
      slots: { got: `${got.startSlot}-${got.endSlot}`, want: `${want.startSlot}-${want.endSlot}`, ok: sOk },
      location: { got: got.location ?? "", want: want.location ?? "", ok: lOk },
      time: range ? { got: range, want: [exp?.startMin, exp?.endMin] } : null,
    });
  }

  const avgTimeError = timeErrors.length
    ? Math.round((timeErrors.reduce((a, b) => a + b, 0) / timeErrors.length) * 10) / 10
    : null;

  return {
    total: gtCourses.length,
    returned: courses.length,
    matched: matched.length,
    dayAccuracy: dayOk,
    slotAccuracy: slotOk,
    locationAccuracy: locOk,
    missing: missing.map((c) => c.name),
    extra: extra.map((c) => `${c.name}(day=${c.day} ${c.startSlot}-${c.endSlot})`),
    avgTimeErrorMinutes: avgTimeError,
    periodsFrom: usedPeriodsFrom,
    rows,
  };
}

function printReport(label, m) {
  const line = "─".repeat(64);
  console.log(line);
  console.log(`用例 ${label}`);
  console.log(line);
  console.log(`  返回课程            ${m.returned} 门   （标准答案 ${m.total} 门）`);
  console.log(`  课程名匹配          ${pct(m.matched, m.total)}`);
  console.log(`  星期准确率          ${pct(m.dayAccuracy, m.matched)}`);
  console.log(`  节次跨度准确率      ${pct(m.slotAccuracy, m.matched)}`);
  console.log(`  地点准确率          ${pct(m.locationAccuracy, m.matched)}`);
  console.log(
    `  平均时间误差        ${m.avgTimeErrorMinutes == null ? "—" : m.avgTimeErrorMinutes + " 分钟"}   （作息取自${m.periodsFrom}）`,
  );
  if (m.missing.length) console.log(`  漏报                ${m.missing.join("、")}`);
  if (m.extra.length) console.log(`  多报                ${m.extra.join("、")}`);
  console.log("");
  console.log("  逐门明细：");
  for (const r of m.rows) {
    const flag = r.day.ok && r.slots.ok ? "✓" : "✗";
    const d = r.day.ok ? "" : ` ✗周(得${r.day.got}/应${r.day.want})`;
    const s = r.slots.ok ? "" : ` ✗节(得${r.slots.got}/应${r.slots.want})`;
    const l = r.location.ok ? "" : ` ✗地(得${r.location.got || "空"})`;
    console.log(`    ${flag} ${r.name.padEnd(14, " ")} ${d}${s}${l}`);
  }
  console.log("");
}

async function loadCase(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  if (raw?.response) return { name: raw.case ?? basename(path, ".json"), data: raw.response.data, meta: raw };
  // 兼容直接存 data 的文件
  return { name: basename(path, ".json"), data: raw, meta: null };
}

async function main() {
  const gt = JSON.parse(await readFile(GT_PATH, "utf8"));
  const args = process.argv.slice(2);

  let files = [];
  if (args.includes("--all")) {
    const names = (await readdir(CASES_DIR).catch(() => [])).filter((n) => n.endsWith(".json"));
    files = names.map((n) => join(CASES_DIR, n));
  } else if (args[0]) {
    files = [args[0]];
  } else {
    // 默认取最近修改的一个用例
    const names = (await readdir(CASES_DIR).catch(() => [])).filter((n) => n.endsWith(".json"));
    if (!names.length) {
      console.error("[compare] eval/cases 下没有用例。先跑：node eval/run.mjs <图片路径>");
      process.exit(2);
    }
    const withTime = await Promise.all(
      names.map(async (n) => ({ n, mtime: (await stat(join(CASES_DIR, n))).mtimeMs })),
    );
    withTime.sort((a, b) => b.mtime - a.mtime);
    files = [join(CASES_DIR, withTime[0].n)];
  }

  const all = [];
  for (const f of files) {
    const { name, data } = await loadCase(f);
    const m = compare(gt, data);
    printReport(name, m);
    all.push({ case: name, metrics: m });
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const out = {
    generatedAt: new Date().toISOString(),
    groundTruth: "eval/timetable-groundtruth.json",
    results: all,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `compare-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`指标已写入 ${outPath}`);
}

main().catch((e) => {
  console.error("[compare] 异常:", e?.message ?? e);
  process.exit(3);
});
