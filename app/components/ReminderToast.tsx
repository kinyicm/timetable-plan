"use client";

import { useEffect } from "react";

export interface ReminderItem {
  id: string;
  eventId: string;
  title: string;
  /** 距离开始的分钟数（用于「还有 N 分钟」）。 */
  minutes: number;
  date: string;
  /** 如「08:00 - 08:45」。 */
  timeLabel: string;
  location?: string;
}

type ReminderToastProps = {
  toasts: ReminderItem[];
  onDismiss: (id: string) => void;
  onSnooze: (id: string, eventId: string) => void;
};

function ReminderCard({
  toast,
  onDismiss,
  onSnooze,
}: {
  toast: ReminderItem;
  onDismiss: (id: string) => void;
  onSnooze: (id: string, eventId: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 8000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      className="pointer-events-auto w-80 rounded-xl border border-line bg-white p-4 shadow-lg"
      style={{ animation: "reminder-slide-in 0.25s ease-out" }}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
        <span aria-hidden>⏰</span>
        还有 {toast.minutes} 分钟
      </p>
      <p className="mt-1 truncate text-sm font-medium text-slate-800">{toast.title}</p>
      <p className="mt-0.5 text-xs text-slate-500">
        {toast.date} {toast.timeLabel}
        {toast.location ? ` · ${toast.location}` : ""}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onSnooze(toast.id, toast.eventId)}
          className="h-8 cursor-pointer rounded-md border border-line bg-white px-3 text-xs text-slate-700 transition-colors hover:bg-slate-50"
        >
          10 分钟后再提
        </button>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="h-8 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700"
        >
          知道了
        </button>
      </div>
    </div>
  );
}

export default function ReminderToast({ toasts, onDismiss, onSnooze }: ReminderToastProps) {
  return (
    <>
      <style>{`@keyframes reminder-slide-in { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex flex-col items-end gap-3">
        {toasts.map((t) => (
          <ReminderCard key={t.id} toast={t} onDismiss={onDismiss} onSnooze={onSnooze} />
        ))}
      </div>
    </>
  );
}
