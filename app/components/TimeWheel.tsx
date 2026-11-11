"use client";

import { useEffect, useRef, useState } from "react";
import { parseTime } from "@/lib/parseTime";

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

type TimeWheelProps = {
  value: number;
  onChange: (min: number) => void;
  minAllowed?: number;
  maxAllowed?: number;
  /** 输入模式提交前的额外校验：返回错误文案表示拒绝，返回 null 表示通过。 */
  validateInput?: (min: number) => string | null;
};

export default function TimeWheel({
  value,
  onChange,
  minAllowed,
  maxAllowed,
  validateInput,
}: TimeWheelProps) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const hourRef = useRef<HTMLDivElement>(null);
  const minuteRef = useRef<HTMLDivElement>(null);
  const hourWrapRef = useRef<HTMLDivElement>(null);
  const minuteWrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const settleTimer = useRef<number | null>(null);
  const lastWheel = useRef<{ hour: number; minute: number }>({ hour: 0, minute: 0 });

  // 统一归一到 5 的倍数。
  const normalize = (m: number) => Math.round(m / 5) * 5;

  // 挂载与外部 value 变化时，把两列滚到对应项（不用 smooth）。
  useEffect(() => {
    if (hourRef.current) hourRef.current.scrollTop = hour * ITEM_H;
    if (minuteRef.current) minuteRef.current.scrollTop = (minute / 5) * ITEM_H;
  }, [hour, minute]);

  // 进入编辑态自动聚焦并全选。
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

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

  // 步进一项并更新值（键盘、渐隐区点击共用）。
  const step = (which: "hour" | "minute", dir: number) => {
    if (which === "hour") {
      const h = Math.min(23, Math.max(0, hour + dir));
      onChange(normalize(h * 60 + minute));
    } else {
      const m = Math.min(11, Math.max(0, Math.round(minute / 5) + dir)) * 5;
      onChange(normalize(hour * 60 + m));
    }
  };

  // 轮盘滚轮减速：手动绑定并 passive:false 才能 preventDefault。
  useEffect(() => {
    const bind = (
      wrap: HTMLDivElement | null,
      scroller: HTMLDivElement | null,
      which: "hour" | "minute",
    ) => {
      if (!wrap || !scroller) return () => {};
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const now = Date.now();
        if (now - lastWheel.current[which] < 60) return;
        lastWheel.current[which] = now;
        const dir = e.deltaY > 0 ? 1 : -1;
        scroller.scrollBy({ top: dir * ITEM_H, behavior: "smooth" });
      };
      wrap.addEventListener("wheel", onWheel, { passive: false });
      return () => wrap.removeEventListener("wheel", onWheel);
    };
    const u1 = bind(hourWrapRef.current, hourRef.current, "hour");
    const u2 = bind(minuteWrapRef.current, minuteRef.current, "minute");
    return () => {
      u1();
      u2();
    };
  }, []);

  const startEdit = () => {
    setDraft(toHHMM(value));
    setInputError(null);
    setEditing(true);
  };

  const commit = () => {
    const m = parseTime(draft);
    if (m === null) {
      setInputError("时间格式不正确，如 19:30 或 1930");
      inputRef.current?.focus();
      return;
    }
    const normalized = normalize(m);
    const err = validateInput ? validateInput(normalized) : null;
    if (err) {
      setInputError(err);
      inputRef.current?.focus();
      return;
    }
    onChange(normalized);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setInputError(null);
  };

  if (editing) {
    return (
      <div className="flex h-[160px] flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setInputError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelEdit();
            }
          }}
          onBlur={commit}
          className={`w-full max-w-[160px] rounded-lg border bg-white px-3 py-2 text-center text-xl font-semibold outline-none transition-colors focus:ring-2 ${
            inputError
              ? "border-red-400 text-red-600 focus:border-red-400 focus:ring-red-100"
              : "border-slate-200 text-slate-900 focus:border-indigo-400 focus:ring-indigo-100"
          }`}
        />
        <p className="text-xs text-slate-400">直接输入，如 19:30 或 1930，回车确认</p>
        {inputError && (
          <p className="text-xs text-red-600" role="alert">
            {inputError}
          </p>
        )}
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
    const wrapRef = which === "hour" ? hourWrapRef : minuteWrapRef;
    const scrollerRef = which === "hour" ? hourRef : minuteRef;
    return (
      <div ref={wrapRef} onDoubleClick={startEdit} className="relative h-[160px]">
        <div
          ref={scrollerRef}
          onScroll={() => settle(which)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              step(which, -1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              step(which, 1);
            }
          }}
          tabIndex={0}
          role="listbox"
          aria-label={label}
          className="no-scrollbar h-full overflow-y-auto outline-none"
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

        {/* 中间高亮框 */}
        <div className="pointer-events-none absolute inset-x-0 top-16 flex h-8 items-center justify-center border-y border-indigo-200 bg-primary-soft">
          <span className="text-sm font-semibold text-indigo-700">{format(display)}</span>
        </div>

        {/* 点击上下渐隐区步进 */}
        <button
          type="button"
          aria-label={`${label}减一项`}
          onClick={() => step(which, -1)}
          className="absolute inset-x-0 top-0 h-8 cursor-pointer"
          style={{ background: "linear-gradient(to bottom, var(--color-card), transparent)" }}
        />
        <button
          type="button"
          aria-label={`${label}加一项`}
          onClick={() => step(which, 1)}
          className="absolute inset-x-0 bottom-0 h-8 cursor-pointer"
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
