/**
 * A QR code drawn from rows the SERVER encoded ('1' is a dark module) — `kernel/printing/qr.ts`, the
 * encoder the prescription sheet's own code comes from. Inline SVG: no library, no image, no fetch.
 * The two quiet modules on every side are what a phone camera needs to find the square.
 */
export function QrRows({ rows, size, label, testId = "qr-rows" }: { rows: readonly string[]; size: number; label: string; testId?: string }): React.ReactElement {
  const quiet = 2;
  const n = rows.length + quiet * 2;
  let d = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "1") { x += 1; continue; }
      let run = 1;
      while (row[x + run] === "1") run += 1;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return (
    <svg role="img" aria-label={label} data-testid={testId} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 4, flexShrink: 0 }}>
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
