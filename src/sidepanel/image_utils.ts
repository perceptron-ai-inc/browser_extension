import type { StatusUpdate } from "../types";

const JPEG_QUALITY = 0.85;
const JPEG_DATA_URI_PREFIX = "data:image/jpeg;base64,";
const BOX_COLOR = "#22c55e";
const POINT_COLOR = "#ef4444";
const BOX_COORD_SCALE = 1000;
const POINT_COORD_SCALE = 100;

type BoundingBox = NonNullable<StatusUpdate["boxes"]>[number];

export function toJpegDataUri(base64: string): string {
  return `${JPEG_DATA_URI_PREFIX}${base64}`;
}

function loadImageToCanvas(
  src: string,
  draw: (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => void,
): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      draw(ctx, img);
      resolve(canvas);
    };
    img.src = src;
  });
}

export async function drawBoxesOnImage(screenshot: string, boxes: BoundingBox[]): Promise<string> {
  if (!boxes || boxes.length === 0) {
    return screenshot;
  }

  const canvas = await loadImageToCanvas(toJpegDataUri(screenshot), (ctx, img) => {
    ctx.strokeStyle = BOX_COLOR;
    ctx.lineWidth = 2;
    ctx.font = "12px sans-serif";
    ctx.fillStyle = BOX_COLOR;

    for (const box of boxes) {
      const x1 = (box.x1 / BOX_COORD_SCALE) * img.width;
      const y1 = (box.y1 / BOX_COORD_SCALE) * img.height;
      const x2 = (box.x2 / BOX_COORD_SCALE) * img.width;
      const y2 = (box.y2 / BOX_COORD_SCALE) * img.height;

      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      if (box.label) {
        ctx.fillText(box.label, x1, y1 - 4);
      }
    }
  });

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY).replace(JPEG_DATA_URI_PREFIX, "");
}

export async function downloadImage(imgSrc: string, filename: string, pointX?: number, pointY?: number) {
  let href = imgSrc;

  if (pointX !== undefined && pointY !== undefined) {
    const canvas = await loadImageToCanvas(imgSrc, (ctx, img) => {
      const x = (pointX / POINT_COORD_SCALE) * img.width;
      const y = (pointY / POINT_COORD_SCALE) * img.height;

      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.strokeStyle = POINT_COLOR;
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = POINT_COLOR;
      ctx.fill();
    });
    href = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}
