"use client";

import { useMemo, useState } from "react";
import type { Goal, ScheduleEvent } from "@/lib/types";
import { dateKey, startOfWeek } from "@/lib/time";
import { getGoalFlags } from "@/lib/goals";

const LEVEL_LABEL: Record<Goal["level"], string> = {
  year: "年目标",
  month: "月目标",
  week: "周目标",
};

/** 当前层级对应的「当前周期」标识：year → "2026"、month → "2026-11"、week → 本周一日期。 */
function currentPeriod(level: Goal["level"]): string {
  const now = new Date();
  if (level === "year") return String(now.getFullYear());
  if (level === "month") {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  return dateKey(startOfWeek(now));
}

function formatDuration(min: number): string {
  if (min <= 0) return "0 分钟";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export type GoalCreateInput = {
  title: string;
  level: Goal["level"];
  period: string;
  parentId?: string;
};

type GoalsViewProps = {
  level: Goal["level"];
  goals: Goal[];
  events: ScheduleEvent[];
  onCreate: (data: GoalCreateInput) => void;
  onRename: (id: string, title: string) => void;
  onToggleDone: (id: string) => void;
  onDelete: (id: string) => void;
};

function GoalRow({
  goal,
  parentTitle,
  duration,
  flags,
  onRename,
  onToggleDone,
  onDelete,
}: {
  goal: Goal;
  parentTitle: string | undefined;
  duration: number;
  flags: string[];
  onRename: (id: string, title: string) => void;
  onToggleDone: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal.title);

  const commit = () => {
    const t = draft.trim();
    if (t) onRename(goal.id, t);
    setEditing(false);
  };

  return (
    <li className="rounded-lg border border-line bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={goal.done ?? false}
          onChange={() => onToggleDone(goal.id)}
          className="h-4 w-4 cursor-pointer accent-primary"
        />
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
              if (e.key === "Escape") {
                setDraft(goal.title);
                setEditing(false);
              }
            }}
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-sm text-slate-800 outline-none focus:border-primary"
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate text-sm font-medium ${
              goal.done ? "text-slate-400 line-through" : "text-slate-800"
            }`}
          >
            {goal.title}
          </span>
        )}
        {flags.map((f) => (
          <span
            key={f}
            className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
          >
            {f}
          </span>
        ))}
        <span className="shrink-0 text-xs text-slate-500">
          {formatDuration(duration)}
        </span>
        {editing ? (
          <>
            <button
              type="button"
              onClick={commit}
              className="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-xs text-white hover:bg-blue-700"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(goal.title);
                setEditing(false);
              }}
              className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setDraft(goal.title);
                setEditing(true);
              }}
              className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              编辑
            </button>
            <button
              type="button"
              onClick={() => onDelete(goal.id)}
              className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
            >
              删除
            </button>
          </>
        )}
      </div>
      {goal.level === "week" && (
        <p className="mt-1.5 pl-6 text-xs text-slate-500">
          父目标：{parentTitle ?? "未设置"}
        </p>
      )}
    </li>
  );
}

export default function GoalsView({
  level,
  goals,
  events,
  onCreate,
  onRename,
  onToggleDone,
  onDelete,
}: GoalsViewProps) {
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");

  const levelGoals = useMemo(
    () =>
      goals
        .filter((g) => g.level === level)
        .sort((a, b) => a.period.localeCompare(b.period) || a.title.localeCompare(b.title)),
    [goals, level],
  );

  const goalById = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);

  // 事件时长按 goalId 汇总（分钟）。
  const durationByGoal = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of events) {
      if (!ev.goalId) continue;
      const dur = ev.endMin - ev.startMin;
      m.set(ev.goalId, (m.get(ev.goalId) ?? 0) + dur);
    }
    return m;
  }, [events]);

  // 父目标候选：week → 当前月目标；month → 当前年目标；year 无父目标。
  const parentCandidates = useMemo(() => {
    if (level === "year") return [] as Goal[];
    const parentLevel: Goal["level"] = level === "week" ? "month" : "year";
    const parentPeriod = currentPeriod(parentLevel);
    return goals.filter((g) => g.level === parentLevel && g.period === parentPeriod);
  }, [goals, level]);

  const handleSubmit = () => {
    const t = title.trim();
    if (!t) return;
    let pid: string | undefined;
    if (level !== "year") {
      if (parentCandidates.length === 1) {
        pid = parentCandidates[0].id; // 唯一父目标 → 自动挂 parentId
      } else if (parentCandidates.length > 1) {
        pid = parentId || parentCandidates[0].id; // 多个 → 用户选择
      }
    }
    onCreate({ title: t, level, period: currentPeriod(level), parentId: pid });
    setTitle("");
    setParentId("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-2xl px-4 py-6">
        <h2 className="text-lg font-semibold text-slate-900">{LEVEL_LABEL[level]}</h2>

        {/* 新增目标 */}
        <div className="mt-4 rounded-lg border border-line bg-white p-4">
          <div className="flex items-center gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSubmit();
              }}
              placeholder={`新增${LEVEL_LABEL[level]}`}
              className="h-9 min-w-0 flex-1 rounded-md border border-line bg-white px-3 text-sm text-slate-800 outline-none transition-colors focus:border-primary"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!title.trim()}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              新增
            </button>
          </div>

          {level !== "year" && parentCandidates.length === 0 && (
            <p className="mt-2 text-xs text-slate-400">
              当前无可用父目标，新增后将标记为「未归属」。
            </p>
          )}
          {level !== "year" && parentCandidates.length === 1 && (
            <p className="mt-2 text-xs text-slate-500">
              将自动归入「{parentCandidates[0].title}」。
            </p>
          )}
          {level !== "year" && parentCandidates.length > 1 && (
            <div className="mt-2 flex items-center gap-2">
              <label className="shrink-0 text-xs text-slate-600">父目标</label>
              <select
                value={parentId || parentCandidates[0].id}
                onChange={(e) => setParentId(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-sm text-slate-800 outline-none focus:border-primary"
              >
                {parentCandidates.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* 目标列表 */}
        {levelGoals.length === 0 ? (
          <p className="mt-6 text-center text-sm text-slate-400">暂无{LEVEL_LABEL[level]}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {levelGoals.map((g) => (
              <GoalRow
                key={g.id}
                goal={g}
                parentTitle={g.parentId ? goalById.get(g.parentId)?.title : undefined}
                duration={durationByGoal.get(g.id) ?? 0}
                flags={getGoalFlags(g, goals)}
                onRename={onRename}
                onToggleDone={onToggleDone}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
