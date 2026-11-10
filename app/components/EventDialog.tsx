"use client";

import { useMemo, useState } from "react";
import type { ScheduleEvent } from "@/lib/types";
import { minutesToLabel } from "@/lib/time";

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => i * 30);

const KIND_OPTIONS: { value: ScheduleEvent["kind"]; label: string }[] = [
  { value: "course", label: "课程" },
  { value: "task", label: "任务" },
  { value: "event", label: "事件" },
];

const REMIND_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "不提醒" },
  { value: 5, label: "提前 5 分钟" },
  { value: 10, label: "提前 10 分钟" },
  { value: 15, label: "提前 15 分钟" },
  { value: 30, label: "提前 30 分钟" },
];

const fieldLabel = "mb-1 block text-sm font-medium text-slate-700";
const inputCls =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-slate-800 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary";

type EventDialogProps = {
  mode: "new" | "edit";
  initial: ScheduleEvent;
  existing: ScheduleEvent[];
  onSave: (ev: ScheduleEvent) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
};

export default function EventDialog({
  mode,
  initial,
  existing,
  onSave,
  onDelete,
  onClose,
}: EventDialogProps) {
  const [title, setTitle] = useState(initial.title);
  const [startMin, setStartMin] = useState(initial.startMin);
  const [endMin, setEndMin] = useState(initial.endMin);
  const [kind, setKind] = useState<ScheduleEvent["kind"]>(initial.kind);
  const [location, setLocation] = useState(initial.location ?? "");
  const [remindBeforeMin, setRemindBeforeMin] = useState(
    initial.remindBeforeMin ?? 0,
  );
  const [titleError, setTitleError] = useState("");
  const [timeError, setTimeError] = useState("");

  // 重叠检测：同一天、时间段相交（排除自身）。
  const overlap = useMemo(() => {
    if (endMin <= startMin) return null;
    return (
      existing.find(
        (e) =>
          e.date === initial.date &&
          e.id !== initial.id &&
          e.startMin < endMin &&
          startMin < e.endMin,
      ) ?? null
    );
  }, [existing, initial.date, initial.id, startMin, endMin]);

  const handleSave = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("请输入标题");
      setTimeError("");
      return;
    }
    if (endMin <= startMin) {
      setTitleError("");
      setTimeError("结束时间必须晚于开始时间");
      return;
    }
    setTitleError("");
    setTimeError("");
    onSave({
      id: initial.id,
      title: trimmed,
      date: initial.date,
      startMin,
      endMin,
      kind,
      location: location.trim() || undefined,
      remindBeforeMin: remindBeforeMin > 0 ? remindBeforeMin : undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-line bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-slate-800">
            {mode === "new" ? "新建事件" : "编辑事件"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className={fieldLabel}>标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputCls}
              placeholder="例如：高等数学"
            />
            {titleError && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {titleError}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>开始时间</label>
              <select
                value={startMin}
                onChange={(e) => setStartMin(Number(e.target.value))}
                className={inputCls}
              >
                {TIME_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {minutesToLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={fieldLabel}>结束时间</label>
              <select
                value={endMin}
                onChange={(e) => setEndMin(Number(e.target.value))}
                className={inputCls}
              >
                {TIME_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {minutesToLabel(m)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {timeError && (
            <p className="text-xs text-red-600" role="alert">
              {timeError}
            </p>
          )}

          <div>
            <label className={fieldLabel}>类型</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ScheduleEvent["kind"])}
              className={inputCls}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={fieldLabel}>地点（可选）</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className={inputCls}
              placeholder="选填"
            />
          </div>

          <div>
            <label className={fieldLabel}>提前提醒</label>
            <select
              value={remindBeforeMin}
              onChange={(e) => setRemindBeforeMin(Number(e.target.value))}
              className={inputCls}
            >
              {REMIND_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {overlap && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
              与「{overlap.title}」时间重叠
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={() => onDelete(initial.id)}
                className="h-9 cursor-pointer rounded-md px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
              >
                删除
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 cursor-pointer rounded-md border border-line bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
