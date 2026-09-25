import { useEffect, useRef } from "react";

/** The right-hand sheet both flows use. Esc closes it; focus starts inside it. */
export function Sheet({ title, onClose, children, testId, onKey }: {
  title: string; onClose: () => void; children: React.ReactNode; testId: string; onKey?: (e: React.KeyboardEvent) => void;
}): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
        className="h-full w-full max-w-4xl overflow-y-auto bg-background p-4 shadow-xl focus:outline-none"
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); return; } onKey?.(e); }}
      >
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1 text-lg font-semibold">{title}</h2>
          <button type="button" className="text-sm text-muted-foreground" onClick={onClose}>{`Esc`}</button>
        </div>
        {children}
      </aside>
    </div>
  );
}
