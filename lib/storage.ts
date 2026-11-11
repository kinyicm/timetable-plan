import type { Goal, ScheduleEvent } from "./types";

const EVENTS_KEY = "tp.events.v1";
const GOALS_KEY = "tp.goals.v1";
const REMINDER_KEY = "tp.reminder.v1";

function loadFromStorage<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as T[];
  } catch {
    return [];
  }
}

function saveToStorage<T>(key: string, list: T[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // 忽略写入异常（如存储配额不足）
  }
}

export function loadEvents(): ScheduleEvent[] {
  return loadFromStorage<ScheduleEvent>(EVENTS_KEY);
}

export function saveEvents(list: ScheduleEvent[]): void {
  saveToStorage(EVENTS_KEY, list);
}

export function loadGoals(): Goal[] {
  return loadFromStorage<Goal>(GOALS_KEY);
}

export function saveGoals(list: Goal[]): void {
  saveToStorage(GOALS_KEY, list);
}

export function loadReminderEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(REMINDER_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

export function saveReminderEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMINDER_KEY, String(enabled));
  } catch {
    // 忽略写入异常
  }
}
