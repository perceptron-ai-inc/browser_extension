import { DownloadIcon } from "./Icons";
import { downloadImage, toJpegDataUri } from "../image_utils";

interface PointingMessageProps {
  screenshot: string;
  target: string;
  pointX: number;
  pointY: number;
}

export function PointingMessage({ screenshot, target, pointX, pointY }: PointingMessageProps) {
  const handleDownload = () => {
    downloadImage(toJpegDataUri(screenshot), `pointing-${Date.now()}.jpg`, pointX, pointY);
  };

  return (
    <div class="message assistant">
      <div class="message-role vision">🎯 Pointing</div>
      <div class="message-content">
        <div>Finding: {target}</div>
        <div class="screenshot-container">
          <img src={toJpegDataUri(screenshot)} alt="Screenshot" />
          <div class="point-marker" style={{ left: `${pointX}%`, top: `${pointY}%` }} />
          <button class="download-btn" onClick={handleDownload}>
            <DownloadIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
