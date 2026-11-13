"use client";

import { useState } from "react";
import type { KnowledgePoint } from "@/lib/types";

type SyllabusSource = "outline-provided" | "ai-generated";

/** 行背景按难度微调：基础=白、进阶=淡蓝、难点=淡琥珀。 */
const DIFFICULTY_BG: Record<KnowledgePoint["difficulty"], string> = {
  基础: "bg-white",
  进阶: "bg-blue-50",
  难点: "bg-amber-50",
};

const DIFFICULTIES: KnowledgePoint["difficulty"][] = ["基础", "进阶", "难点"];

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `kp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type SyllabusPanelProps = {
  subject: string;
  points: KnowledgePoint[];
  source: SyllabusSource;
  /** 用于「粘贴教材目录 → 重新生成」时作为目标标题回传。 */
  goalTitle: string;
  onNext: (selected: KnowledgePoint[]) => void;
  onClose: () => void;
};

export default function SyllabusPanel({
  subject: initialSubject,
  points: initialPoints,
  source: initialSource,
  goalTitle,
  onNext,
  onClose,
}: SyllabusPanelProps) {
  const [subject, setSubject] = useState(initialSubject);
  const [source, setSource] = useState<SyllabusSource>(initialSource);
  const [items, setItems] = useState<KnowledgePoint[]>(initialPoints);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialPoints.map((p) => p.id)),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [syllabusText, setSyllabusText] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState("");

  const totalMinutes = items.reduce((s, p) => s + p.estimatedMinutes, 0);
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const allSelected = items.length > 0 && selectedIds.size === items.length;
  // 已选中且有名称的知识点，作为「下一步」是否可用的依据。
  const validSelected = items.filter((p) => selectedIds.has(p.id) && p.name.trim());

  const update = (id: string, patch: Partial<KnowledgePoint>) => {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((p) => p.id)));
  };

  const remove = (id: string) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addPoint = () => {
    const p: KnowledgePoint = {
      id: genId(),
      name: "",
      category: "",
      difficulty: "基础",
      estimatedMinutes: 60,
      order: items.length + 1,
    };
    setItems((prev) => [...prev, p]);
    setSelectedIds((prev) => new Set(prev).add(p.id));
    setEditingId(p.id);
    setEditDraft("");
  };

  const commitName = (id: string) => {
    const t = editDraft.trim();
    if (t) update(id, { name: t });
    setEditingId(null);
  };

  const handleNext = () => {
    if (validSelected.length === 0) return;
    // 提交前按当前展示顺序重排 order 为 1..n，保证依赖顺序一致。
    onNext(validSelected.map((p, i) => ({ ...p, order: i + 1 })));
  };

  const handleRegenerate = async () => {
    const text = syllabusText.trim();
    if (!text) {
      setRegenerateError("请先粘贴教材目录或考纲内容");
      return;
    }
    setRegenerating(true);
    setRegenerateError("");
    try {
      const resp = await fetch("/api/syllabus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: { title: goalTitle, deadline: "", hoursPerWeek: 10 },
          syllabusText: text,
        }),
      });
      const json = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        subject?: string;
        points?: unknown;
        source?: SyllabusSource;
      };
      if (!json.ok) {
        setRegenerateError(json.error ?? "重新生成失败，请稍后重试");
        return;
      }
      const newPoints = (Array.isArray(json.points) ? json.points : []) as KnowledgePoint[];
      setSubject(typeof json.subject === "string" && json.subject.trim() ? json.subject : subject);
      setSource(json.source === "outline-provided" ? "outline-provided" : "ai-generated");
      setItems(newPoints);
      setSelectedIds(new Set(newPoints.map((p) => p.id)));
      setShowPaste(false);
      setSyllabusText("");
    } catch {
      setRegenerateError("重新生成失败，请检查网络后重试");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">{subject} 的知识点大纲</h2>
              <p className="mt-1 text-sm text-slate-600">
                共 {items.length} 个知识点 · 预估 {totalHours} 小时
              </p>
              {source === "ai-generated" ? (
                <p className="mt-1 text-xs text-slate-400">
                  AI 按主流教材生成，可能与本校教学进度不同，请核对
                </p>
              ) : (
                <p className="mt-1 text-xs text-emerald-600">依据你提供的目录生成</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPaste((v) => !v)}
                className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50"
              >
                粘贴教材目录
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                ×
              </button>
            </div>
          </div>

          {showPaste && (
            <div className="mt-3 space-y-2">
              <textarea
                value={syllabusText}
                onChange={(e) => setSyllabusText(e.target.value)}
                placeholder="粘贴教材目录或考纲，将按它重新拆分知识点"
                rows={4}
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              {regenerateError && <p className="text-xs text-red-600">{regenerateError}</p>}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleRegenerate}
                  disabled={regenerating}
                  className="cursor-pointer rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {regenerating ? "生成中…" : "重新生成"}
                </button>
              </div>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3" style={{ maxHeight: "60vh" }}>
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">暂无知识点</p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((p) => (
                <li
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 ${DIFFICULTY_BG[p.difficulty]}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
                  />
                  {editingId === p.id ? (
                    <input
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) commitName(p.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => commitName(p.id)}
                      autoFocus
                      placeholder="知识点名称"
                      className="h-7 min-w-0 flex-1 rounded border border-indigo-300 bg-white px-2 text-sm text-slate-900 outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(p.id);
                        setEditDraft(p.name);
                      }}
                      title={p.name || "点击编辑名称"}
                      className="min-w-0 flex-1 cursor-text truncate text-left text-sm text-slate-800"
                    >
                      {p.name || "点击编辑名称"}
                    </button>
                  )}
                  <select
                    value={p.difficulty}
                    onChange={(e) =>
                      update(p.id, { difficulty: e.target.value as KnowledgePoint["difficulty"] })
                    }
                    className="h-7 shrink-0 rounded border border-slate-200 bg-white px-1 text-xs text-slate-700 outline-none"
                  >
                    {DIFFICULTIES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <div className="flex shrink-0 items-center gap-1">
                    <input
                      type="number"
                      value={p.estimatedMinutes}
                      min={15}
                      max={480}
                      step={15}
                      onChange={(e) => {
                        const v = Math.round(Number(e.target.value));
                        if (Number.isFinite(v)) {
                          update(p.id, { estimatedMinutes: Math.min(480, Math.max(15, v)) });
                        }
                      }}
                      className="h-7 w-16 rounded border border-slate-200 bg-white px-1 text-right text-xs text-slate-700 outline-none"
                    />
                    <span className="text-xs text-slate-400">分</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(p.id)}
                    aria-label="删除"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 px-5 py-3">
          <button
            type="button"
            onClick={addPoint}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
          >
            + 添加知识点
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAll}
              className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            >
              {allSelected ? "全不选" : "全选"}
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={validSelected.length === 0}
              className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              下一步：选方案
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
