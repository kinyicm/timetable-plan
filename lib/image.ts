/**
 * 客户端图片压缩工具。
 *
 * 在把图片 POST 到识别接口之前先把「手机原图」压小，避免 base64 体积超过服务端上限
 * 而被 413 拒绝。所有浏览器 API（createImageBitmap / Image / canvas / FileReader）
 * 都只在函数被调用时访问，不会在模块加载阶段执行，因此可安全被客户端组件引用。
 */

/** 长边超过该值（px）时等比缩到该值。 */
const MAX_EDGE = 1600;
/** 原图长边未超限且体积不超过该值（字节）时，直接复用原文件，避免无谓重编码。 */
const MAX_ORIGINAL_BYTES = 1.5 * 1024 * 1024;
/** JPEG 输出质量。 */
const JPEG_QUALITY = 0.82;
const JPEG_MIME = "image/jpeg";

export interface CompressedImage {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

/** 把 Blob 读成 base64（去掉 data: 前缀，mimeType 由调用方单独保存）。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      } else {
        reject(new Error("读取图片失败"));
      }
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

type ImageSource = ImageBitmap | HTMLImageElement;

/** 读取图片尺寸与可绘制源：优先 createImageBitmap，失败回退 new Image() + ObjectURL。 */
async function loadImageSource(
  file: File,
): Promise<{ source: ImageSource; width: number; height: number; cleanup: () => void }> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  } catch {
    // 回退：某些环境不支持 createImageBitmap
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("读取图片失败"));
        el.src = url;
      });
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        cleanup: () => URL.revokeObjectURL(url),
      };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

export async function compressImage(file: File): Promise<CompressedImage> {
  const { source, width, height, cleanup } = await loadImageSource(file);
  try {
    const longEdge = Math.max(width, height);

    // 原图已足够小：直接读原文件，省去一次重编码（也保留原始格式）。
    if (longEdge <= MAX_EDGE && file.size <= MAX_ORIGINAL_BYTES) {
      const base64 = await blobToBase64(file);
      return { base64, mimeType: file.type || JPEG_MIME, width, height };
    }

    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("读取图片失败");
    ctx.drawImage(source, 0, 0, outWidth, outHeight);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("压缩失败"))),
        JPEG_MIME,
        JPEG_QUALITY,
      );
    });
    const base64 = await blobToBase64(blob);
    return { base64, mimeType: JPEG_MIME, width: outWidth, height: outHeight };
  } finally {
    cleanup();
  }
}
