import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

const TARGET_W = 480;
const TARGET_H = 640;
const MAX_BYTES = 500_000;

async function canvasToCappedJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const quality of [0.8, 0.6, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob !== null && blob.size <= MAX_BYTES) return blob;
  }
  return null;
}

async function fileToCappedJpeg(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, TARGET_H / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasToCappedJpeg(canvas);
}

export function PhotoCapture({ onCapture }: { onCapture: (blob: Blob | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<"idle" | "streaming" | "captured" | "unavailable">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const cameraPossible = typeof navigator !== "undefined" && navigator.mediaDevices !== undefined;

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: TARGET_W, height: TARGET_H },
      });
      streamRef.current = stream;
      videoRef.current!.srcObject = stream;
      await videoRef.current!.play();
      setMode("streaming");
    } catch {
      setMode("unavailable"); // permission denied / no camera — the fallback input below stays usable
    }
  };

  const capture = async (): Promise<void> => {
    const video = videoRef.current!;
    const canvas = document.createElement("canvas");
    canvas.width = TARGET_W;
    canvas.height = TARGET_H;
    canvas.getContext("2d")!.drawImage(video, 0, 0, TARGET_W, TARGET_H);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    const blob = await canvasToCappedJpeg(canvas);
    finish(blob);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    finish(await fileToCappedJpeg(file));
  };

  const finish = (blob: Blob | null): void => {
    if (blob === null) return;
    setPreviewUrl(URL.createObjectURL(blob));
    setMode("captured");
    onCapture(blob);
  };

  const retake = (): void => {
    setPreviewUrl(null);
    setMode("idle");
    onCapture(null);
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("photo.title")}</p>
      {mode === "streaming" && (
        <video ref={videoRef} className="h-48 w-36 rounded border object-cover" muted playsInline />
      )}
      {mode === "captured" && previewUrl !== null && (
        <img src={previewUrl} alt="" className="h-48 w-36 rounded border object-cover" />
      )}
      {mode === "unavailable" && <p className="text-sm text-amber-700">{t("photo.unavailable")}</p>}
      <div className="flex gap-2">
        {cameraPossible && mode === "idle" && (
          <Button type="button" variant="outline" onClick={() => void start()}>{t("photo.start")}</Button>
        )}
        {mode === "streaming" && (
          <Button type="button" onClick={() => void capture()}>{t("photo.capture")}</Button>
        )}
        {mode === "captured" && (
          <Button type="button" variant="outline" onClick={retake}>{t("photo.retake")}</Button>
        )}
        {mode !== "streaming" && mode !== "captured" && (
          <label className="cursor-pointer rounded border px-3 py-1.5 text-sm">
            {t("photo.fallback")}
            <input type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => void onFile(e)} />
          </label>
        )}
      </div>
    </div>
  );
}
