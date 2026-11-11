"use client";

import { useState } from "react";
import { minutesToLabel } from "@/lib/time";

export type PlanAction = {
  date: string;
  startMin: number;
  endMin: number;
  title: string;
  detail: string;
};

type PlanPreviewProps = {
  goalTitle: string;
  feasible: boolean;
  advice: string;
  reason: string;
  movedCount: number;
  droppedCount: number;
  actions: PlanAction[];
  onReplan: () => void;
  onAccept: (actions: PlanAction[]) => void;
  onClose: () => void;
};

export default function PlanPreview({
  goalTitle,
  feasible,
  advice,
  reason,
  movedCount,
  droppedCount,
  actions,
  onReplan,
  onAccept,
  onClose,
}: PlanPreviewProps) {
  // 逐条剔除：记录被移除的原始下标。
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const remaining = actions.filter((_, i) => !removed.has(i));

  const toggleRemove = (i: number) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{goalTitle}</h2>
            <p className="mt-0.5 text-xs text-slate-500">AI 给出了 {remaining.length} 个安排</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {!feasible && advice && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {advice}
            </div>
          )}
          {reason && <p className="mb-3 text-sm text-slate-500">{reason}</p>}
          {movedCount > 0 && (
            <p className="mb-1 text-xs text-amber-600">
              其中 {movedCount} 条时间被自动调整到最近空档
            </p>
          )}
          {droppedCount > 0 && (
            <p className="mb-1 text-xs text-slate-400">{droppedCount} 条因放不下被忽略</p>
          )}

          {remaining.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">没有可接受的安排</p>
          ) : (
            <ul className="space-y-2">
              {actions.map((a, i) => {
                if (removed.has(i)) return null;
                return (
                  <li
                    key={i}
                    className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs text-slate-500">
                        {a.date} {minutesToLabel(a.startMin)}-{minutesToLabel(a.endMin)}
                      </div>
                      <div className="truncate text-sm font-medium text-slate-900">{a.title}</div>
                      {a.detail && <div className="truncate text-xs text-slate-400">{a.detail}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleRemove(i)}
                      className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
                    >
                      删除
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onReplan}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50"
          >
            重新规划
          </button>
          <button
            type="button"
            onClick={() => onAccept(remaining)}
            disabled={remaining.length === 0}
            className="cursor-pointer rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            全部接受
          </button>
        </footer>
      </div>
    </div>
  );
}
