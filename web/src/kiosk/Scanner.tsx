import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

interface Props {
  onCode: (text: string) => void;
  onCancel: () => void;
}

export function Scanner({ onCode, onCancel }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [error, setError] = useState("");

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      const el = video.current;
      if (stopped || !el || !context) return;
      if (el.readyState >= 2 && el.videoWidth > 0) {
        const scale = Math.min(1, 640 / el.videoWidth);
        canvas.width = Math.round(el.videoWidth * scale);
        canvas.height = Math.round(el.videoHeight * scale);
        context.drawImage(el, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(image.data, image.width, image.height);
        if (found?.data) {
          stopped = true;
          onCode(found.data);
          return;
        }
      }
      timer = window.setTimeout(tick, 120);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        tick();
      })
      .catch(() => setError("The camera is not available. Allow camera access and try again."));

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, onCode]);

  return (
    <section className="kiosk-panel">
      <h1>Scan your voter ID</h1>
      <p className="muted">Open Votify on your phone, show your voting code and hold it up to the camera.</p>
      {error ? (
        <p className="notice danger" role="alert">
          {error}
        </p>
      ) : (
        <video ref={video} className="scanner" playsInline muted />
      )}
      <button className="button" onClick={() => setFacing(facing === "user" ? "environment" : "user")}>
        Switch camera
      </button>
      <button className="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
