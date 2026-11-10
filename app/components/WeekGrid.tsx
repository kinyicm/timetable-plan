"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import type { ScheduleEvent } from "@/lib/types";
import { addDays, dateKey, formatWeekRange, minutesToLabel } from "@/lib/time";

const HOUR_HEIGHT = 56;
const HOURS = 24;
const HEADER_HEIGHT = 56;
const COL_COUNT = 7;

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const KIND_STYLES: Record<ScheduleEvent["kind"], string> = {
  course: "bg-blue-600",
  task: "bg-emerald-600",
  event: "bg-slate-500",
};

const emptySubscribe = () => () => {};

type WeekGridProps = {
  events: ScheduleEvent[];
  weekStart: Date;
  onSlotClick: (date: string, startMin: number) => void;
  onEventClick: (ev: ScheduleEvent) => void;
  flashIds?: string[];
  conflictIds?: string[];
};

export default function WeekGrid({
  events,
  weekStart: initialWeekStart,
  onSlotClick,
  onEventClick,
  flashIds,
  conflictIds,
}: WeekGridProps) {
  // 周视图可自行前后翻页，因此把传入的周起点作为初始值放进内部状态。
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  // 「今天」只能在客户端确定：服务端/首帧 isClient 为 false 时不读取当前时间，
  // 既避免预渲染阶段触发 unstable value 报错，也避免水合阶段日期不一致。
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const todayKey = isClient ? dateKey(new Date()) : null;

  const days = useMemo(
    () => Array.from({ length: COL_COUNT }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const dateToIndex = useMemo(() => {
    const map = new Map<string, number>();
    days.forEach((d, i) => map.set(dateKey(d), i));
    return map;
  }, [days]);

  const flashSet = useMemo(() => new Set(flashIds ?? []), [flashIds]);
  const conflictSet = useMemo(() => new Set(conflictIds ?? []), [conflictIds]);

  const prevWeek = () => setWeekStart((w) => addDays(w, -7));
  const nextWeek = () => setWeekStart((w) => addDays(w, 7));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部工具栏：上一周 / 下一周 / 当前周范围 */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-card px-4 py-3">
        <button
          type="button"
          onClick={prevWeek}
          className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-line bg-white px-3 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          ← 上一周
        </button>
        <span className="text-sm font-medium text-slate-800">
          {formatWeekRange(weekStart)}
        </span>
        <button
          type="button"
          onClick={nextWeek}
          className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-line bg-white px-3 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          下一周 →
        </button>
      </div>

      {/* 可滚动主体：横向 + 纵向 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex">
          {/* 左侧时间轴（横向滚动时固定） */}
          <div className="sticky left-0 z-20 shrink-0 border-r border-line bg-card">
            <div className="border-b border-line" style={{ height: HEADER_HEIGHT }} />
            {Array.from({ length: HOURS }, (_, h) => (
              <div
                key={h}
                className="border-b border-line pr-2 pt-0.5 text-right"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-xs text-slate-400">
                  {minutesToLabel(h * 60)}
                </span>
              </div>
            ))}
          </div>

          {/* 网格区域 */}
          <div className="min-w-[840px] flex-1">
            {/* 表头：周一到周日 */}
            <div className="grid grid-cols-7" style={{ height: HEADER_HEIGHT }}>
              {days.map((d) => {
                const key = dateKey(d);
                const isToday = todayKey !== null && todayKey === key;
                return (
                  <div
                    key={key}
                    className={`flex flex-col items-center justify-center border-b border-r border-line ${
                      isToday ? "bg-primary-soft" : "bg-card"
                    }`}
                  >
                    <span
                      className={`text-sm font-medium ${
                        isToday ? "text-primary" : "text-slate-700"
                      }`}
                    >
                      {WEEKDAY_LABELS[d.getDay()]}
                    </span>
                    <span
                      className={`text-xs ${
                        isToday ? "text-primary" : "text-slate-400"
                      }`}
                    >
                      {key.slice(5).replace("-", "/")}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 主体网格 + 事件浮层 */}
            <div className="relative" style={{ height: HOUR_HEIGHT * HOURS }}>
              <div className="grid grid-cols-7">
                {Array.from({ length: HOURS * COL_COUNT }, (_, i) => {
                  const col = i % COL_COUNT;
                  const hour = Math.floor(i / COL_COUNT);
                  const key = dateKey(days[col]);
                  const isToday = todayKey !== null && todayKey === key;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onSlotClick(key, hour * 60)}
                      aria-label={`${key} ${minutesToLabel(hour * 60)}`}
                      className={`cursor-pointer border-b border-r border-line transition-colors hover:bg-primary-soft/70 ${
                        isToday ? "bg-primary-soft/60" : "bg-white"
                      }`}
                      style={{ height: HOUR_HEIGHT }}
                    />
                  );
                })}
              </div>

              {/* 事件浮层：空白区域点击穿透到下方格子 */}
              <div className="pointer-events-none absolute inset-0">
                {events.map((ev) => {
                  const col = dateToIndex.get(ev.date);
                  if (col === undefined) return null;
                  const top = (ev.startMin / 60) * HOUR_HEIGHT;
                  const height = ((ev.endMin - ev.startMin) / 60) * HOUR_HEIGHT;
                  const left = (col * 100) / COL_COUNT;
                  const width = 100 / COL_COUNT;
                  return (
                    <div
                      key={ev.id}
                      className="pointer-events-auto absolute p-0.5"
                      style={{
                        top,
                        height,
                        left: `${left}%`,
                        width: `${width}%`,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => onEventClick(ev)}
                        className={`relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-md px-1.5 py-1 text-left text-xs text-white shadow-sm ${KIND_STYLES[ev.kind]} ${
                          conflictSet.has(ev.id) ? "ring-2 ring-red-500" : ""
                        } ${flashSet.has(ev.id) ? "animate-pulse" : ""}`}
                      >
                        {ev.unverified && (
                          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white/90 text-[10px] font-bold leading-none text-slate-700">
                            ?
                          </span>
                        )}
                        <span className="truncate pr-5 font-medium">{ev.title}</span>
                        <span className="truncate opacity-90">
                          {minutesToLabel(ev.startMin)} - {minutesToLabel(ev.endMin)}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
