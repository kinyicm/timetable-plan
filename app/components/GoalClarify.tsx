"use client";

import { useState } from "react";

type GoalClarifyProps = {
  text: string;
  /** 截止日期默认值（YYYY-MM-DD）。 */
  defaultDeadline: string;
  onAdvise: (hoursPerWeek: number, deadline: string) => void;
  onAddEvent: () => void;
  onClose: () => void;
};

export default function GoalClarify({
  text,
  defaultDeadline,
  onAdvise,
  onAddEvent,
  onClose,
}: GoalClarifyProps) {
  const [hours, setHours] = useState(10);
  const [deadline, setDeadline] = useState(defaultDeadline);

  const clampedHours = Math.min(40, Math.max(1, Math.round(Number(hours) || 10)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold leading-snug text-slate-900">
            想达成这个目标：{text}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">每周可投入（小时/周）</span>
            <input
              type="number"
              min={1}
              max={40}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">截止日期</span>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAdvise(clampedHours, deadline)}
            className="inline-flex flex-1 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            让 AI 给方案
          </button>
          <button
            type="button"
            onClick={onAddEvent}
            className="inline-flex flex-1 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50"
          >
            只加一条事件
          </button>
        </div>

        <p className="mt-3 text-right text-[11px] text-slate-400">
          AI 会先把你的课表空档算清楚，再给 2-3 个方案
        </p>
      </div>
    </div>
  );
}
