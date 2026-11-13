"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ScheduleEvent } from "@/lib/types";
import { addDays, dateKey } from "@/lib/time";
import { DEFAULT_PERIODS, slotToRange, type Period } from "@/lib/periods";
import { compressImage } from "@/lib/image";

type ReviewCourse = {
  name: string;
  day: number;
  startSlot: number;
  endSlot: number;
  location: string;
  remindBeforeMin: number;
  suspect?: boolean;
};

type RecognizeResponse = {
  ok: boolean;
  error?: string;
  data?: {
    courses: {
      name: string;
      day: number;
      startSlot: number;
      endSlot: number;
      location: string;
      suspect?: boolean;
    }[];
    invalidCount: number;
    spanSuspect?: boolean;
    suspectCount?: number;
    slotsPerDay?: number;
    periods?: { slot: number; start: string; end: string }[];
  };
};

const DAY_OPTIONS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
];

const REMIND_OPTIONS = [
  { value: 0, label: "不提醒" },
  { value: 5, label: "提前 5 分钟" },
  { value: 10, label: "提前 10 分钟" },
  { value: 15, label: "提前 15 分钟" },
];

const WEEKS_OPTIONS = [
  { value: 1, label: "1 周" },
  { value: 4, label: "4 周" },
  { value: 8, label: "8 周" },
  { value: 16, label: "16 周" },
];

const cellInput =
  "w-full rounded-md border border-line bg-white px-2 py-1 text-sm text-slate-800 outline-none transition-colors focus:border-primary";

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 生成导入批次时间戳，作为 groupId 前缀，便于整批删除。 */
function genImportStamp(): string {
  return Date.now().toString(36);
}

function clampSlot(n: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > 12) return 12;
  return v;
}

/**
 * 把识别返回的 periods（{ slot, start, end }[]）合并进默认作息，
 * 得到按「节次 - 1」索引的 Period[]。识别值只覆盖给出了的节次，其余保持默认。
 */
function mergePeriods(
  recognized: { slot: number; start: string; end: string }[],
  slotsPerDay: number,
): Period[] {
  const count = Math.max(1, Math.round(slotsPerDay) || DEFAULT_PERIODS.length);
  const arr: Period[] = Array.from({ length: count }, (_, i) => {
    const d = DEFAULT_PERIODS[i];
    return d ? { start: d.start, end: d.end } : { start: "", end: "" };
  });
  for (const p of recognized) {
    const idx = Math.round(p.slot) - 1;
    if (idx >= 0 && idx < arr.length && p.start && p.end) {
      arr[idx] = { start: p.start, end: p.end };
    }
  }
  return arr;
}

/** 返回第 slot 节的「开始-结束」展示文本；无时间时返回 "—"。 */
function periodLabel(slot: number, periods: Period[]): string {
  const p = periods[Math.min(Math.max(Math.round(slot) - 1, 0), periods.length - 1)];
  if (!p || !p.start || !p.end) return "—";
  return `${p.start}-${p.end}`;
}

type ImportTimetableProps = {
  weekStart: Date;
  /** 当前课表中 kind === "course" 的事件数，覆盖导入确认时用于提示将删除几门旧课程。 */
  courseCount: number;
  onImport: (events: ScheduleEvent[], mode: "append" | "replace") => void;
};

export default function ImportTimetable({
  weekStart,
  courseCount,
  onImport,
}: ImportTimetableProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<
    "idle" | "compressing" | "recognizing" | "review" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [rows, setRows] = useState<ReviewCourse[]>([]);
  const [invalidCount, setInvalidCount] = useState(0);
  const [spanSuspect, setSpanSuspect] = useState(false);
  const [weeks, setWeeks] = useState(4);
  const [periods, setPeriods] = useState<Period[]>(() => DEFAULT_PERIODS.map((p) => ({ ...p })));

  const openPicker = () => fileRef.current?.click();

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void handleFile(file);
  };

  const handleFile = async (file: File) => {
    setStatus("compressing");
    setErrorMessage("");
    try {
      const { base64, mimeType } = await compressImage(file);
      // 压缩后仍超 7 MB（base64）则不发请求，避免服务端 413
      if (base64.length > 7 * 1024 * 1024) {
        setErrorMessage("图片太大，请重新拍摄或裁剪");
        setStatus("error");
        return;
      }
      setStatus("recognizing");
      const resp = await fetch("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType }),
      });
      const json = (await resp.json()) as RecognizeResponse;
      if (!json.ok || !json.data) {
        setErrorMessage(json.error ?? "识别失败，请稍后重试");
        setStatus("error");
        return;
      }
      setRows(
        json.data.courses.map((c) => ({
          name: c.name,
          day: c.day,
          startSlot: c.startSlot,
          endSlot: c.endSlot,
          location: c.location ?? "",
          remindBeforeMin: 10,
          suspect: c.suspect === true,
        })),
      );
      setInvalidCount(json.data.invalidCount ?? 0);
      setSpanSuspect(json.data.spanSuspect === true);
      setPeriods(mergePeriods(json.data.periods ?? [], json.data.slotsPerDay ?? 0));
      setStatus("review");
    } catch {
      setErrorMessage("识别失败，请检查网络后重试");
      setStatus("error");
    }
  };

  const updateRow = (index: number, patch: Partial<ReviewCourse>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const updatePeriod = (index: number, field: "start" | "end", value: string) => {
    setPeriods((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  };

  const handleConfirm = (mode: "append" | "replace") => {
    const validRows = rows.filter((r) => r.name.trim());
    if (validRows.length === 0) {
      close();
      return;
    }

    // 同一批导入共享一个时间戳，groupId 便于以后整批删除。
    const stamp = genImportStamp();
    const events: ScheduleEvent[] = [];
    validRows.forEach((r, idx) => {
      const groupId = `import-${stamp}-${idx}`;
      const startSlot = clampSlot(r.startSlot);
      const endSlot = Math.max(startSlot, clampSlot(r.endSlot));
      const start = slotToRange(startSlot, periods);
      const end = slotToRange(endSlot, periods);
      // 从当前周起，为每一周各生成一条实例：日期 = weekStart + (day-1) + 7*w。
      for (let w = 0; w < weeks; w++) {
        events.push({
          id: genId(),
          title: r.name.trim(),
          date: dateKey(addDays(weekStart, r.day - 1 + 7 * w)),
          startMin: start.startMin,
          endMin: end.endMin,
          kind: "course",
          location: r.location.trim() || undefined,
          remindBeforeMin: r.remindBeforeMin > 0 ? r.remindBeforeMin : undefined,
          groupId,
          unverified: true,
        });
      }
    });

    // 覆盖导入前先确认一次，避免误删既有课程。
    if (mode === "replace") {
      const ok = window.confirm(
        `将删除当前课表中的 ${courseCount} 门课程（不影响你自己添加的任务与计划），并导入新的 ${validRows.length} 门课。确定吗？`,
      );
      if (!ok) return;
    }

    onImport(events, mode);
    setStatus("idle");
    setRows([]);
    setInvalidCount(0);
    setSpanSuspect(false);
  };

  const close = () => {
    setStatus("idle");
    setRows([]);
    setInvalidCount(0);
    setSpanSuspect(false);
    setErrorMessage("");
  };

  const hasSuspect = rows.some((r) => r.suspect === true);

  return (
    <>
      <button
        type="button"
        onClick={openPicker}
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        📷 拍照上传课表
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />

      {status !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-xl border border-line bg-white shadow-xl">
            <header className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold text-slate-800">
                {status === "compressing" || status === "recognizing"
                  ? "识别课表"
                  : status === "review"
                    ? "校对课表"
                    : "识别失败"}
              </h2>
              {status !== "compressing" && status !== "recognizing" && (
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭"
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                >
                  ×
                </button>
              )}
            </header>

            <div className="px-5 py-4">
              {status === "compressing" && (
                <div className="flex flex-col items-center gap-3 py-10">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-primary" />
                  <p className="text-sm text-slate-600">正在压缩…</p>
                </div>
              )}

              {status === "recognizing" && (
                <div className="flex flex-col items-center gap-3 py-10">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-primary" />
                  <p className="text-sm text-slate-600">正在识别…</p>
                </div>
              )}

              {status === "error" && (
                <div className="py-8 text-center">
                  <p className="text-sm text-red-600">{errorMessage}</p>
                  <button
                    type="button"
                    onClick={close}
                    className="mt-4 inline-flex h-9 cursor-pointer items-center rounded-md border border-line bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    关闭
                  </button>
                </div>
              )}

              {status === "review" &&
                (rows.length === 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-sm text-slate-600">未识别到课程</p>
                    {invalidCount > 0 && (
                      <p className="mt-1 text-xs text-amber-600">
                        有 {invalidCount} 条识别结果已自动修正
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={close}
                      className="mt-4 inline-flex h-9 cursor-pointer items-center rounded-md border border-line bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      关闭
                    </button>
                  </div>
                ) : (
                  <>
                    {spanSuspect && (
                      <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        未能识别课程跨越的节数，所有课程都按 1 节导入，请逐行核对「结束节」
                      </p>
                    )}
                    {invalidCount > 0 && (
                      <p className="mb-2 text-xs text-amber-600">
                        有 {invalidCount} 条识别结果已自动修正
                      </p>
                    )}
                    <div className="mb-2 rounded-md border border-line bg-slate-50 p-3">
                      <div className="mb-2 text-xs font-medium text-slate-600">
                        节次时间（可修改）
                      </div>
                      <div className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-4">
                        {periods.map((p, i) => (
                          <div key={i} className="flex items-center gap-1">
                            <span className="w-10 shrink-0 text-[11px] text-slate-500">
                              第{i + 1}节
                            </span>
                            <input
                              value={p.start}
                              onChange={(e) => updatePeriod(i, "start", e.target.value)}
                              placeholder="08:00"
                              className="w-14 rounded-md border border-line bg-white px-1 py-0.5 text-xs text-slate-700 outline-none focus:border-primary"
                            />
                            <span className="text-slate-400">-</span>
                            <input
                              value={p.end}
                              onChange={(e) => updatePeriod(i, "end", e.target.value)}
                              placeholder="08:40"
                              className="w-14 rounded-md border border-line bg-white px-1 py-0.5 text-xs text-slate-700 outline-none focus:border-primary"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="max-h-[50vh] overflow-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="text-left text-xs text-slate-500">
                            <th className="px-2 py-2 font-medium">课程名</th>
                            <th className="px-2 py-2 font-medium">
                              星期
                              {hasSuspect && (
                                <span className="ml-1 text-[10px] font-normal text-amber-600">
                                  黄色行请核对
                                </span>
                              )}
                            </th>
                            <th className="px-2 py-2 font-medium">起始节</th>
                            <th
                              className={`px-2 py-2 font-medium ${
                                spanSuspect ? "bg-amber-100 text-amber-700" : ""
                              }`}
                            >
                              结束节
                              {hasSuspect && (
                                <span className="ml-1 text-[10px] font-normal text-amber-600">
                                  黄色行请核对
                                </span>
                              )}
                            </th>
                            <th className="px-2 py-2 font-medium">节次时间</th>
                            <th className="px-2 py-2 font-medium">地点</th>
                            <th className="px-2 py-2 font-medium">提前提醒</th>
                            <th className="px-2 py-2 font-medium" />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr
                              key={i}
                              className={`border-t border-line ${r.suspect ? "bg-amber-50" : ""}`}
                            >
                              <td className="px-2 py-2">
                                <input
                                  value={r.name}
                                  onChange={(e) => updateRow(i, { name: e.target.value })}
                                  className={cellInput}
                                />
                              </td>
                              <td className="px-2 py-2">
                                <select
                                  value={r.day}
                                  onChange={(e) => updateRow(i, { day: Number(e.target.value) })}
                                  className={cellInput}
                                >
                                  {DAY_OPTIONS.map((d) => (
                                    <option key={d.value} value={d.value}>
                                      {d.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="w-20 px-2 py-2">
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={r.startSlot}
                                  onChange={(e) =>
                                    updateRow(i, { startSlot: Number(e.target.value) || 1 })
                                  }
                                  className={cellInput}
                                />
                              </td>
                              <td className="w-20 px-2 py-2">
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={r.endSlot}
                                  onChange={(e) =>
                                    updateRow(i, { endSlot: Number(e.target.value) || 1 })
                                  }
                                  className={cellInput}
                                />
                              </td>
                              <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-600">
                                {periodLabel(r.startSlot, periods)} - {periodLabel(r.endSlot, periods)}
                              </td>
                              <td className="px-2 py-2">
                                <input
                                  value={r.location}
                                  onChange={(e) => updateRow(i, { location: e.target.value })}
                                  className={cellInput}
                                />
                              </td>
                              <td className="w-32 px-2 py-2">
                                <select
                                  value={r.remindBeforeMin}
                                  onChange={(e) =>
                                    updateRow(i, { remindBeforeMin: Number(e.target.value) })
                                  }
                                  className={cellInput}
                                >
                                  {REMIND_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>
                                      {o.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-2 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => removeRow(i)}
                                  className="cursor-pointer whitespace-nowrap rounded-md px-2 py-1 text-sm text-red-600 transition-colors hover:bg-red-50"
                                >
                                  删除
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={close}
                          className="h-9 cursor-pointer rounded-md border border-line bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          取消
                        </button>
                        <label className="flex items-center gap-2 text-xs text-slate-500">
                          生成周数
                          <select
                            value={weeks}
                            onChange={(e) => setWeeks(Number(e.target.value))}
                            className="h-9 cursor-pointer rounded-md border border-line bg-white px-2 text-sm text-slate-700 outline-none transition-colors focus:border-primary"
                          >
                            {WEEKS_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleConfirm("append")}
                          className="h-9 cursor-pointer rounded-md border border-line bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          追加导入 {rows.length} 门课
                        </button>
                        <button
                          type="button"
                          onClick={() => handleConfirm("replace")}
                          className="h-9 cursor-pointer rounded-md bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700"
                        >
                          覆盖导入 {rows.length} 门课
                        </button>
                      </div>
                    </div>
                  </>
                ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
