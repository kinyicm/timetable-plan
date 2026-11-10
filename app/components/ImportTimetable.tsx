"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ScheduleEvent } from "@/lib/types";
import { addDays, dateKey } from "@/lib/time";
import { slotToRange } from "@/lib/periods";
import { compressImage } from "@/lib/image";

type ReviewCourse = {
  name: string;
  day: number;
  startSlot: number;
  endSlot: number;
  location: string;
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
    }[];
    droppedCount: number;
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

const cellInput =
  "w-full rounded-md border border-line bg-white px-2 py-1 text-sm text-slate-800 outline-none transition-colors focus:border-primary";

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampSlot(n: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > 12) return 12;
  return v;
}

type ImportTimetableProps = {
  weekStart: Date;
  onImport: (events: ScheduleEvent[]) => void;
};

export default function ImportTimetable({ weekStart, onImport }: ImportTimetableProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<
    "idle" | "compressing" | "recognizing" | "review" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [rows, setRows] = useState<ReviewCourse[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);

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
        })),
      );
      setDroppedCount(json.data.droppedCount ?? 0);
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

  const handleConfirm = () => {
    const events: ScheduleEvent[] = rows
      .filter((r) => r.name.trim())
      .map((r): ScheduleEvent => {
        const startSlot = clampSlot(r.startSlot);
        const endSlot = Math.max(startSlot, clampSlot(r.endSlot));
        const start = slotToRange(startSlot);
        const end = slotToRange(endSlot);
        return {
          id: genId(),
          title: r.name.trim(),
          date: dateKey(addDays(weekStart, r.day - 1)),
          startMin: start.startMin,
          endMin: end.endMin,
          kind: "course",
          location: r.location.trim() || undefined,
          unverified: true,
        };
      });
    onImport(events);
    setStatus("idle");
    setRows([]);
    setDroppedCount(0);
  };

  const close = () => {
    setStatus("idle");
    setRows([]);
    setDroppedCount(0);
    setErrorMessage("");
  };

  return (
    <>
      <button
        type="button"
        onClick={openPicker}
        className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-line bg-white px-3 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
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
                    {droppedCount > 0 && (
                      <p className="mt-1 text-xs text-amber-600">
                        有 {droppedCount} 条未识别的条目已忽略
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
                    <div className="max-h-[50vh] overflow-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="text-left text-xs text-slate-500">
                            <th className="px-2 py-2 font-medium">课程名</th>
                            <th className="px-2 py-2 font-medium">星期</th>
                            <th className="px-2 py-2 font-medium">起始节</th>
                            <th className="px-2 py-2 font-medium">结束节</th>
                            <th className="px-2 py-2 font-medium">地点</th>
                            <th className="px-2 py-2 font-medium" />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i} className="border-t border-line">
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
                              <td className="px-2 py-2">
                                <input
                                  value={r.location}
                                  onChange={(e) => updateRow(i, { location: e.target.value })}
                                  className={cellInput}
                                />
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

                    {droppedCount > 0 && (
                      <p className="mt-3 text-xs text-amber-600">
                        有 {droppedCount} 条未识别的条目已忽略
                      </p>
                    )}

                    <div className="mt-4 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={close}
                        className="h-9 cursor-pointer rounded-md border border-line bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirm}
                        className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                      >
                        确认导入 {rows.length} 门课
                      </button>
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
