import { useState, useEffect } from "preact/hooks";
import type { StatusUpdate } from "../../types";
import { DownloadIcon } from "./Icons";
import { drawBoxesOnImage, downloadImage, toJpegDataUri } from "../image_utils";

type BoundingBox = NonNullable<StatusUpdate["boxes"]>[number];

interface VisionMessageProps {
  screenshot: string;
  description: string;
  boxes?: BoundingBox[];
}

export function VisionMessage({ screenshot, description, boxes }: VisionMessageProps) {
  const [annotatedScreenshot, setAnnotatedScreenshot] = useState(screenshot);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (boxes && boxes.length > 0) {
      drawBoxesOnImage(screenshot, boxes).then(setAnnotatedScreenshot);
    }
  }, [screenshot, boxes]);

  const handleDownload = () => {
    downloadImage(toJpegDataUri(annotatedScreenshot), `vision-${Date.now()}.jpg`);
  };

  return (
    <div class="message assistant">
      <div class="message-role vision">
        👁️ Vision
        {boxes && boxes.length > 0 ? ` (${boxes.length} elements)` : ""}
      </div>
      <div class="message-content">
        <div class="screenshot-wrapper">
          <img src={toJpegDataUri(annotatedScreenshot)} class="message-screenshot" alt="Screenshot" />
          <button class="download-btn" onClick={handleDownload}>
            <DownloadIcon />
          </button>
        </div>
        <div class="message-expander">
          <div class={`expander-header ${expanded ? "expanded" : ""}`} onClick={() => setExpanded(!expanded)}>
            <span class="expander-icon">▶</span>
            <span>View page description</span>
          </div>
          <div class="expander-content">{description}</div>
        </div>
      </div>
    </div>
  );
}
