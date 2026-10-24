import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { useLang } from "../lib/i18n";

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

/** In-app QR scanner: native BarcodeDetector when available, jsQR canvas decoding otherwise. */
export default function Scanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const { t } = useLang();
  const video = useRef<HTMLVideoElement>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = BD ? new BD({ formats: ["qr_code"] }) : null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const loop = async () => {
          if (stop) return;
          let text: string | null = null;
          try {
            if (detector) {
              text = (await detector.detect(v))[0]?.rawValue ?? null;
            } else if (ctx && v.videoWidth) {
              canvas.width = v.videoWidth;
              canvas.height = v.videoHeight;
              ctx.drawImage(v, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(img.data, img.width, img.height)?.data ?? null;
            }
          } catch {
            /* frame not ready */
          }
          if (text) onResult(text);
          else setTimeout(loop, 120);
        };
        void loop();
      } catch {
        setDenied(true);
      }
    })();

    return () => {
      stop = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onResult]);

  return (
    <div className="scanner">
      <video ref={video} playsInline muted />
      <div className="frame" />
      <div className="msg">{denied ? t("camDenied") : t("scanning")}</div>
      <button className="x" onClick={onClose}>
        {t("close")}
      </button>
    </div>
  );
}
