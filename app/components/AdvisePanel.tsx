"use client";

export type AdviseOption = {
  id: "A" | "B" | "C";
  name: string;
  strategy: "daily" | "weekly" | "sprint";
  summary: string;
  sessionsPerWeek: number;
  avgSessionMin: number;
  totalHours: number;
  pros: string[];
  cons: string[];
  risk: string;
};

export type AdviseResult = {
  feasibility: {
    verdict: "可行" | "紧张" | "不可行";
    requiredHours: number;
    supplyHours: number;
    gapHours: number;
    note: string;
  };
  options: AdviseOption[];
  recommendation: "A" | "B" | "C";
  recommendReason: string;
};

const STRATEGY_LABEL: Record<AdviseOption["strategy"], string> = {
  daily: "分散式",
  weekly: "集中式",
  sprint: "冲刺式",
};

const VERDICT_BAR: Record<AdviseResult["feasibility"]["verdict"], string> = {
  可行: "border-emerald-200 bg-emerald-50 text-emerald-800",
  紧张: "border-amber-200 bg-amber-50 text-amber-800",
  不可行: "border-red-200 bg-red-50 text-red-800",
};

const VERDICT_DOT: Record<AdviseResult["feasibility"]["verdict"], string> = {
  可行: "bg-emerald-500",
  紧张: "bg-amber-500",
  不可行: "bg-red-500",
};

type AdvisePanelProps = {
  goalTitle: string;
  advise: AdviseResult;
  onPick: (option: AdviseOption) => void;
  onReanalyze: () => void;
  onClose: () => void;
};

export default function AdvisePanel({ goalTitle, advise, onPick, onReanalyze, onClose }: AdvisePanelProps) {
  const f = advise.feasibility;
  const recommendedId = advise.recommendation;
  const gapText =
    f.gapHours < 0 ? `缺口 ${f.gapHours} 小时` : f.gapHours > 0 ? `富余 ${f.gapHours} 小时` : "时间刚好";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{goalTitle}</h2>
            <p className="mt-0.5 text-xs text-slate-500">选择一个执行方案，再生成具体安排</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {/* 可行性判断条 */}
          <div className={`mb-4 rounded-lg border px-4 py-3 ${VERDICT_BAR[f.verdict]}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5 font-semibold">
                <span className={`h-2 w-2 rounded-full ${VERDICT_DOT[f.verdict]}`} />
                {f.verdict}
              </span>
              <span className="text-sm">
                可用 {f.supplyHours} 小时 / 需要 {f.requiredHours} 小时 / {gapText}
              </span>
            </div>
            <p className="mt-1 text-xs opacity-80">{f.note}</p>
          </div>

          {/* 候选方案卡片 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {advise.options.map((o) => {
              const isRecommended = o.id === recommendedId;
              return (
                <div
                  key={o.id}
                  className={`relative flex flex-col rounded-lg border p-3 ${
                    isRecommended
                      ? "border-indigo-400 bg-indigo-50/40 ring-1 ring-indigo-200"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  {isRecommended && (
                    <span className="absolute -top-2 right-3 rounded bg-indigo-600 px-1.5 py-0.5 text-[11px] font-medium text-white shadow">
                      推荐
                    </span>
                  )}

                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-900">{o.name}</span>
                    <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">
                      {STRATEGY_LABEL[o.strategy]}
                    </span>
                  </div>

                  <p className="mt-1.5 min-h-[2.5rem] text-xs leading-relaxed text-slate-600">
                    {o.summary}
                  </p>

                  <div className="mt-2 space-y-0.5 text-xs text-slate-600">
                    <div>
                      每周 {o.sessionsPerWeek} 次 · 每次 {o.avgSessionMin} 分钟
                    </div>
                    <div>合计约 {o.totalHours} 小时</div>
                  </div>

                  {o.pros.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-emerald-700">
                      {o.pros.map((p, i) => (
                        <li key={i} className="flex gap-1">
                          <span className="shrink-0">✓</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {o.cons.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                      {o.cons.map((c, i) => (
                        <li key={i} className="flex gap-1">
                          <span className="shrink-0">−</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {o.risk && <p className="mt-1.5 text-[11px] text-amber-600">⚠ {o.risk}</p>}

                  <div className="mt-auto pt-3">
                    <button
                      type="button"
                      onClick={() => onPick(o)}
                      className={`w-full cursor-pointer rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                        isRecommended
                          ? "bg-indigo-600 text-white hover:bg-indigo-700"
                          : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      用这个方案
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {advise.recommendReason && (
            <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 text-xs leading-relaxed text-slate-600">
              {advise.recommendReason}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button
            type="button"
            onClick={onReanalyze}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
          >
            重新分析
          </button>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
          >
            取消
          </button>
        </footer>
      </div>
    </div>
  );
}
