"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import WeekGrid from "./components/WeekGrid";
import EventDialog from "./components/EventDialog";
import ImportTimetable from "./components/ImportTimetable";
import type { ScheduleEvent } from "@/lib/types";
import { loadEvents, saveEvents } from "@/lib/storage";
import { addDays, dateKey, minutesToLabel, startOfWeek } from "@/lib/time";

const emptySubscribe = () => () => {};

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type PlanActionEvent = {
  date?: unknown;
  startMin?: unknown;
  endMin?: unknown;
  title?: unknown;
  kind?: unknown;
};

type PlanAction = {
  op?: unknown;
  event?: PlanActionEvent;
};

/** 校验并执行模型返回的增删动作：不合法的丢弃并计数，合法的返回新事件列表。 */
function executePlan(
  rawActions: unknown,
  events: ScheduleEvent[],
  weekStartKey: string,
  weekEndKey: string,
): { next: ScheduleEvent[]; added: ScheduleEvent[]; dropped: number } {
  const actions = Array.isArray(rawActions) ? rawActions : [];
  let dropped = 0;
  const added: ScheduleEvent[] = [];
  const deleteKeys = new Set<string>();

  for (const raw of actions) {
    const a = (raw ?? {}) as PlanAction;
    const ev = (a.event ?? {}) as PlanActionEvent;
    const title = typeof ev.title === "string" ? ev.title.trim() : "";
    const date = typeof ev.date === "string" ? ev.date : "";
    const op = a.op;

    // 标题为空 → 丢弃
    if (!title) {
      dropped++;
      continue;
    }
    // 日期不在本周范围 → 丢弃
    if (!date || date < weekStartKey || date > weekEndKey) {
      dropped++;
      continue;
    }

    // 删除：只按「日期 + 标题」匹配，不需要起止时间
    if (op === "delete") {
      deleteKeys.add(`${date}\u0000${title}`);
      continue;
    }
    if (op !== "add") {
      dropped++;
      continue;
    }

    const startMin = Math.round(Number(ev.startMin));
    const endMin = Math.round(Number(ev.endMin));
    // 起止时间不在 0..1440 → 丢弃
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) {
      dropped++;
      continue;
    }
    if (startMin < 0 || startMin > 1440 || endMin < 0 || endMin > 1440) {
      dropped++;
      continue;
    }
    // 结束不晚于开始 → 丢弃
    if (endMin <= startMin) {
      dropped++;
      continue;
    }

    const kindRaw = typeof ev.kind === "string" ? ev.kind : "";
    const kind: ScheduleEvent["kind"] =
      kindRaw === "course" || kindRaw === "task" || kindRaw === "event" ? kindRaw : "event";

    added.push({
      id: genId(),
      title,
      date,
      startMin,
      endMin,
      kind,
    });
  }

  const next = events
    .filter((e) => !deleteKeys.has(`${e.date}\u0000${e.title}`))
    .concat(added);

  return { next, added, dropped };
}

type DialogState = { mode: "new" | "edit"; event: ScheduleEvent };

export default function Home() {
  // 服务端与首帧返回 false，挂载后返回 true，用于延后「当前时间」的读取。
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // loadEvents 内部有 window 守卫：服务端/预渲染返回 []，客户端才真正读取 localStorage。
  const [events, setEvents] = useState<ScheduleEvent[]>(() => loadEvents());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [planText, setPlanText] = useState("");
  const [planStatus, setPlanStatus] = useState<"idle" | "loading">("idle");
  const [planError, setPlanError] = useState("");
  const [planReply, setPlanReply] = useState("");
  const [flashIds, setFlashIds] = useState<string[]>([]);

  // 同一天、时间段相交的事件视为冲突，在网格上用红色左边框提示。
  const conflictIds = useMemo(() => {
    const set = new Set<string>();
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];
        if (a.date === b.date && a.startMin < b.endMin && b.startMin < a.endMin) {
          set.add(a.id);
          set.add(b.id);
        }
      }
    }
    return Array.from(set);
  }, [events]);

  const handleSlotClick = (date: string, startMin: number) => {
    setDialog({
      mode: "new",
      event: {
        id: "",
        title: "",
        date,
        startMin,
        endMin: Math.min(startMin + 60, 1410),
        kind: "course",
      },
    });
  };

  const handleEventClick = (ev: ScheduleEvent) => {
    setDialog({ mode: "edit", event: ev });
  };

  const handleSave = (ev: ScheduleEvent) => {
    // EventDialog 编辑保存时不回传 unverified，因此保存后自动清除「未核对」标记。
    const withId = ev.id ? ev : { ...ev, id: genId() };
    const exists = events.some((e) => e.id === withId.id);
    const next = exists
      ? events.map((e) => (e.id === withId.id ? withId : e))
      : [...events, withId];
    setEvents(next);
    saveEvents(next);
    setDialog(null);
  };

  const handleDelete = (id: string) => {
    const next = events.filter((e) => e.id !== id);
    setEvents(next);
    saveEvents(next);
    setDialog(null);
  };

  const handleImport = (newEvents: ScheduleEvent[]) => {
    const next = [...events, ...newEvents];
    setEvents(next);
    saveEvents(next);
  };

  const handlePlanSend = async () => {
    const text = planText.trim();
    if (!text || planStatus === "loading") return;
    setPlanStatus("loading");
    setPlanError("");
    setPlanReply("");

    const existingSummary = events.length
      ? events
          .map((e) => `- ${e.date} ${minutesToLabel(e.startMin)}-${minutesToLabel(e.endMin)} ${e.title}`)
          .join("\n")
      : "（暂无已安排的事件）";

    try {
      const resp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          context: {
            today: dateKey(new Date()),
            weekStart: weekStartKey,
            weekEnd: weekEndKey,
            existing: existingSummary,
          },
        }),
      });
      const json = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        actions?: unknown;
        reply?: unknown;
      };
      if (!json.ok) {
        // 出错：显示错误文字，输入框内容不清理
        setPlanError(json.error ?? "安排失败，请稍后重试");
        return;
      }

      const { next, added, dropped } = executePlan(json.actions, events, weekStartKey, weekEndKey);
      setEvents(next);
      saveEvents(next);

      if (added.length > 0) {
        setFlashIds(added.map((e) => e.id));
        setTimeout(() => setFlashIds([]), 2000);
      }

      let reply = typeof json.reply === "string" ? json.reply : "";
      if (dropped > 0) {
        reply = `${reply}（已忽略 ${dropped} 条不合法的安排）`;
      }
      setPlanReply(reply);
    } catch {
      setPlanError("安排失败，请检查网络后重试");
    } finally {
      setPlanStatus("idle");
    }
  };

  if (!isClient) {
    return (
      <main className="flex h-screen flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-card px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-900">周视图</h1>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-400">
          加载中…
        </div>
      </main>
    );
  }

  const weekStart = startOfWeek(new Date());
  const weekStartKey = dateKey(weekStart);
  const weekEndKey = dateKey(addDays(weekStart, 6));

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-line bg-card px-4 py-3">
        <h1 className="text-lg font-semibold text-slate-900">周视图</h1>
        <div className="flex items-center gap-3">
          <ImportTimetable weekStart={weekStart} onImport={handleImport} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <WeekGrid
          events={events}
          weekStart={weekStart}
          conflictIds={conflictIds}
          flashIds={flashIds}
          onSlotClick={handleSlotClick}
          onEventClick={handleEventClick}
        />
      </div>

      <div className="border-t border-line bg-card px-4 py-3">
        {planReply && <p className="mb-2 text-sm text-slate-700">{planReply}</p>}
        {planError && <p className="mb-2 text-sm text-red-600">{planError}</p>}
        <div className="flex items-center gap-2">
          <input
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                void handlePlanSend();
              }
            }}
            placeholder="用一句话安排，如：周三晚上 7 点复习高数"
            className="h-9 min-w-0 flex-1 rounded-md border border-line bg-white px-3 text-sm text-slate-800 outline-none transition-colors focus:border-primary"
          />
          <button
            type="button"
            onClick={() => void handlePlanSend()}
            disabled={planStatus === "loading" || !planText.trim()}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {planStatus === "loading" ? "AI 正在安排…" : "发送"}
          </button>
        </div>
      </div>

      {dialog && (
        <EventDialog
          mode={dialog.mode}
          initial={dialog.event}
          existing={events}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}
