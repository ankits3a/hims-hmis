import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Point, Quad } from "../lib/doc-crop/geometry";

/**
 * THE CROP STEP — the photographed page with its four corners on it (owner, 2026-10-05: *"auto
 * detects the edges and crops the document. If any changes are required then the user can adjust
 * manually"*). Controlled: the screen owns the corners and the detection, this draws them and
 * moves them. A corner moves by finger, mouse or arrow keys; while a finger is on it a loupe shows
 * the photo under it, because the finger is exactly what hides the page's corner.
 */
export type CropStatus = "finding" | "found" | "none";

const ZOOM = 2.5;
const LOUPE = 96;

export function DocCrop({ src, width, height, quad, status, onQuad }: {
  src: string; width: number; height: number; quad: Quad; status: CropStatus; onQuad: (q: Quad) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const toImage = (clientX: number, clientY: number): Point | null => {
    const r = stage.current?.getBoundingClientRect();
    if (r === undefined || r.width === 0 || r.height === 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    return {
      x: Math.min(width, Math.max(0, ((clientX - r.left) / r.width) * width)),
      y: Math.min(height, Math.max(0, ((clientY - r.top) / r.height) * height)),
    };
  };
  const move = (i: number, p: Point): void => {
    const next = [...quad] as Quad;
    next[i] = p;
    onQuad(next);
  };
  const onKey = (i: number, e: React.KeyboardEvent): void => {
    const step = (e.shiftKey ? 0.02 : 0.005) * Math.max(width, height);
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[e.key];
    if (v === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const p = quad[i];
    if (p === undefined) return;
    move(i, { x: Math.min(width, Math.max(0, p.x + v[0])), y: Math.min(height, Math.max(0, p.y + v[1])) });
  };

  const pct = (p: Point): React.CSSProperties => ({ left: `${String((p.x / width) * 100)}%`, top: `${String((p.y / height) * 100)}%` });
  const pts = quad.map((p) => `${String(p.x)},${String(p.y)}`).join(" ");
  const names = [t("slipCapture.crop.tl"), t("slipCapture.crop.tr"), t("slipCapture.crop.br"), t("slipCapture.crop.bl")];
  const held = drag === null ? null : quad[drag];
  const box = stage.current?.getBoundingClientRect();

  return (
    <div className="sd-crop" data-testid="slip-crop" data-status={status}>
      <p className={`sd-crop-say ${status}`} role="status" data-testid="slip-crop-status">
        {status === "finding" ? t("slipCapture.crop.finding") : status === "found" ? t("slipCapture.crop.found") : t("slipCapture.crop.none")}
      </p>
      <div className="sd-crop-frame">
        <div
          className="sd-crop-stage" ref={stage} data-testid="slip-crop-stage"
          style={{ width: `min(100%, calc(min(62vh, 560px) * ${String(width)} / ${String(height)}))`, aspectRatio: `${String(width)} / ${String(height)}` }}
        >
          <img src={src} alt={t("slipCapture.previewAlt")} draggable={false} />
          <svg viewBox={`0 0 ${String(width)} ${String(height)}`} preserveAspectRatio="none" aria-hidden="true">
            <path
              className="shade" fillRule="evenodd"
              d={`M0,0H${String(width)}V${String(height)}H0Z M${pts.split(" ").join(" L")}Z`}
            />
            <polygon className="edge" points={pts} vectorEffect="non-scaling-stroke" />
          </svg>
          {quad.map((p, i) => (
            <button
              key={i} type="button" className="sd-crop-h" style={pct(p)} data-testid={`slip-crop-h${String(i)}`}
              aria-label={t("slipCapture.crop.handle", { corner: names[i] })} data-held={drag === i ? "true" : undefined}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                setDrag(i);
              }}
              onPointerMove={(e) => {
                if (drag !== i) return;
                const at = toImage(e.clientX, e.clientY);
                if (at !== null) move(i, at);
              }}
              onPointerUp={() => { setDrag(null); }}
              onPointerCancel={() => { setDrag(null); }}
              onKeyDown={(e) => { onKey(i, e); }}
            >
              <span aria-hidden="true" />
            </button>
          ))}
          {held !== null && held !== undefined && box !== undefined && box.width > 0 && (
            <div
              /* Above the finger, unless that would leave the frame — then below it. */
              className={`sd-crop-loupe${(held.y / height) * box.height < LOUPE + 64 ? " below" : ""}`}
              aria-hidden="true" data-testid="slip-crop-loupe"
              style={{
                ...pct(held),
                backgroundImage: `url(${src})`,
                backgroundSize: `${String(box.width * ZOOM)}px ${String(box.height * ZOOM)}px`,
                backgroundPosition: `${String(LOUPE / 2 - (held.x / width) * box.width * ZOOM)}px ${String(LOUPE / 2 - (held.y / height) * box.height * ZOOM)}px`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
