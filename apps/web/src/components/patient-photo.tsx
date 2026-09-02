import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * FD-7 T3 — LIFTED OUT OF THE REGISTRATION SCREEN, UNCHANGED.
 *
 * `patient-detail.tsx`, `opd-desk.tsx` and `patient-picker.tsx` all imported this from
 * `screens/registration-desk`, so three surfaces pulled a whole SCREEN — and its router hooks — into
 * their module graph to render one `<img>`. `billing-counter.test.tsx`'s header already names the
 * cost of that in as many words. Moving it is D5's precondition for the screen being renamed at all.
 */
export function PatientPhoto({ patientId, className }: { patientId: string; className: string }): React.ReactElement {
  const photo = useQuery({
    queryKey: ["patient-photo", patientId],
    queryFn: () => api<{ mimeType: string; imageBase64: string }>("GET", `/patients/${patientId}/photo`),
    retry: false,
  });
  if (!photo.data) return <div className={`${className} bg-neutral-100`} />;
  return <img alt="" className={`${className} object-cover`} src={`data:${photo.data.mimeType};base64,${photo.data.imageBase64}`} />;
}

