"use client";

import { useCallback, useSyncExternalStore } from "react";
import WeekGrid from "./components/WeekGrid";
import type { ScheduleEvent } from "@/lib/types";
import { addDays, dateKey, startOfWeek } from "@/lib/time";

const emptySubscribe = () => () => {};

export default function Home() {
  // 服务端与首帧返回 false，挂载后返回 true。
  // 用于把「当前时间」的读取延后到客户端，避免预渲染阶段触发 unstable value 报错。
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const handleSlotClick = useCallback((date: string, startMin: number) => {
    console.log("[slot]", date, startMin);
  }, []);

  const handleEventClick = useCallback((ev: ScheduleEvent) => {
    console.log("[event]", ev.title, ev);
  }, []);

  const header = (
    <header className="flex items-center justify-between border-b border-line bg-card px-4 py-3">
      <h1 className="text-lg font-semibold text-slate-900">周视图</h1>
      <p className="text-sm text-slate-500">课程 / 任务 / 事件</p>
    </header>
  );

  if (!isClient) {
    return (
      <main className="flex h-screen flex-col overflow-hidden">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-400">
          加载中…
        </div>
      </main>
    );
  }

  const weekStart = startOfWeek(new Date());

  // 先用两条硬编码事件验证渲染，暂不接存储、不接 AI。
  const events: ScheduleEvent[] = [
    {
      id: "demo-course",
      title: "高等数学",
      date: dateKey(weekStart),
      startMin: 8 * 60,
      endMin: 9 * 60 + 30,
      kind: "course",
      location: "教一 201",
    },
    {
      id: "demo-task",
      title: "整理周报",
      date: dateKey(addDays(weekStart, 1)),
      startMin: 19 * 60,
      endMin: 20 * 60,
      kind: "task",
      unverified: true,
    },
  ];

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      {header}
      <div className="min-h-0 flex-1">
        <WeekGrid
          events={events}
          weekStart={weekStart}
          onSlotClick={handleSlotClick}
          onEventClick={handleEventClick}
        />
      </div>
    </main>
  );
}
