"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import WeekGrid from "./components/WeekGrid";
import EventDialog from "./components/EventDialog";
import ImportTimetable from "./components/ImportTimetable";
import ReminderToast, { type ReminderItem } from "./components/ReminderToast";
import GoalsView, { type GoalCreateInput } from "./components/GoalsView";
import PlanPreview, { type PlanAction } from "./components/PlanPreview";
import type { Goal, ScheduleEvent } from "@/lib/types";
import { loadEvents, loadGoals, loadReminderEnabled, saveEvents, saveGoals, saveReminderEnabled } from "@/lib/storage";
import { addDays, dateKey, minutesToLabel, startOfWeek } from "@/lib/time";
import { findConflicts } from "@/lib/conflicts";
import { computeFreeSlots } from "@/lib/freeSlots";

const emptySubscribe = () => () => {};

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type ConvertedPlanAction = {
  op?: unknown;
  date?: unknown;
  startMin?: unknown;
  endMin?: unknown;
  title?: unknown;
  kind?: unknown;
  location?: unknown;
  remindBeforeMin?: unknown;
  matchTitle?: unknown;
};

/** 执行服务端已换算并校验好的增删动作：只按 op 执行，不再做日期换算或校验。 */
function executePlan(
  rawActions: unknown,
  events: ScheduleEvent[],
): { next: ScheduleEvent[]; added: ScheduleEvent[] } {
  const actions = Array.isArray(rawActions) ? rawActions : [];
  const added: ScheduleEvent[] = [];
  const deleteKeys = new Set<string>();

  for (const raw of actions) {
    const a = (raw ?? {}) as ConvertedPlanAction;

    if (a.op === "delete") {
      const matchTitle = typeof a.matchTitle === "string" ? a.matchTitle.trim() : "";
      const date = typeof a.date === "string" ? a.date : "";
      if (matchTitle && date) deleteKeys.add(`${date}\u0000${matchTitle}`);
      continue;
    }
    if (a.op !== "add") continue;

    const title = typeof a.title === "string" ? a.title.trim() : "";
    const date = typeof a.date === "string" ? a.date : "";
    if (!title || !date) continue;

    const startMin = Math.round(Number(a.startMin));
    const endMin = Math.round(Number(a.endMin));
    const kindRaw = typeof a.kind === "string" ? a.kind : "";
    const kind: ScheduleEvent["kind"] =
      kindRaw === "course" || kindRaw === "task" || kindRaw === "event" ? kindRaw : "event";

    added.push({
      id: genId(),
      title,
      date,
      startMin,
      endMin,
      kind,
      location: typeof a.location === "string" ? a.location.trim() : undefined,
      remindBeforeMin:
        typeof a.remindBeforeMin === "number" && a.remindBeforeMin > 0
          ? a.remindBeforeMin
          : undefined,
    });
  }

  const next = events
    .filter((e) => !deleteKeys.has(`${e.date}\u0000${e.title}`))
    .concat(added);

  return { next, added };
}

/** 把「YYYY-MM-DD」+ 起始分钟数换算成当天的时间戳（本地时区）。 */
function eventStartMs(date: string, startMin: number): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 0, startMin).getTime();
}

function NavTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

type DialogState = { mode: "new" | "edit"; event: ScheduleEvent };

type PlanPreviewState = {
  goal: Goal;
  feasible: boolean;
  advice: string;
  reason: string;
  movedCount: number;
  droppedCount: number;
  actions: PlanAction[];
};

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
  const [showConflicts, setShowConflicts] = useState(false);
  const [view, setView] = useState<"schedule" | "week" | "month" | "year">("schedule");
  const [goals, setGoals] = useState<Goal[]>(() => loadGoals());
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(() => loadReminderEnabled());
  const [toasts, setToasts] = useState<ReminderItem[]>([]);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [planningGoalId, setPlanningGoalId] = useState<string | null>(null);
  const [planPreview, setPlanPreview] = useState<PlanPreviewState | null>(null);
  const [goalPlanError, setGoalPlanError] = useState("");
  const [goalPlanNotice, setGoalPlanNotice] = useState("");

  const audioRef = useRef<AudioContext | null>(null);
  const remindedRef = useRef<Set<string>>(new Set());
  const snoozeRef = useRef<Map<string, number>>(new Map());

  // 冲突由 lib/conflicts 的纯函数统一计算，网格与顶部提示条共用同一份结果。
  const conflicts = useMemo(() => findConflicts(events), [events]);
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  // 音频解锁：用户首次交互时创建 AudioContext 并 resume（浏览器自动播放策略要求）。
  useEffect(() => {
    const unlock = () => {
      if (audioRef.current) {
        if (audioRef.current.state === "suspended") void audioRef.current.resume();
        return;
      }
      try {
        const w = window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const AC = w.AudioContext ?? w.webkitAudioContext;
        if (!AC) return;
        audioRef.current = new AC();
        void audioRef.current.resume();
      } catch {
        // 忽略：某些环境不支持 Web Audio
      }
    };
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  // 提醒扫描：每 30 秒扫一次，触发到点提醒（软件内弹窗 + 提示音 + 网格闪烁 + 系统通知）。
  useEffect(() => {
    if (!reminderEnabled) return;

    const playBeep = () => {
      const ctx = audioRef.current;
      if (!ctx) return;
      try {
        if (ctx.state === "suspended") void ctx.resume();
        const now = ctx.currentTime;
        // 两声「滴-滴」：880Hz，每声 0.12s，间隔 0.1s（第二声从 0.22s 开始）
        [0, 0.22].forEach((offset) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = 880;
          const t0 = now + offset;
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t0);
          osc.stop(t0 + 0.14);
        });
      } catch {
        // 忽略音频播放异常
      }
    };

    const sendSystemNotification = (t: ReminderItem) => {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      try {
        new Notification("课表提醒", {
          body: `${t.title} · ${t.timeLabel}${t.location ? " · " + t.location : ""}`,
        });
      } catch {
        // 忽略：个别环境构造通知可能失败
      }
    };

    const scan = () => {
      const nowMs = Date.now();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const newToasts: ReminderItem[] = [];
      const newFlash: string[] = [];

      for (const ev of events) {
        const remindBefore = ev.remindBeforeMin;
        if (remindBefore == null || remindBefore <= 0) continue;
        const startMs = eventStartMs(ev.date, ev.startMin);
        if (startMs <= nowMs) continue; // 已开始，不提醒
        if (startMs > nowMs + twoHoursMs) continue; // 不在未来 2 小时内，不扫
        if (remindedRef.current.has(ev.id)) continue; // 本次会话已提醒过
        const snoozeUntil = snoozeRef.current.get(ev.id);
        if (snoozeUntil !== undefined) {
          if (nowMs < snoozeUntil) continue; // 仍在「稍后提醒」窗口内
          snoozeRef.current.delete(ev.id);
        }
        const remindAt = startMs - remindBefore * 60 * 1000;
        if (nowMs < remindAt) continue;

        remindedRef.current.add(ev.id);
        const minutes = Math.max(0, Math.round((startMs - nowMs) / 60000));
        newToasts.push({
          id: genId(),
          eventId: ev.id,
          title: ev.title,
          minutes,
          date: ev.date,
          timeLabel: `${minutesToLabel(ev.startMin)} - ${minutesToLabel(ev.endMin)}`,
          location: ev.location,
        });
        newFlash.push(ev.id);
      }

      if (newToasts.length === 0) return;

      playBeep();
      setToasts((prev) => [...prev, ...newToasts].slice(-3)); // 最多同时显示 3 条
      setFlashIds(newFlash);
      setTimeout(() => setFlashIds([]), 3000); // 对应事件在网格闪烁 3 秒
      newToasts.forEach(sendSystemNotification);
    };

    const id = setInterval(scan, 30_000);
    return () => clearInterval(id);
  }, [events, reminderEnabled]);

  const handleDismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleSnooze = useCallback((id: string, eventId: string) => {
    snoozeRef.current.set(eventId, Date.now() + 10 * 60 * 1000);
    remindedRef.current.delete(eventId);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleToggleReminder = () => {
    const next = !reminderEnabled;
    setReminderEnabled(next);
    saveReminderEnabled(next);
  };

  const handleEnableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPerm(perm);
  };

  const handleGoalCreate = (data: GoalCreateInput) => {
    const goal: Goal = { id: genId(), ...data };
    const next = [...goals, goal];
    setGoals(next);
    saveGoals(next);
  };

  const handleGoalRename = (id: string, title: string) => {
    const next = goals.map((g) => (g.id === id ? { ...g, title } : g));
    setGoals(next);
    saveGoals(next);
  };

  const handleGoalToggleDone = (id: string) => {
    const next = goals.map((g) => (g.id === id ? { ...g, done: !g.done } : g));
    setGoals(next);
    saveGoals(next);
  };

  const handleGoalDelete = (id: string) => {
    const next = goals.filter((g) => g.id !== id);
    setGoals(next);
    saveGoals(next);
  };

  const handleGoalPlan = async (goal: Goal) => {
    if (planningGoalId) return;
    setPlanningGoalId(goal.id);
    setGoalPlanError("");
    setGoalPlanNotice("");

    try {
      // 未来 14 天的空档：今天起算，白天 08:00-23:00，碎片 ≥30 分钟。
      const freeSlots = computeFreeSlots(events, dateKey(new Date()), 14);
      const existingTitles = events.map((e) => e.title);

      const resp = await fetch("/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: {
            title: goal.title,
            deadline: goal.deadline ?? "",
            hoursPerWeek: goal.hoursPerWeek ?? 10,
            priority: goal.priority ?? "中",
          },
          freeSlots,
          existingTitles,
          today: dateKey(new Date()),
        }),
      });
      const json = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        feasible?: boolean;
        advice?: string;
        reason?: string;
        movedCount?: number;
        droppedCount?: number;
        actions?: unknown;
      };
      if (!json.ok) {
        setGoalPlanError(json.error ?? "规划失败，请稍后重试");
        return;
      }

      const actions: PlanAction[] = Array.isArray(json.actions)
        ? json.actions
            .map((a) => {
              const x = (a ?? {}) as Record<string, unknown>;
              const date = typeof x.date === "string" ? x.date : "";
              const startMin = Math.round(Number(x.startMin));
              const endMin = Math.round(Number(x.endMin));
              const title = typeof x.title === "string" ? x.title.trim() : "";
              const detail = typeof x.detail === "string" ? x.detail.trim() : "";
              if (!date || !title || !Number.isFinite(startMin) || !Number.isFinite(endMin)) {
                return null;
              }
              return { date, startMin, endMin, title, detail };
            })
            .filter((a): a is PlanAction => a !== null)
        : [];

      setPlanPreview({
        goal,
        feasible: json.feasible === true,
        advice: typeof json.advice === "string" ? json.advice : "",
        reason: typeof json.reason === "string" ? json.reason : "",
        movedCount: typeof json.movedCount === "number" ? json.movedCount : 0,
        droppedCount: typeof json.droppedCount === "number" ? json.droppedCount : 0,
        actions,
      });
    } catch {
      setGoalPlanError("规划失败，请检查网络后重试");
    } finally {
      setPlanningGoalId(null);
    }
  };

  const handleAcceptPlan = (actions: PlanAction[]) => {
    if (!planPreview) return;
    const goalId = planPreview.goal.id;
    const newEvents: ScheduleEvent[] = actions.map((a) => ({
      id: genId(),
      title: a.title,
      date: a.date,
      startMin: a.startMin,
      endMin: a.endMin,
      kind: "task",
      goalId,
      unverified: false,
    }));
    const next = [...events, ...newEvents];
    setEvents(next);
    saveEvents(next);

    const count = newEvents.length;
    const hours = Math.round(
      newEvents.reduce((s, e) => s + (e.endMin - e.startMin), 0) / 60,
    );
    setGoalPlanNotice(`已安排 ${count} 个任务，本周约 ${hours} 小时`);
    setPlanPreview(null);

    if (count > 0) {
      setFlashIds(newEvents.map((e) => e.id));
      setTimeout(() => setFlashIds([]), 2000);
    }
    setView("schedule");
  };

  const handleReplan = () => {
    if (!planPreview) return;
    const goal = planPreview.goal;
    setPlanPreview(null);
    void handleGoalPlan(goal);
  };

  const handleClosePlanPreview = () => setPlanPreview(null);

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
        droppedCount?: unknown;
      };
      if (!json.ok) {
        // 出错：显示错误文字，输入框内容不清理
        setPlanError(json.error ?? "安排失败，请稍后重试");
        return;
      }

      const { next, added } = executePlan(json.actions, events);
      setEvents(next);
      saveEvents(next);

      if (added.length > 0) {
        setFlashIds(added.map((e) => e.id));
        setTimeout(() => setFlashIds([]), 2000);
      }

      let reply = typeof json.reply === "string" ? json.reply : "";
      const droppedCount = typeof json.droppedCount === "number" ? json.droppedCount : 0;
      if (droppedCount > 0) {
        reply = `${reply}（已忽略 ${droppedCount} 条无法识别的安排）`;
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
      <main className="flex h-screen flex-col overflow-hidden bg-slate-50">
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
    <main className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        {/* 品牌区 */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">
            课
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold text-slate-900">课表规划</div>
            <div className="text-xs text-slate-400">拍照导入 · 一句话安排 · 到点提醒</div>
          </div>
        </div>

        {/* 导航区 */}
        <nav className="flex items-center gap-1">
          <NavTab active={view === "schedule"} onClick={() => setView("schedule")}>日程</NavTab>
          <NavTab active={view === "week"} onClick={() => setView("week")}>周目标</NavTab>
          <NavTab active={view === "month"} onClick={() => setView("month")}>月目标</NavTab>
          <NavTab active={view === "year"} onClick={() => setView("year")}>年目标</NavTab>
        </nav>

        {/* 操作区 */}
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={handleToggleReminder}
            aria-pressed={reminderEnabled}
            className="flex cursor-pointer items-center gap-2 text-sm text-slate-600"
          >
            <span>提醒</span>
            <span
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                reminderEnabled ? "bg-indigo-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  reminderEnabled ? "translate-x-4" : ""
                }`}
              />
            </span>
          </button>
          {typeof Notification !== "undefined" && notifPerm === "default" && (
            <button
              type="button"
              onClick={() => void handleEnableNotifications()}
              className="inline-flex cursor-pointer items-center rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50"
            >
              开启系统通知
            </button>
          )}
          <ImportTimetable weekStart={weekStart} onImport={handleImport} />
        </div>
      </header>

      {view === "schedule" ? (
        <>
          {goalPlanNotice && (
            <div className="border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-700">
              {goalPlanNotice}
            </div>
          )}
          {conflicts.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2">
          <button
            type="button"
            onClick={() => setShowConflicts((v) => !v)}
            className="flex w-full cursor-pointer items-center justify-between text-sm text-amber-800"
          >
            <span className="font-medium">⚠ 本周有 {conflicts.length} 处时间冲突</span>
            <span className="text-xs text-amber-600">
              {showConflicts ? "收起" : "展开"}
            </span>
          </button>
          {showConflicts && (
            <ul className="mt-2 space-y-1 text-xs text-amber-700">
              {conflicts.map((c, i) => {
                const a = eventById.get(c.aId);
                const b = eventById.get(c.bId);
                return (
                  <li key={`${c.aId}-${c.bId}-${i}`}>
                    「{a?.title ?? "未知"}」与「{b?.title ?? "未知"}」：{c.reason}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <WeekGrid
          events={events}
          weekStart={weekStart}
          conflicts={conflicts}
          flashIds={flashIds}
          onSlotClick={handleSlotClick}
          onEventClick={handleEventClick}
        />
      </div>

      <div className="border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
        {planReply && <p className="mb-2 text-sm text-slate-700">{planReply}</p>}
        {planError && <p className="mb-2 text-xs text-red-600">{planError}</p>}
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
            className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <button
            type="button"
            onClick={() => void handlePlanSend()}
            disabled={planStatus === "loading" || !planText.trim()}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {planStatus === "loading" ? "AI 正在安排…" : "发送"}
          </button>
        </div>
      </div>
        </>
      ) : (
        <GoalsView
          level={view}
          goals={goals}
          events={events}
          onCreate={handleGoalCreate}
          onRename={handleGoalRename}
          onToggleDone={handleGoalToggleDone}
          onDelete={handleGoalDelete}
          onPlan={(goal) => void handleGoalPlan(goal)}
          planningGoalId={planningGoalId ?? undefined}
        />
      )}

      {goalPlanError && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {goalPlanError}
        </div>
      )}

      {planPreview && (
        <PlanPreview
          goalTitle={planPreview.goal.title}
          feasible={planPreview.feasible}
          advice={planPreview.advice}
          reason={planPreview.reason}
          movedCount={planPreview.movedCount}
          droppedCount={planPreview.droppedCount}
          actions={planPreview.actions}
          onReplan={handleReplan}
          onAccept={handleAcceptPlan}
          onClose={handleClosePlanPreview}
        />
      )}

      <ReminderToast toasts={toasts} onDismiss={handleDismiss} onSnooze={handleSnooze} />

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
