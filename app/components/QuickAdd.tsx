"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScheduleEvent } from "@/lib/types";

const DURATIONS = [
  { value: 30, label: "30 分" },
  { value: 60, label: "1 小时" },
  { value: 90, label: "1.5 小时" },
  { value: 120, label: "2 小时" },
];

const GAP = 8;

type QuickAddProps = {
  kind: ScheduleEvent["kind"];
  durationMin: number;
  anchor: { x: number; y: number };
  notice?: string;
  onSave: (data: { title: string; kind: ScheduleEvent["kind"]; durationMin: number }) => void;
  onMore: () => void;
  onClose: () => void;
};

/**
 * 轻量快捷新建气泡：点空白格后在格子附近浮出，输入标题 + 选时长即可创建。
 * 「更多选项」跳转到完整 EventDialog。
 */
export default function QuickAdd({
  kind,
  durationMin,
  anchor,
  notice,
  onSave,
  onMore,
  onClose,
}: QuickAddProps) {
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(durationMin);
  const inputRef = useRef<HTMLInputElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // 自动聚焦标题输入框。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 定位：默认在锚点右侧，放不下则翻到左侧 / 上方；直接改 DOM，避免 effect 里 setState。
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x + GAP;
    let top = anchor.y;
    if (left + rect.width > vw - GAP) left = anchor.x - rect.width - GAP;
    if (top + rect.height > vh - GAP) top = anchor.y - rect.height;
    left = Math.max(GAP, Math.min(left, vw - rect.width - GAP));
    top = Math.max(GAP, Math.min(top, vh - rect.height - GAP));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [anchor]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onSave({ title: t, kind, durationMin: duration });
  };

  return (
    <>
      {/* 透明遮罩：点击气泡外部关闭 */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={bubbleRef}
        className="fixed z-50 w-72 rounded-lg border border-line bg-white p-3 shadow-lg"
        style={{ left: anchor.x, top: anchor.y }}
      >
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="要做什么？"
          className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm text-slate-800 outline-none transition-colors focus:border-primary"
        />
        {notice && <p className="mt-1.5 text-xs text-red-600">{notice}</p>}
        <div className="mt-2 flex items-center gap-1">
          {DURATIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDuration(d.value)}
              className={`h-7 flex-1 cursor-pointer rounded-md text-xs transition-colors ${
                duration === d.value
                  ? "bg-primary text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>回车创建 · Esc 取消</span>
          <button
            type="button"
            onClick={onMore}
            className="cursor-pointer text-primary hover:underline"
          >
            更多选项 →
          </button>
        </div>
      </div>
    </>
  );
}
