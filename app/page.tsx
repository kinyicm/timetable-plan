"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

type Preview = { name: string; size: number; url: string };

type Cell = { r: number; c: number; text: string };
type RecognitionData = { rowCount: number; colCount: number; cells: Cell[] };
type Status = "idle" | "loading" | "success" | "error";

/** 长边压缩上限：兼顾视觉模型识别精度与 Vercel 4.5MB 请求体上限。 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * 压缩图片：长边不超过 MAX_EDGE、保持宽高比，导出 JPEG blob。
 * 返回压缩后的 blob 与 mimeType（用于请求体与 data URL 前缀）。
 */
async function compressImage(blob: Blob): Promise<{ blob: Blob; mimeType: string }> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!jpeg) throw new Error("图片压缩失败");
  return { blob: jpeg, mimeType: "image/jpeg" };
}

/** 把 blob 转成去除 data: 前缀的 base64 字符串。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-3.5-3.5a2 2 0 0 0-2.83 0L6 20" />
    </svg>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-card shadow-sm">
      <h2 className="px-6 pt-5 text-base font-semibold text-slate-800">
        {title}
      </h2>
      <div className="flex flex-1 flex-col px-6 pb-4 pt-4">{children}</div>
    </section>
  );
}

export default function Home() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 识别结果状态
  const [status, setStatus] = useState<Status>("idle");
  const [recogError, setRecogError] = useState<string | null>(null);
  const [recogData, setRecogData] = useState<RecognitionData | null>(null);
  const [recogMs, setRecogMs] = useState<number | null>(null);
  const [recogModel, setRecogModel] = useState<string | null>(null);

  const objectUrlRef = useRef<string | null>(null);
  // 最近一次触发识别的 File，供「重试」使用
  const lastFileRef = useRef<Blob | null>(null);
  // 自增 id：识别是异步的，选新图时递增，用来丢弃上一个请求的过期回包
  const runIdRef = useRef(0);

  // 全局拦截拖拽文件的浏览器默认行为：
  // 避免在非拖拽区松开时浏览器直接打开/跳转到该文件
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // 卸载时释放曾创建的对象 URL，避免内存泄漏
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  // 压缩图片 + 自动调用 /api/recognize。用 runId 丢弃过期回包（选新图时旧请求作废）。
  const recognizeFile = useCallback(async (file: Blob) => {
    lastFileRef.current = file;
    const id = ++runIdRef.current;
    setStatus("loading");
    setRecogError(null);
    setRecogData(null);
    setRecogMs(null);
    setRecogModel(null);

    try {
      // 压缩（并把压缩前后体积打到 console 便于验证）
      const { blob, mimeType } = await compressImage(file);
      if (runIdRef.current !== id) return;
      console.log(
        `[compress] 原始 ${formatSize(file.size)} -> 压缩后 ${formatSize(blob.size)}`,
      );
      const b64 = await blobToBase64(blob);
      if (runIdRef.current !== id) return;

      const res = await fetch("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: b64, mimeType }),
      });
      const payload = await res.json().catch(() => null);
      if (runIdRef.current !== id) return;

      if (payload?.ok) {
        setRecogData(payload.data);
        setRecogMs(typeof payload.durationMs === "number" ? payload.durationMs : null);
        setRecogModel(typeof payload.model === "string" ? payload.model : null);
        setStatus("success");
        // 完整 JSON 打到 console，表格渲染留到 M4
        console.log("[recognize]", JSON.stringify(payload.data, null, 2));
      } else {
        setRecogError(payload?.error ?? `识别失败（HTTP ${res.status}）`);
        setStatus("error");
      }
    } catch (e) {
      if (runIdRef.current !== id) return;
      setRecogError(e instanceof Error ? e.message : "识别失败，请稍后重试");
      setStatus("error");
    }
  }, []);

  const retryRecognition = () => {
    if (lastFileRef.current) recognizeFile(lastFileRef.current);
  };

  const acceptFile = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("仅支持图片文件（JPG / PNG / WebP）");
        return;
      }
      if (file.size > MAX_SIZE) {
        setError("文件超过 10MB，请选择更小的图片");
        return;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setPreview({ name: file.name, size: file.size, url });
      setError(null);
      // 选好图即自动压缩 + 识别，不需要额外按钮
      recognizeFile(file);
    },
    [recognizeFile],
  );

  const handleAlbumChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
    // 清空 value，允许重复选择同一张图
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    acceptFile(e.dataTransfer.files?.[0]);
  };

  // 触发器的入口都换成 <label htmlFor>，用原生关联调起 file picker
  // （对 display:none 的 input 做 JS .click() 会被 iOS Safari 等拦截）。
  // 单独加强 role="button" 的 label 在 Chrome/Safari 下的键盘支持：
  // 聚焦后按 Enter/Space 时模拟点击 label，从而沿原生关联调起 input。
  const handleLabelKey = (e: React.KeyboardEvent<HTMLLabelElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.currentTarget.click();
    }
  };

  return (
    <main className="flex flex-1 flex-col justify-center py-10">
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-10">
        <header className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            表格快照 · TableSnap
          </h1>
          <p className="mt-2 max-w-2xl text-slate-500">
            把表格图片拖进来，变成能编辑的表格；我认不准的格子会标出来
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-2">
          {/* 左栏：上传与预览 */}
          <Card title="上传与预览">
            {/* 两个 <input> 是功能元素，始终渲染，不受断点显隐控制：
                拍照 -> capture="environment"（不经 getUserMedia，LAN/HTTP
                下安全上下文不可用，改由浏览器调用系统相机）；
                相册/选择文件 -> 普通 file input。 */}
            <input
              id="camera-input"
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={handleAlbumChange}
            />
            <input
              id="album-input"
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={handleAlbumChange}
            />

            {preview ? (
              <div className="flex min-h-[360px] flex-1 flex-col">
                <div className="mb-3 flex items-center justify-between gap-3 text-sm text-slate-500">
                  <span className="truncate">
                    {preview.name}（{formatSize(preview.size)}）
                  </span>
                  <label
                    htmlFor="album-input"
                    role="button"
                    tabIndex={0}
                    onKeyDown={handleLabelKey}
                    className="shrink-0 cursor-pointer font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    重新选择
                  </label>
                </div>
                <div className="flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-line bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview.url}
                    alt={preview.name}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              </div>
            ) : (
              <>
                {/* 布局形态与交互入口统一由 CSS 断点决定（与 md:grid-cols-2
                    同一个 md: 断点），不再用 JS 重复判断，避免两套信号来源不一致。
                    两套上传入口都渲染，靠响应式类在同一视口宽度下互斥显隐。 */}

                {/* 手机端：<768px 显示（flex md:hidden）。触摸目标均 >= 44x44px */}
                <div className="flex min-h-[360px] w-full flex-1 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-8 text-center md:hidden">
                  <ImageIcon className="h-9 w-9 text-slate-400" />
                  <p className="mt-1 text-base font-medium text-slate-700">
                    从手机上传表格图片
                  </p>
                  <p className="text-sm text-slate-400">
                    支持 JPG / PNG / WebP，单个文件不超过 10MB
                  </p>
                  <div className="mt-4 flex w-full max-w-xs flex-col gap-3">
                    <label
                      htmlFor="camera-input"
                      role="button"
                      tabIndex={0}
                      onKeyDown={handleLabelKey}
                      className="flex h-12 min-h-12 w-full cursor-pointer items-center justify-center rounded-md bg-primary text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      拍照
                    </label>
                    <label
                      htmlFor="album-input"
                      role="button"
                      tabIndex={0}
                      onKeyDown={handleLabelKey}
                      className="flex h-12 min-h-12 w-full cursor-pointer items-center justify-center rounded-md border border-line bg-white text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      从相册选择
                    </label>
                  </div>
                </div>

                {/* 电脑端：>=768px 显示（hidden md:flex）。虚线拖拽区 + 选择文件 */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  className="group hidden min-h-[360px] w-full flex-1 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-8 text-center transition-colors hover:border-primary hover:bg-primary-soft md:flex"
                >
                  <ImageIcon
                    className={`h-9 w-9 ${
                      dragging
                        ? "text-primary"
                        : "text-slate-400 group-hover:text-primary"
                    }`}
                  />
                  <p className="mt-1 text-base font-medium text-slate-700">
                    把表格图片拖到这里
                  </p>
                  <p className="text-sm text-slate-400">
                    支持 JPG / PNG / WebP，单个文件不超过 10MB
                  </p>
                  <label
                    htmlFor="album-input"
                    role="button"
                    tabIndex={0}
                    onKeyDown={handleLabelKey}
                    className="mt-2 inline-flex h-11 cursor-pointer items-center rounded-md border border-line bg-white px-5 text-sm font-medium text-slate-700 transition-colors group-hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    选择文件
                  </label>
                </div>
              </>
            )}

            {error && (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </Card>

          {/* 右栏：识别结果 */}
          <Card title="识别结果">
            <div className="flex min-h-[360px] flex-1 flex-col">
              <div className="flex flex-1 flex-col gap-3">
                {status === "idle" && (
                  <>
                    {/* 效果图预览 */}
                    <div className="flex flex-1 flex-col">
                      <h3 className="text-sm font-semibold text-slate-700">
                        效果图预览
                      </h3>
                      <div className="mt-2 flex flex-1 items-center justify-center rounded-lg border border-line bg-white text-sm text-slate-400">
                        上传图片后，表格会出现在这里
                      </div>
                    </div>

                    {/* 下载（禁用态） */}
                    <div className="mt-5">
                      <h3 className="text-sm font-semibold text-slate-700">下载</h3>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          disabled
                          title="需先完成识别"
                          className="h-11 w-full cursor-not-allowed rounded-md border border-line bg-slate-50 px-3 text-sm font-medium text-slate-500 opacity-60"
                        >
                          下载效果图（PNG）
                        </button>
                        <button
                          type="button"
                          disabled
                          title="需先完成识别"
                          className="h-11 w-full cursor-not-allowed rounded-md border border-line bg-slate-50 px-3 text-sm font-medium text-slate-500 opacity-60"
                        >
                          下载表格（CSV）
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {status === "loading" && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-line bg-white text-sm text-slate-500">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      aria-hidden="true"
                      className="h-8 w-8 animate-spin text-slate-300"
                    >
                      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                    </svg>
                    <p>正在识别表格，请稍候…</p>
                  </div>
                )}

                {status === "error" && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-line bg-white p-6 text-center">
                    <p className="text-sm text-red-600" role="alert">
                      {recogError}
                    </p>
                    <button
                      type="button"
                      onClick={retryRecognition}
                      className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      重试
                    </button>
                  </div>
                )}

                {status === "success" && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-line bg-white p-6 text-center">
                    <p className="text-base font-semibold text-slate-800">
                      识别成功：{recogData?.rowCount} 行 × {recogData?.colCount} 列
                    </p>
                    <p className="text-xs text-slate-400">
                      耗时 {recogMs != null ? `${recogMs}ms` : "—"}
                      {recogModel ? ` · ${recogModel}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      表格渲染将在后续版本提供
                    </p>
                  </div>
                )}
              </div>

              {/* 三色图例（说明） */}
              <footer className="mt-6 space-y-2 border-t border-line pt-4">
                <LegendItem
                  color="bg-emerald-500"
                  text="三次识别结果一致，可直接采用"
                />
                <LegendItem
                  color="bg-amber-400"
                  text="三次识别不一致，请确认"
                />
                <LegendItem color="bg-red-500" text="三次全不同，必须确认" />
              </footer>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}

function LegendItem({ color, text }: { color: string; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />
      <span>{text}</span>
    </div>
  );
}