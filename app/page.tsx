"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import WeekGrid from "./components/WeekGrid";
import EventDialog from "./components/EventDialog";
import QuickAdd from "./components/QuickAdd";
import ImportTimetable from "./components/ImportTimetable";
import ReminderToast, { type ReminderItem } from "./components/ReminderToast";
import GoalsView, { type GoalCreateInput } from "./components/GoalsView";
import PlanPreview, { type PlanAction } from "./components/PlanPreview";
import AdvisePanel, { type AdviseOption, type AdviseResult } from "./components/AdvisePanel";
import GoalClarify from "./components/GoalClarify";
import SyllabusPanel from "./components/SyllabusPanel";
import type { Goal, ScheduleEvent, KnowledgePoint } from "@/lib/types";
import { loadEvents, loadGoals, loadReminderEnabled, saveEvents, saveGoals, saveReminderEnabled } from "@/lib/storage";
import { addDays, dateKey, minutesToLabel, startOfWeek } from "@/lib/time";
import { findConflicts } from "@/lib/conflicts";
import { computeFreeSlots } from "@/lib/freeSlots";
import { guessKind } from "@/lib/guessKind";
import { detectIntent } from "@/lib/intent";
import { pushHistory, undoHistory, redoHistory } from "@/lib/history";

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

/** 从今天到截止日期的剩余周数（保留一位小数）；无截止日期或已过期时给保守默认值。 */
function weeksUntil(today: string, deadline: string): number {
  if (!deadline) return 4;
  const t = new Date(`${today}T00:00:00`).getTime();
  const d = new Date(`${deadline}T00:00:00`).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(d)) return 4;
  const diff = (d - t) / (7 * 24 * 3600 * 1000);
  if (!Number.isFinite(diff) || diff <= 0) return 1;
  return Math.round(diff * 10) / 10;
}

/**
 * 计算 QuickAdd 应落库的起止分钟数。
 * 吸附后若 endMin <= startMin（放不下，高度为 0），回退到未吸附的原始起点；
 * 回退后仍不足 15 分钟则返回 null（表示这个时间段放不下，不创建）。
 */
function resolveQuickAddSpan(
  startMin: number,
  origStartMin: number,
  durationMin: number,
): { startMin: number; endMin: number } | null {
  const dayEnd = 23 * 60 + 55;
  const snappedEnd = Math.min(startMin + durationMin, dayEnd);
  if (snappedEnd > startMin) {
    return { startMin, endMin: snappedEnd };
  }
  const origEnd = Math.min(origStartMin + durationMin, dayEnd);
  if (origEnd - origStartMin < 15) return null;
  return { startMin: origStartMin, endMin: origEnd };
}

function NavTab({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-primary-soft text-primary ring-1 ring-primary"
          : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${
            active ? "bg-primary text-white" : "bg-slate-200 text-slate-600"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

type DialogState = { mode: "new" | "edit"; event: ScheduleEvent };

type QuickAddState = {
  date: string;
  startMin: number;
  /** 智能接缝吸附前的原始起点，用于吸附后放不下时回退。 */
  origStartMin: number;
  kind: ScheduleEvent["kind"];
  durationMin: number;
  anchor: { x: number; y: number };
};

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
  const [quickAdd, setQuickAdd] = useState<QuickAddState | null>(null);
  const [planText, setPlanText] = useState("");
  const [planStatus, setPlanStatus] = useState<"idle" | "loading">("idle");
  const [planError, setPlanError] = useState("");
  const [planReply, setPlanReply] = useState("");
  const [planSummary, setPlanSummary] = useState("");
  const [planSummaryError, setPlanSummaryError] = useState(false);
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const [showConflicts, setShowConflicts] = useState(false);
  const [view, setView] = useState<"schedule" | "week" | "month" | "year">("schedule");
  // 当前显示的周起点（周一）。服务端给占位值，客户端首次渲染时才读取本地当前时间；
  // 该值在 isClient 为 false 的「加载中」分支里不会被渲染，因此不会造成水合不一致。
  const [weekStart, setWeekStart] = useState<Date>(() =>
    typeof window === "undefined" ? new Date(0) : startOfWeek(new Date()),
  );
  const [goals, setGoals] = useState<Goal[]>(() => loadGoals());
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(() => loadReminderEnabled());
  const [toasts, setToasts] = useState<ReminderItem[]>([]);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [planningGoalId, setPlanningGoalId] = useState<string | null>(null);
  const [advisingGoalId, setAdvisingGoalId] = useState<string | null>(null);
  const [syllabusGoalId, setSyllabusGoalId] = useState<string | null>(null);
  const [advise, setAdvise] = useState<{ goal: Goal; result: AdviseResult } | null>(null);
  const [syllabus, setSyllabus] = useState<{
    goal: Goal;
    subject: string;
    points: KnowledgePoint[];
    source: "outline-provided" | "ai-generated";
  } | null>(null);
  const [planPreview, setPlanPreview] = useState<PlanPreviewState | null>(null);
  const [goalPlanError, setGoalPlanError] = useState("");
  const [goalPlanNotice, setGoalPlanNotice] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [quickAddNotice, setQuickAddNotice] = useState("");
  const [undoToast, setUndoToast] = useState<string | null>(null);
  // 目标澄清卡：输入被判为「目标」时弹出，记录用户原话。
  const [clarify, setClarify] = useState<{ text: string } | null>(null);

  const audioRef = useRef<AudioContext | null>(null);
  const remindedRef = useRef<Set<string>>(new Set());
  const snoozeRef = useRef<Map<string, number>>(new Map());
  const planInputRef = useRef<HTMLInputElement>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adviseAbortRef = useRef<AbortController | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);
  const syllabusAbortRef = useRef<AbortController | null>(null);
  // 记住用户在知识点大纲面板里勾选的点，供后续「方案 → 日程」使用。
  const selectedPointsRef = useRef<KnowledgePoint[]>([]);
  // 始终指向最新的 events，供异步流程（如 AI 安排）在 await 之后读取当前数组。
  const eventsRef = useRef<ScheduleEvent[]>(events);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  // 统一提交 events 变更：把操作前的事件数组压入历史栈，undo/redo 只回滚 events。
  const commitEvents = useCallback((next: ScheduleEvent[], label: string) => {
    const prev = eventsRef.current;
    setEvents(next);
    saveEvents(next);
    pushHistory({
      label,
      undo: () => {
        setEvents(prev);
        saveEvents(prev);
      },
      redo: () => {
        setEvents(next);
        saveEvents(next);
      },
    });
  }, []);

  const handleUndo = useCallback(() => {
    const entry = undoHistory();
    if (!entry) return;
    setUndoToast(entry.label);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoToast(null), 4000);
  }, []);

  const handleRedo = useCallback(() => {
    const entry = redoHistory();
    if (!entry) return;
    setUndoToast(null);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  // 全局撤销/重做快捷键：焦点在输入框 / 文本框 / 可编辑区域内时不拦截，让位给文本编辑。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "z") return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || target.isContentEditable) {
          return;
        }
      }
      e.preventDefault();
      if (e.shiftKey) handleRedo();
      else handleUndo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

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
    const goal = goals.find((g) => g.id === id);
    const orphanCount = events.filter((e) => e.goalId === id).length;

    let message = `确定删除目标「${goal?.title ?? ""}」吗？`;
    if (orphanCount > 0) {
      message += ` 将同时移除 ${orphanCount} 个计划任务。`;
    }
    if (!window.confirm(message)) return;

    const nextGoals = goals.filter((g) => g.id !== id);
    setGoals(nextGoals);
    saveGoals(nextGoals);

    if (orphanCount > 0) {
      const nextEvents = events.filter((e) => e.goalId !== id);
      commitEvents(nextEvents, `删除目标「${goal?.title ?? ""}」`);
    }
  };

  // 流程第一步：知识点大纲（轻）。先拆清单，总需求时长由程序求和，可行性才有客观依据。
  const fetchSyllabus = async (goal: Goal, syllabusText: string) => {
    if (planningGoalId || advisingGoalId || syllabusGoalId) return;
    setSyllabusGoalId(goal.id);
    setGoalPlanError("");
    setGoalPlanNotice("");
    syllabusAbortRef.current?.abort();
    const controller = new AbortController();
    syllabusAbortRef.current = controller;

    try {
      const resp = await fetch("/api/syllabus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          goal: {
            title: goal.title,
            deadline: goal.deadline ?? "",
            hoursPerWeek: goal.hoursPerWeek ?? 10,
          },
          syllabusText,
        }),
      });
      const json = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        subject?: string;
        points?: unknown;
        source?: "outline-provided" | "ai-generated";
      };
      if (!json.ok) {
        setGoalPlanError(json.error ?? "知识点大纲生成失败，请稍后重试");
        return;
      }
      const points = (Array.isArray(json.points) ? json.points : []) as KnowledgePoint[];
      if (points.length === 0) {
        setGoalPlanError("未生成有效知识点，请重试");
        return;
      }
      setSyllabus({
        goal,
        subject: typeof json.subject === "string" && json.subject.trim() ? json.subject : goal.title,
        points,
        source: json.source === "outline-provided" ? "outline-provided" : "ai-generated",
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setGoalPlanError("知识点大纲生成失败，请检查网络后重试");
    } finally {
      setSyllabusGoalId(null);
      syllabusAbortRef.current = null;
    }
  };

  // 入口：目标页「让 AI 规划」或澄清卡确定后，先走知识点大纲。
  const handleGoalPlan = (goal: Goal) => {
    void fetchSyllabus(goal, "");
  };

  // 流程第二步：方案咨询（轻）。需求时长来自勾选知识点，不再让模型估。
  const fetchAdvise = async (goal: Goal, points: KnowledgePoint[]) => {
    if (planningGoalId || advisingGoalId) return;
    setAdvisingGoalId(goal.id);
    setGoalPlanError("");
    setGoalPlanNotice("");
    adviseAbortRef.current?.abort();
    const controller = new AbortController();
    adviseAbortRef.current = controller;

    try {
      const today = dateKey(new Date());
      const weekFreeSlots = computeFreeSlots(events, dateKey(startOfWeek(new Date())), 7, 360, 1440);
      const freeHoursThisWeek =
        Math.round((weekFreeSlots.reduce((s, x) => s + (x.endMin - x.startMin), 0) / 60) * 10) / 10;

      // requiredHours = round(totalMinutes / 6) / 10（小时，保留 0.1），由知识点总时长换算。
      const totalMinutes = points.reduce((s, p) => s + p.estimatedMinutes, 0);
      const requiredHours = Math.round(totalMinutes / 6) / 10;

      const resp = await fetch("/api/advise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          goal: {
            title: goal.title,
            deadline: goal.deadline ?? "",
            hoursPerWeek: goal.hoursPerWeek ?? 10,
            priority: goal.priority ?? "中",
          },
          context: {
            today,
            freeHoursThisWeek,
            weeksUntilDeadline: weeksUntil(today, goal.deadline ?? ""),
            existingTitles: events.map((e) => e.title),
            requiredHours,
          },
        }),
      });
      const json = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        feasibility?: AdviseResult["feasibility"];
        options?: AdviseOption[];
        recommendation?: AdviseResult["recommendation"];
        recommendReason?: string;
      };
      if (!json.ok) {
        setGoalPlanError(json.error ?? "方案咨询失败，请稍后重试");
        return;
      }

      const options: AdviseOption[] = Array.isArray(json.options) ? json.options : [];
      if (options.length === 0) {
        setGoalPlanError("未得到可用方案，请重试");
        return;
      }
      setAdvise({
        goal,
        result: {
          feasibility: json.feasibility ?? {
            verdict: "可行",
            requiredHours: 0,
            supplyHours: 0,
            gapHours: 0,
            note: "",
          },
          options,
          recommendation: json.recommendation ?? options[0].id,
          recommendReason: json.recommendReason ?? "",
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setGoalPlanError("方案咨询失败，请检查网络后重试");
    } finally {
      setAdvisingGoalId(null);
      adviseAbortRef.current = null;
    }
  };

  const handleSyllabusNext = (selected: KnowledgePoint[]) => {
    if (!syllabus) return;
    const goal = syllabus.goal;
    selectedPointsRef.current = selected;
    setSyllabus(null);
    void fetchAdvise(goal, selected);
  };

  const handleSyllabusClose = () => {
    syllabusAbortRef.current?.abort();
    syllabusAbortRef.current = null;
    setSyllabusGoalId(null);
    setSyllabus(null);
    setGoalPlanError("");
  };

  // 第三步：选定方案后，用 /api/goal 按知识点清单生成具体事件（重步骤）。
  const runGoalPlan = async (goal: Goal, strategy?: AdviseOption, points: KnowledgePoint[] = []) => {
    if (planningGoalId) return;
    setPlanningGoalId(goal.id);
    setGoalPlanError("");
    setGoalPlanNotice("");
    planAbortRef.current?.abort();
    const controller = new AbortController();
    planAbortRef.current = controller;

    try {
      // 未来 14 天的空档：今天起算，白天 08:00-23:00，碎片 ≥30 分钟。
      const freeSlots = computeFreeSlots(events, dateKey(new Date()), 14, 360, 1440);
      const existingTitles = events.map((e) => e.title);

      const resp = await fetch("/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
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
          points,
          strategy: strategy
            ? {
                name: strategy.name,
                type: strategy.strategy,
                summary: strategy.summary,
                sessionsPerWeek: strategy.sessionsPerWeek,
                avgSessionMin: strategy.avgSessionMin,
              }
            : undefined,
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
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setGoalPlanError("规划失败，请检查网络后重试");
    } finally {
      setPlanningGoalId(null);
      planAbortRef.current = null;
    }
  };

  const handleSelectStrategy = (option: AdviseOption) => {
    if (!advise) return;
    const goal = advise.goal;
    const points = selectedPointsRef.current;
    setAdvise(null);
    void runGoalPlan(goal, option, points);
  };

  const handleCloseAdvise = () => {
    setAdvise(null);
    setGoalPlanError("");
  };

  const handleReanalyze = () => {
    if (!advise) return;
    const goal = advise.goal;
    const points = selectedPointsRef.current;
    setAdvise(null);
    void fetchAdvise(goal, points);
  };

  const handleCancelAdvise = () => {
    adviseAbortRef.current?.abort();
    adviseAbortRef.current = null;
    setAdvisingGoalId(null);
    setAdvise(null);
    setGoalPlanError("");
  };

  const handleCancelPlanning = () => {
    planAbortRef.current?.abort();
    planAbortRef.current = null;
    setPlanningGoalId(null);
    setGoalPlanError("");
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
    commitEvents(next, "接受 AI 规划");

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
    const points = selectedPointsRef.current;
    setPlanPreview(null);
    void runGoalPlan(goal, undefined, points);
  };

  const handleClosePlanPreview = () => setPlanPreview(null);

  const handleSlotClick = (date: string, startMin: number, anchor: { x: number; y: number }) => {
    // 按时间段猜类型与默认时长（周一至周五白天为课程，其余为任务）。
    const { kind, durationMin } = guessKind(date, startMin);

    // 智能接缝：同一列里若存在「结束 <= startMin 且间隔 < 30 分钟」的事件，
    // 把 startMin 接到那个事件的结束时间上，避免留下难以点击的小缝隙。
    const prev = events
      .filter((e) => e.date === date && e.endMin <= startMin && startMin - e.endMin < 30)
      .sort((a, b) => b.endMin - a.endMin)[0];
    const snappedStart = prev ? prev.endMin : startMin;

    setQuickAddNotice("");
    setQuickAdd({ date, startMin: snappedStart, origStartMin: startMin, kind, durationMin, anchor });
  };

  const handleQuickAddSave = (data: {
    title: string;
    kind: ScheduleEvent["kind"];
    durationMin: number;
  }) => {
    if (!quickAdd) return;
    const span = resolveQuickAddSpan(
      quickAdd.startMin,
      quickAdd.origStartMin,
      data.durationMin,
    );
    if (!span) {
      setQuickAddNotice("这个时间段放不下");
      return;
    }
    const id = genId();
    const newEvent: ScheduleEvent = {
      id,
      title: data.title,
      date: quickAdd.date,
      startMin: span.startMin,
      endMin: span.endMin,
      kind: data.kind,
      unverified: false,
    };
    const next = [...events, newEvent];
    commitEvents(next, `新建「${data.title}」`);
    setQuickAdd(null);
    setQuickAddNotice("");
    setFlashIds([id]);
    setTimeout(() => setFlashIds([]), 1500);
  };

  const handleQuickAddMore = () => {
    if (!quickAdd) return;
    const span = resolveQuickAddSpan(
      quickAdd.startMin,
      quickAdd.origStartMin,
      quickAdd.durationMin,
    );
    setDialog({
      mode: "new",
      event: {
        id: "",
        title: "",
        date: quickAdd.date,
        startMin: span ? span.startMin : quickAdd.origStartMin,
        endMin: span ? span.endMin : Math.min(quickAdd.origStartMin + quickAdd.durationMin, 23 * 60 + 55),
        kind: quickAdd.kind,
      },
    });
    setQuickAdd(null);
    setQuickAddNotice("");
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
    commitEvents(next, exists ? `编辑「${withId.title}」` : `新建「${withId.title}」`);
    setDialog(null);
  };

  const handleDelete = (id: string) => {
    const next = events.filter((e) => e.id !== id);
    commitEvents(next, `删除「${eventById.get(id)?.title ?? "事件"}」`);
    setDialog(null);
  };

  const handleImport = (newEvents: ScheduleEvent[], mode: "append" | "replace") => {
    let next: ScheduleEvent[];
    let keptCount = 0;
    if (mode === "replace") {
      // 覆盖：只清掉 kind === "course" 的旧课程，保留任务 / 事件（含已挂 goalId 的计划任务）。
      const kept = events.filter((e) => e.kind !== "course");
      keptCount = kept.length;
      next = [...kept, ...newEvents];
    } else {
      next = [...events, ...newEvents];
    }
    commitEvents(next, mode === "replace" ? "覆盖导入课表" : "导入课表");

    // 一门课对应一个 groupId，周数 = 总实例数 ÷ 门数，用于导入完成提示。
    const courseCount = new Set(
      newEvents.map((e) => e.groupId).filter((g): g is string => Boolean(g)),
    ).size;
    const weeks = courseCount > 0 ? newEvents.length / courseCount : 1;

    setImportNotice(
      mode === "replace"
        ? `已导入 ${courseCount} 门课 × ${weeks} 周 = ${newEvents.length} 条课程记录（保留 ${keptCount} 个任务）`
        : `已导入 ${courseCount} 门课 × ${weeks} 周 = ${newEvents.length} 条课程记录`,
    );
  };

  const runPlan = async (text: string) => {
    setPlanStatus("loading");
    setPlanError("");
    setPlanReply("");
    setPlanSummary("");
    setPlanSummaryError(false);

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

      const { next, added } = executePlan(json.actions, eventsRef.current);
      commitEvents(next, "AI 安排事件");

      if (added.length > 0) {
        setFlashIds(added.map((e) => e.id));
        setTimeout(() => setFlashIds([]), 2000);
      }

      const droppedCount = typeof json.droppedCount === "number" ? json.droppedCount : 0;
      if (added.length > 0 && droppedCount === 0) {
        setPlanSummary(`已添加 ${added.length} 个安排`);
        setPlanSummaryError(false);
      } else if (added.length > 0 && droppedCount > 0) {
        setPlanSummary(`已添加 ${added.length} 个安排，另有 ${droppedCount} 条无法识别已忽略`);
        setPlanSummaryError(false);
      } else {
        setPlanSummary("未能安排：这句话里没有识别出具体时间。如果想给目标做计划，试试「让 AI 给方案」");
        setPlanSummaryError(true);
      }

      // 模型回复只作为「解释」放在下面一行，颜色更浅，不当作成功提示。
      const modelReply = typeof json.reply === "string" ? json.reply.trim() : "";
      setPlanReply(modelReply);

      // 成功返回并执行完 actions 后清空输入框，并把焦点移回输入框。
      setPlanText("");
      planInputRef.current?.focus();
    } catch {
      setPlanError("安排失败，请检查网络后重试");
    } finally {
      setPlanStatus("idle");
    }
  };

  const handlePlanSend = () => {
    const text = planText.trim();
    if (!text || planStatus === "loading") return;
    // 目标型输入先弹澄清卡，不要直接加事件。
    if (detectIntent(text) === "goal") {
      setClarify({ text });
      return;
    }
    void runPlan(text);
  };

  // 澄清卡 -> 让 AI 给方案：复用现有 advise 流程，原话作为 goal.title。
  const handleClarifyAdvise = (hoursPerWeek: number, deadline: string) => {
    if (!clarify) return;
    const text = clarify.text;
    setClarify(null);
    const goal: Goal = {
      id: genId(),
      level: "week",
      title: text,
      period: dateKey(new Date()),
      deadline,
      hoursPerWeek,
      priority: "中",
    };
    void handleGoalPlan(goal);
  };

  // 澄清卡 -> 只加一条事件：走原来的 /api/plan。
  const handleClarifyAddEvent = () => {
    if (!clarify) return;
    const text = clarify.text;
    setClarify(null);
    void runPlan(text);
  };

  const handleClarifyClose = () => {
    setClarify(null);
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

  const weekStartKey = dateKey(weekStart);
  const weekEndKey = dateKey(addDays(weekStart, 6));
  // 冲突只统计「当前显示这一周」的事件，与顶部「本周有 N 处冲突」文案保持一致。
  const conflicts = findConflicts(
    events.filter((e) => e.date >= weekStartKey && e.date <= weekEndKey),
  );
  // 当前显示这一周的空档（08:00-23:00 减去所有事件），随翻页重算。
  const freeSlots = computeFreeSlots(events, weekStartKey, 7, 360, 1440);

  // 顶部标签角标与「今日概览」所需统计（客户端读取当前日期）。
  const todayKey = dateKey(new Date());
  const todayEvents = events.filter((e) => e.date === todayKey);
  const todayCourseCount = todayEvents.filter((e) => e.kind === "course").length;
  const todayTaskCount = todayEvents.filter((e) => e.kind === "task").length;
  const todayFreeSlotCount = computeFreeSlots(events, todayKey, 1, 360, 1440).length;
  const weekGoalUndone = goals.filter((g) => g.level === "week" && !g.done).length;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 border-t-[3px] border-t-primary bg-white px-4 py-3 shadow-sm">
        {/* 品牌区 */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-sm font-bold text-white">
            课
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold text-slate-900">课表规划</div>
            <div className="text-xs text-slate-400">拍照导入 · 一句话安排 · 到点提醒</div>
          </div>
        </div>

        {/* 导航区 */}
        <nav className="flex items-center gap-1">
          <NavTab active={view === "schedule"} onClick={() => setView("schedule")} count={todayEvents.length}>日程</NavTab>
          <NavTab active={view === "week"} onClick={() => setView("week")} count={weekGoalUndone}>周目标</NavTab>
          <NavTab active={view === "month"} onClick={() => setView("month")} count={0}>月目标</NavTab>
          <NavTab active={view === "year"} onClick={() => setView("year")} count={0}>年目标</NavTab>
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
          <ImportTimetable
            weekStart={weekStart}
            courseCount={events.filter((e) => e.kind === "course").length}
            onImport={handleImport}
          />
        </div>
      </header>

      {/* 今日概览：数字粗体、标签灰字，胶囊展示 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <span className="text-xs font-medium text-slate-400">今日概览</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
          <span className="font-semibold text-slate-900">{todayCourseCount}</span> 门课
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
          <span className="font-semibold text-slate-900">{todayTaskCount}</span> 个任务
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
          <span className="font-semibold text-slate-900">{todayFreeSlotCount}</span> 段空档
        </span>
      </div>

      {importNotice && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {importNotice}
        </div>
      )}

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
          onWeekChange={setWeekStart}
          conflicts={conflicts}
          flashIds={flashIds}
          freeSlots={freeSlots}
          onSlotClick={handleSlotClick}
          onEventClick={handleEventClick}
        />
      </div>

      <div className="border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
        {planSummary && (
          <p className={`mb-1 text-sm ${planSummaryError ? "text-red-600" : "text-slate-700"}`}>
            {planSummary}
          </p>
        )}
        {planReply && <p className="mb-1 text-xs text-slate-400">{planReply}</p>}
        {planError && <p className="mb-2 text-xs text-red-600">{planError}</p>}
        <div className="flex items-center gap-2">
          <input
            ref={planInputRef}
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
          planningGoalId={planningGoalId ?? advisingGoalId ?? syllabusGoalId ?? undefined}
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

      {advise && (
        <AdvisePanel
          goalTitle={advise.goal.title}
          advise={advise.result}
          onPick={handleSelectStrategy}
          onReanalyze={handleReanalyze}
          onClose={handleCloseAdvise}
        />
      )}

      {syllabus && (
        <SyllabusPanel
          key={syllabus.goal.id}
          subject={syllabus.subject}
          points={syllabus.points}
          source={syllabus.source}
          goalTitle={syllabus.goal.title}
          onNext={handleSyllabusNext}
          onClose={handleSyllabusClose}
        />
      )}

      {clarify && (
        <GoalClarify
          text={clarify.text}
          defaultDeadline={dateKey(addDays(new Date(), 28))}
          onAdvise={handleClarifyAdvise}
          onAddEvent={handleClarifyAddEvent}
          onClose={handleClarifyClose}
        />
      )}

      {advisingGoalId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="flex items-center gap-3 rounded-lg bg-white px-5 py-4 shadow-lg">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            <span className="text-sm text-slate-700">正在分析目标与可用时间…</span>
            <button
              type="button"
              onClick={handleCancelAdvise}
              className="ml-2 cursor-pointer rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {syllabusGoalId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="flex items-center gap-3 rounded-lg bg-white px-5 py-4 shadow-lg">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            <span className="text-sm text-slate-700">正在拆解知识点…</span>
            <button
              type="button"
              onClick={handleSyllabusClose}
              className="ml-2 cursor-pointer rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {planningGoalId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="flex items-center gap-3 rounded-lg bg-white px-5 py-4 shadow-lg">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            <span className="text-sm text-slate-700">正在生成具体安排…</span>
            <button
              type="button"
              onClick={handleCancelPlanning}
              className="ml-2 cursor-pointer rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <ReminderToast toasts={toasts} onDismiss={handleDismiss} onSnooze={handleSnooze} />

      {undoToast && (
        <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">
          <span>已撤销：{undoToast}</span>
          <button
            type="button"
            onClick={handleRedo}
            className="cursor-pointer rounded-md bg-white/15 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-white/25"
          >
            重做
          </button>
        </div>
      )}

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

      {quickAdd && (
        <QuickAdd
          kind={quickAdd.kind}
          durationMin={quickAdd.durationMin}
          anchor={quickAdd.anchor}
          notice={quickAddNotice}
          onSave={handleQuickAddSave}
          onMore={handleQuickAddMore}
          onClose={() => setQuickAdd(null)}
        />
      )}
    </main>
  );
}
