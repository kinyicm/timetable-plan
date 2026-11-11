"use client";

import { useEffect, useRef, useState } from "react";

/** 单项高度（px），scrollTop 与居中项换算都以此为准。 */
const ITEM_H = 32;
/** 首尾空占位高度，保证第 0 项 / 最后一项也能滚到中间。 */
const SPACER_H = 64;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toHHMM(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function parseHHMM(s: string): number | null {
  const parts = s.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

type TimeWheelProps = {
  value: number;
  onChange: (min: number) => void;
  minAllowed?: number;
  maxAllowed?: number;
};

export default function TimeWheel({
  value,
  onChange,
  minAllowed,
  maxAllowed,
}: TimeWheelProps) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  const [editing, setEditing] = useState(false);
  const hourRef = useRef<HTMLDivElement>(null);
  const minuteRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | null>(null);

  // 挂载与外部 value 变化时，把两列滚到对应项（不用 smooth）。
  useEffect(() => {
    if (hourRef.current) hourRef.current.scrollTop = hour * ITEM_H;
    if (minuteRef.current) minuteRef.current.scrollTop = (minute / 5) * ITEM_H;
  }, [hour, minute]);

  // 统一归一到 5 的倍数；min/max 只用于禁用项展示，不在组件内硬性截断，
  // 越界时交由父组件（EventDialog）做「接缝/回退」处理，避免报错卡住用户。
  const normalize = (m: number) => Math.round(m / 5) * 5;

  // 滚动停止 120ms 后按 scrollTop 计算居中项并抛出新值。
  const settle = (which: "hour" | "minute") => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      if (which === "hour") {
        const el = hourRef.current;
        if (!el) return;
        const idx = Math.round(el.scrollTop / ITEM_H);
        const h = Math.min(23, Math.max(0, idx));
        onChange(normalize(h * 60 + minute));
      } else {
        const el = minuteRef.current;
        if (!el) return;
        const idx = Math.round(el.scrollTop / ITEM_H);
        const m = Math.min(11, Math.max(0, idx)) * 5;
        onChange(normalize(hour * 60 + m));
      }
    }, 120);
  };

  if (editing) {
    return (
      <div className="flex h-[160px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
        <input
          type="time"
          step={300}
          value={toHHMM(value)}
          onChange={(e) => {
            const m = parseHHMM(e.target.value);
            if (m !== null) onChange(normalize(m));
          }}
          onBlur={() => setEditing(false)}
          autoFocus
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-center text-xl font-semibold text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
      </div>
    );
  }

  const renderColumn = (
    which: "hour" | "minute",
    items: number[],
    label: string,
    format: (n: number) => string,
    isDisabled: (n: number) => boolean,
    display: number,
  ) => {
    const ref = which === "hour" ? hourRef : minuteRef;
    return (
      <div className="relative h-[160px]">
        <div
          ref={ref}
          onScroll={() => settle(which)}
          role="listbox"
          aria-label={label}
          className="no-scrollbar h-full overflow-y-auto"
          style={{ scrollSnapType: "y mandatory", overscrollBehavior: "contain" }}
        >
          <div style={{ height: SPACER_H }} />
          {items.map((n) => {
            const disabled = isDisabled(n);
            return (
              <div
                key={n}
                role="option"
                aria-selected={n === display}
                className={`flex h-8 items-center justify-center text-sm font-medium ${
                  disabled ? "pointer-events-none text-slate-300" : "text-slate-900"
                }`}
                style={{ scrollSnapAlign: "center" }}
              >
                {format(n)}
              </div>
            );
          })}
          <div style={{ height: SPACER_H }} />
        </div>

        {/* 中间高亮框 + 可点击数字（点击切换为直接输入） */}
        <div className="pointer-events-none absolute inset-x-0 top-16 flex h-8 items-center justify-center border-y border-indigo-200 bg-primary-soft">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="pointer-events-auto cursor-pointer rounded px-2 py-0.5 text-sm font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
          >
            {format(display)}
          </button>
        </div>

        {/* 上下渐隐遮罩 */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-8"
          style={{ background: "linear-gradient(to bottom, var(--color-card), transparent)" }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
          style={{ background: "linear-gradient(to top, var(--color-card), transparent)" }}
        />
      </div>
    );
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      {renderColumn(
        "hour",
        HOURS,
        "小时",
        (n) => String(n),
        (h) =>
          (minAllowed != null && h * 60 + 55 < minAllowed) ||
          (maxAllowed != null && h * 60 > maxAllowed),
        hour,
      )}
      {renderColumn(
        "minute",
        MINUTES,
        "分钟",
        (n) => pad2(n),
        (m) =>
          (minAllowed != null && hour * 60 + m < minAllowed) ||
          (maxAllowed != null && hour * 60 + m > maxAllowed),
        minute,
      )}
    </div>
  );
}
