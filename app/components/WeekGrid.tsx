"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScheduleEvent } from "@/lib/types";
import type { Conflict } from "@/lib/conflicts";
import type { FreeSlot } from "@/lib/freeSlots";
import { DEFAULT_PERIODS, type Period } from "@/lib/periods";
import { addDays, dateKey, formatWeekRange, labelToMinutes, minutesToLabel } from "@/lib/time";

const HOUR_HEIGHT = 56;
const HEADER_HEIGHT = 56;
const COL_COUNT = 7;

// 可见时间窗：06:00-24:00，覆盖早起与熬夜；窗外不画行、不留滚动空白。
const WINDOW_START = 360; // 06:00
const WINDOW_END = 1440; // 24:00
const WINDOW_HOURS = (WINDOW_END - WINDOW_START) / 60; // 18
const WINDOW_HEIGHT = WINDOW_HOURS * HOUR_HEIGHT;

/** 把「一天内的分钟数」换算成窗内 top（px），窗外钳到 0 / 窗高。 */
function minToTop(min: number): number {
  const clamped = Math.max(WINDOW_START, Math.min(WINDOW_END, min));
  return ((clamped - WINDOW_START) / 60) * HOUR_HEIGHT;
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const KIND_BAR: Record<ScheduleEvent["kind"], string> = {
  course: "bg-course-500",
  task: "bg-task-500",
  event: "bg-event-500",
};

const KIND_BG: Record<ScheduleEvent["kind"], string> = {
  course: "bg-course-50",
  task: "bg-task-50",
  event: "bg-event-50",
};

const emptySubscribe = () => () => {};

type WeekGridProps = {
  events: ScheduleEvent[];
  weekStart: Date;
  onWeekChange: (weekStart: Date) => void;
  onSlotClick: (date: string, startMin: number, anchor: { x: number; y: number }) => void;
  onEventClick: (ev: ScheduleEvent) => void;
  flashIds?: string[];
  conflicts?: Conflict[];
  freeSlots?: FreeSlot[];
  periods?: Period[];
};

export default function WeekGrid({
  events,
  weekStart,
  onWeekChange,
  onSlotClick,
  onEventClick,
  flashIds,
  conflicts,
  freeSlots,
  periods,
}: WeekGridProps) {
  // 「今天」只能在客户端确定：服务端/首帧 isClient 为 false 时不读取当前时间，
  // 既避免预渲染阶段触发 unstable value 报错，也避免水合阶段日期不一致。
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const todayKey = isClient ? dateKey(new Date()) : null;
  // 当前时间（分钟数，-1 表示尚未就绪），用于画「当前时间」红线，每 60 秒刷新。
  const [nowMin, setNowMin] = useState<number>(-1);

  // 滚动容器 ref：首次挂载时滚动到 08:00，让早上打开时直接看到第一节课附近。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = minToTop(480);
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

  // 周末（周六/周日）两列的列号，用于整体弱化。
  const weekendCols = useMemo(
    () =>
      days
        .map((d, i) => (d.getDay() === 0 || d.getDay() === 6 ? i : -1))
        .filter((i) => i >= 0),
    [days],
  );

  // 节次区间（route A）：优先用传入的 periods，否则回退默认作息；过滤掉窗外的节次。
  const periodRanges = useMemo(() => {
    const list = periods && periods.length > 0 ? periods : DEFAULT_PERIODS;
    return list
      .map((p, i) => ({
        index: i,
        num: i + 1,
        startMin: labelToMinutes(p.start),
        endMin: labelToMinutes(p.end),
        label: `${p.start}-${p.end}`,
      }))
      .filter((p) => p.endMin > WINDOW_START && p.startMin < WINDOW_END);
  }, [periods]);

  // 节次边界线（起止分钟）：1px slate-200；仅画窗内。
  const periodLineMins = useMemo(() => {
    const set = new Set<number>();
    for (const p of periodRanges) {
      if (p.startMin >= WINDOW_START && p.startMin <= WINDOW_END) set.add(p.startMin);
      if (p.endMin >= WINDOW_START && p.endMin <= WINDOW_END) set.add(p.endMin);
    }
    return [...set].sort((a, b) => a - b);
  }, [periodRanges]);

  // 窗内整点（06:00..23:00），用于整点线 + 未覆盖整点标签。
  const hourMins = useMemo(() => {
    const arr: number[] = [];
    for (let m = WINDOW_START; m < WINDOW_END; m += 60) arr.push(m);
    return arr;
  }, []);

  // 非节次覆盖的整点：仅标整点（如 06/07/12/13/14/22/23）。
  const plainHourMins = useMemo(
    () => hourMins.filter((m) => !periodRanges.some((p) => m >= p.startMin && m < p.endMin)),
    [hourMins, periodRanges],
  );

  // 当前时间所在节次（0 基索引）/ 所在整点，用于左栏标签加粗 + primary-soft 底。
  const currentPeriodIndex = useMemo(() => {
    if (nowMin < 0) return null;
    const idx = periodRanges.findIndex((p) => nowMin >= p.startMin && nowMin < p.endMin);
    return idx >= 0 ? idx : null;
  }, [nowMin, periodRanges]);

  const currentHourMin = useMemo(() => {
    if (nowMin < 0) return null;
    const h = Math.floor(nowMin / 60) * 60;
    return plainHourMins.includes(h) ? h : null;
  }, [nowMin, plainHourMins]);

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

  const prevWeek = () => onWeekChange(addDays(weekStart, -7));
  const nextWeek = () => onWeekChange(addDays(weekStart, 7));

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
          <div className="sticky left-0 z-20 w-20 shrink-0 border-r border-slate-100 bg-white">
            <div className="border-b border-slate-200" style={{ height: HEADER_HEIGHT }} />
            <div className="relative" style={{ height: WINDOW_HEIGHT }}>
              {/* L1 节次标签：节号 + 起止时间 */}
              {periodRanges.map((p) => {
                const current = currentPeriodIndex === p.index;
                return (
                  <div
                    key={`p-${p.index}`}
                    className={`absolute right-0 flex flex-col items-end pr-3 ${
                      current ? "bg-primary-soft" : ""
                    }`}
                    style={{ top: minToTop(p.startMin) }}
                  >
                    <span
                      className={`whitespace-nowrap text-[11px] font-bold leading-4 ${
                        current ? "text-primary" : "text-slate-700"
                      }`}
                    >
                      第{p.num}节
                    </span>
                    <span className="whitespace-nowrap font-mono text-[10px] leading-4 text-slate-400">
                      {p.label}
                    </span>
                  </div>
                );
              })}
              {/* L2 整点标签（仅非节次覆盖的整点） */}
              {plainHourMins.map((m) => {
                const current = currentHourMin === m;
                return (
                  <div
                    key={`h-${m}`}
                    className={`absolute right-0 pr-3 ${current ? "bg-primary-soft" : ""}`}
                    style={{ top: minToTop(m) }}
                  >
                    <span
                      className={`whitespace-nowrap text-[11px] ${
                        current ? "font-semibold text-primary" : "text-slate-400"
                      }`}
                    >
                      {minutesToLabel(m)}
                    </span>
                  </div>
                );
              })}
              {/* 窗尾 24:00 边界标签 */}
              <div className="absolute right-0 pr-3" style={{ top: minToTop(WINDOW_END) }}>
                <span className="whitespace-nowrap text-[11px] text-slate-400">
                  {minutesToLabel(WINDOW_END)}
                </span>
              </div>
            </div>
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
                      isToday ? "bg-primary-soft" : "bg-white"
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
            <div className="relative" style={{ height: WINDOW_HEIGHT }}>
              {/* 点击格子层：每小时一格的空白点击区 */}
              <div className="grid grid-cols-7">
                {Array.from({ length: WINDOW_HOURS * COL_COUNT }, (_, i) => {
                  const col = i % COL_COUNT;
                  const hourIndex = Math.floor(i / COL_COUNT);
                  const startMin = WINDOW_START + hourIndex * 60;
                  const hourVal = Math.floor(startMin / 60);
                  const key = dateKey(days[col]);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={(e) => onSlotClick(key, startMin, { x: e.clientX, y: e.clientY })}
                      aria-label={`${key} ${minutesToLabel(startMin)}`}
                      className={`cursor-pointer border-r border-slate-100 transition-colors hover:bg-indigo-50 ${
                        hourVal % 2 === 0 ? "bg-white" : "bg-slate-50/60"
                      }`}
                      style={{ height: HOUR_HEIGHT }}
                    />
                  );
                })}
              </div>

              {/* 时段弱化带（背景格之上、事件之下）：早起 / 午休 / 晚间 / 深夜 + 周末列 */}
              <div className="pointer-events-none absolute inset-0">
                {/* 早起 06:00-08:00：淡灰 */}
                <div
                  className="absolute left-0 right-0 bg-offhour"
                  style={{ top: minToTop(360), height: minToTop(480) - minToTop(360) }}
                />
                {/* 午休 12:00-13:30：极淡暖灰 */}
                <div
                  className="absolute left-0 right-0 bg-noon"
                  style={{ top: minToTop(720), height: minToTop(810) - minToTop(720) }}
                />
                {/* 晚间 18:00-23:00：淡灰 */}
                <div
                  className="absolute left-0 right-0 bg-offhour"
                  style={{ top: minToTop(1080), height: minToTop(1380) - minToTop(1080) }}
                />
                {/* 深夜 23:00-24:00：更淡一档 */}
                <div
                  className="absolute left-0 right-0 bg-midnight"
                  style={{ top: minToTop(1380), height: minToTop(1440) - minToTop(1380) }}
                />
                {/* 周六/周日两列整体弱化，叠在时段带上层 */}
                {weekendCols.map((col) => (
                  <div
                    key={`weekend-${col}`}
                    className="absolute bottom-0 top-0 bg-weekend"
                    style={{ left: `${(col * 100) / COL_COUNT}%`, width: `${100 / COL_COUNT}%` }}
                  />
                ))}
              </div>

              {/* 节次底色（route A）：每个节次区间铺极淡蓝底 */}
              <div className="pointer-events-none absolute inset-0">
                {periodRanges.map((p) => (
                  <div
                    key={`fill-${p.index}`}
                    className="absolute left-0 right-0 bg-course-50/5"
                    style={{
                      top: minToTop(p.startMin),
                      height: minToTop(p.endMin) - minToTop(p.startMin),
                    }}
                  />
                ))}
              </div>

              {/* 分隔线叠层：整点 slate-100 + 节次边界 slate-200 */}
              <div className="pointer-events-none absolute inset-0">
                {hourMins.map((m) => (
                  <div
                    key={`hl-${m}`}
                    className="absolute left-0 right-0 border-t border-slate-100"
                    style={{ top: minToTop(m) }}
                  />
                ))}
                {periodLineMins.map((m) => (
                  <div
                    key={`pl-${m}`}
                    className="absolute left-0 right-0 border-t border-slate-200"
                    style={{ top: minToTop(m) }}
                  />
                ))}
              </div>

              {/* 今天列高亮叠层：实底 + 顶部主色竖条 */}
              {todayCol !== null && (
                <div
                  className="pointer-events-none absolute bottom-0 top-0 border-t-[3px] border-primary bg-primary-soft"
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
                  const top = minToTop(slot.startMin);
                  const height = minToTop(slot.endMin) - minToTop(slot.startMin);
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
                  const top = minToTop(ev.startMin);
                  const height = minToTop(ev.endMin) - minToTop(ev.startMin);
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
                          className={`absolute left-0 top-0 h-full w-1 ${KIND_BAR[ev.kind]}`}
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
                        <span className="truncate pr-5 text-[11px] font-mono text-slate-500">
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
                    top: minToTop(nowMin),
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

        {/* 空状态：无事件时顶部横向步骤条引导 */}
        {events.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center pt-4">
            <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-white px-5 py-2.5 shadow-sm">
              {[
                { n: "1", text: "拍照导入课表" },
                { n: "2", text: "一句话安排" },
                { n: "3", text: "到点提醒你" },
              ].map((step, i) => (
                <div key={step.n} className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                      {step.n}
                    </span>
                    <span className="whitespace-nowrap text-sm text-slate-600">{step.text}</span>
                  </div>
                  {i < 2 && <span className="text-slate-300">→</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
