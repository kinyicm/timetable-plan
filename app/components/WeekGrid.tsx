"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScheduleEvent } from "@/lib/types";
import type { Conflict } from "@/lib/conflicts";
import type { FreeSlot } from "@/lib/freeSlots";
import { addDays, dateKey, formatWeekRange, minutesToLabel } from "@/lib/time";

const HOUR_HEIGHT = 56;
const HOURS = 24;
const HEADER_HEIGHT = 56;
const COL_COUNT = 7;

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const KIND_BAR: Record<ScheduleEvent["kind"], string> = {
  course: "bg-blue-500",
  task: "bg-emerald-500",
  event: "bg-slate-400",
};

const KIND_BG: Record<ScheduleEvent["kind"], string> = {
  course: "bg-blue-50",
  task: "bg-emerald-50",
  event: "bg-slate-100",
};

const emptySubscribe = () => () => {};

type WeekGridProps = {
  events: ScheduleEvent[];
  weekStart: Date;
  onSlotClick: (date: string, startMin: number) => void;
  onEventClick: (ev: ScheduleEvent) => void;
  flashIds?: string[];
  conflicts?: Conflict[];
  freeSlots?: FreeSlot[];
};

export default function WeekGrid({
  events,
  weekStart: initialWeekStart,
  onSlotClick,
  onEventClick,
  flashIds,
  conflicts,
  freeSlots,
}: WeekGridProps) {
  // 周视图可自行前后翻页，因此把传入的周起点作为初始值放进内部状态。
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  // 「今天」只能在客户端确定：服务端/首帧 isClient 为 false 时不读取当前时间，
  // 既避免预渲染阶段触发 unstable value 报错，也避免水合阶段日期不一致。
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const todayKey = isClient ? dateKey(new Date()) : null;
  // 当前时间（分钟数，-1 表示尚未就绪），用于画「当前时间」红线，每 60 秒刷新。
  const [nowMin, setNowMin] = useState<number>(-1);

  // 滚动容器 ref：首次挂载时滚动到 07:00，避免打开时前 7 小时空白。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 7 * HOUR_HEIGHT;
  }, []);

  // 当前时间红线位置：挂载后立即定位一次，之后每 60 秒刷新。
  // 更新放在 setTimeout/setInterval 回调里（异步），避免 set-state-in-effect。
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setNowMin(now.getHours() * 60 + now.getMinutes());
    };
    const t = setTimeout(update, 0);
    const id = setInterval(update, 60_000);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, []);

  const days = useMemo(
    () => Array.from({ length: COL_COUNT }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const dateToIndex = useMemo(() => {
    const map = new Map<string, number>();
    days.forEach((d, i) => map.set(dateKey(d), i));
    return map;
  }, [days]);

  // 今天在本周内的列号（不在本周时为 null），用于今天列高亮与当前时间红线。
  const todayCol = todayKey !== null ? (dateToIndex.get(todayKey) ?? null) : null;

  const flashSet = useMemo(() => new Set(flashIds ?? []), [flashIds]);
  // 由冲突对反推出「事件 id → 冲突原因列表」与「是否冲突」的集合。
  const conflictInfo = useMemo(() => {
    const set = new Set<string>();
    const reasons = new Map<string, string[]>();
    for (const c of conflicts ?? []) {
      set.add(c.aId);
      set.add(c.bId);
      const arrA = reasons.get(c.aId) ?? [];
      arrA.push(c.reason);
      reasons.set(c.aId, arrA);
      const arrB = reasons.get(c.bId) ?? [];
      arrB.push(c.reason);
      reasons.set(c.bId, arrB);
    }
    return { set, reasons };
  }, [conflicts]);

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
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <span
              className="inline-block h-3.5 w-5 rounded-sm border-l-2 border-dashed border-emerald-300/60 bg-emerald-50/40"
              aria-hidden
            />
            空闲时段
          </span>
          <button
            type="button"
            onClick={nextWeek}
            className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-line bg-white px-3 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            下一周 →
          </button>
        </div>
      </div>

      {/* 可滚动主体：横向 + 纵向 */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex">
          {/* 左侧时间轴（横向滚动时固定） */}
          <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-slate-100 bg-white">
            <div className="border-b border-slate-200" style={{ height: HEADER_HEIGHT }} />
            {Array.from({ length: HOURS }, (_, h) => (
              <div
                key={h}
                className="border-b border-slate-100 pr-2 pt-0.5 text-right"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-[11px] text-slate-400">
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
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                const weekdayColor = isToday
                  ? "text-indigo-600"
                  : isWeekend
                    ? "text-slate-400"
                    : "text-slate-500";
                const dateColor = isToday
                  ? "text-indigo-600"
                  : isWeekend
                    ? "text-slate-400"
                    : "text-slate-900";
                return (
                  <div
                    key={key}
                    className={`flex flex-col items-center justify-center border-b border-slate-200 border-r border-slate-100 ${
                      isToday ? "bg-indigo-50" : "bg-white"
                    }`}
                  >
                    <span className={`text-xs font-medium ${weekdayColor}`}>
                      {WEEKDAY_LABELS[d.getDay()]}
                    </span>
                    <span className={`text-sm font-semibold ${dateColor}`}>
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
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onSlotClick(key, hour * 60)}
                      aria-label={`${key} ${minutesToLabel(hour * 60)}`}
                      className={`cursor-pointer border-b border-r border-slate-100 transition-colors hover:bg-indigo-50 ${
                        hour % 2 === 0 ? "bg-white" : "bg-slate-50/60"
                      }`}
                      style={{ height: HOUR_HEIGHT }}
                    />
                  );
                })}
              </div>

              {/* 今天列高亮叠层（斑马纹之上、事件之下） */}
              {todayCol !== null && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 bg-indigo-50/40"
                  style={{
                    left: `${(todayCol * 100) / COL_COUNT}%`,
                    width: `${100 / COL_COUNT}%`,
                  }}
                />
              )}

              {/* 空闲时段叠层：画在背景之上、事件之下，只展示不接收点击 */}
              <div className="pointer-events-none absolute inset-0">
                {(freeSlots ?? []).map((slot, i) => {
                  const col = dateToIndex.get(slot.date);
                  if (col === undefined) return null;
                  const top = (slot.startMin / 60) * HOUR_HEIGHT;
                  const height = ((slot.endMin - slot.startMin) / 60) * HOUR_HEIGHT;
                  const left = (col * 100) / COL_COUNT;
                  const width = 100 / COL_COUNT;
                  return (
                    <div
                      key={`${slot.date}-${slot.startMin}-${i}`}
                      className="absolute rounded-sm border-l-2 border-dashed border-emerald-300/60 bg-emerald-50/40"
                      style={{ top, height, left: `${left}%`, width: `${width}%` }}
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
                  const isConflict = conflictInfo.set.has(ev.id);
                  const conflictReasons = conflictInfo.reasons.get(ev.id);
                  const conflictTitle = conflictReasons
                    ? [...new Set(conflictReasons)].join("；")
                    : undefined;
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
                        title={conflictTitle}
                        className={`relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-md px-2 py-1 text-left transition-shadow hover:shadow-sm hover:ring-1 hover:ring-black/5 ${KIND_BG[ev.kind]} ${
                          isConflict ? "ring-1 ring-red-400" : ""
                        } ${flashSet.has(ev.id) ? "animate-pulse" : ""}`}
                      >
                        <span
                          className={`absolute left-0 top-0 h-full w-[3px] ${KIND_BAR[ev.kind]}`}
                        />
                        {(ev.unverified || isConflict) && (
                          <span className="absolute right-1 top-1 flex items-center gap-1">
                            {isConflict && (
                              <span className="text-[11px] leading-none text-red-500" aria-hidden>
                                ⚠
                              </span>
                            )}
                            {ev.unverified && (
                              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] font-bold leading-none text-amber-600">
                                ?
                              </span>
                            )}
                          </span>
                        )}
                        <span className="truncate pr-5 text-[13px] font-medium text-slate-900">
                          {ev.title}
                        </span>
                        <span className="truncate pr-5 text-[11px] text-slate-500">
                          {minutesToLabel(ev.startMin)}-{minutesToLabel(ev.endMin)}
                          {ev.location ? ` · ${ev.location}` : ""}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* 当前时间红线：仅今天列，每 60 秒随 nowMin 刷新 */}
              {todayCol !== null && nowMin >= 0 && (
                <div
                  className="pointer-events-none absolute z-10 h-0.5 bg-red-500"
                  style={{
                    top: (nowMin / 60) * HOUR_HEIGHT,
                    left: `${(todayCol * 100) / COL_COUNT}%`,
                    width: `${100 / COL_COUNT}%`,
                  }}
                >
                  <span className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-red-500" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 空状态：无事件时网格中央浮动引导卡片 */}
        {events.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <div className="pointer-events-auto w-80 rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
              <h3 className="mb-2 text-base font-semibold text-slate-900">三步开始用</h3>
              <ul className="text-sm text-slate-600">
                <li className="py-1.5">📷 导入课表（拍照或粘贴）</li>
                <li className="py-1.5">💬 说一句「周三晚 7 点复习高数」</li>
                <li className="py-1.5">⏰ 到点会提醒你</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
