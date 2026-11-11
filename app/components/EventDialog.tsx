"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScheduleEvent } from "@/lib/types";
import TimeWheel from "./TimeWheel";

const DAY_END_MIN = 23 * 60 + 55; // 23:55

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

const DURATION_OPTIONS: { label: string; min: number }[] = [
  { label: "30 分", min: 30 },
  { label: "1 小时", min: 60 },
  { label: "1.5 小时", min: 90 },
  { label: "2 小时", min: 120 },
  { label: "3 小时", min: 180 },
];

const fieldLabel = "mb-1 block text-xs text-slate-500";
const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

function formatDurationTotal(min: number): string {
  if (min <= 0) return "共 0 分钟";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `共 ${m} 分钟`;
  if (m === 0) return `共 ${h} 小时`;
  return `共 ${h} 小时 ${m} 分`;
}

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

  // 弹窗打开时锁定 body 滚动，关闭/Esc 时恢复；Esc 关闭。
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

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
    if (endMin > DAY_END_MIN) {
      setTitleError("");
      setTimeError("结束时间不能晚于 23:55");
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
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">
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

          <div>
            <label className={fieldLabel}>开始时间</label>
            <TimeWheel
              value={startMin}
              onChange={(m) => {
                const s = Math.max(0, Math.min(m, DAY_END_MIN - 15));
                setStartMin(s);
                if (endMin <= s) setEndMin(Math.min(s + 15, DAY_END_MIN));
              }}
              maxAllowed={DAY_END_MIN - 15}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DURATION_OPTIONS.map((d) => {
                const active = endMin - startMin === d.min;
                return (
                  <button
                    key={d.min}
                    type="button"
                    onClick={() => setEndMin(Math.min(startMin + d.min, DAY_END_MIN))}
                    className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      active
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className={fieldLabel}>结束时间</label>
            <TimeWheel
              value={endMin}
              onChange={(m) => {
                if (m <= startMin) {
                  setStartMin(Math.max(0, m - 15));
                  setEndMin(m);
                } else {
                  setEndMin(Math.min(m, DAY_END_MIN));
                }
              }}
              minAllowed={startMin + 15}
              maxAllowed={DAY_END_MIN}
              validateInput={(m) =>
                m <= startMin ? "结束时间必须晚于开始时间" : null
              }
            />
            <p className="mt-1 text-xs text-slate-500">
              {formatDurationTotal(endMin - startMin)}
            </p>
          </div>

          {overlap && (
            <p className="text-xs text-red-600">与「{overlap.title}」时间重叠</p>
          )}
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
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={() => onDelete(initial.id)}
                className="cursor-pointer rounded-lg border border-red-200 px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
              >
                删除
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="cursor-pointer rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
