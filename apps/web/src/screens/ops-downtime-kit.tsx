import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import {
  DOWNTIME_FORM_KINDS, generateDowntimeKit, getKitPrintPayload, listDowntimeKits, opsErrorCode,
  opsErrorMessage,
} from "../lib/ops-api";
import type { DowntimeFormKind, DowntimeKitDeskInput, WireKitPrintPayload } from "../lib/ops-api";
import { FormKit, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * PLAN 11c T5 / D7-D9 — THE DOWNTIME KIT SCREEN: generate a reserved range of paper for the
 * outage in front of you, see what has already been issued, and print the sheets.
 *
 * THE PRINT CONVENTION (D8, `invoice-print.tsx`'s precedent, stated in this task's own brief):
 * the print view REPLACES this screen under `.print-doc` isolation — exactly one is ever mounted,
 * never a modal or a second pane beside the generator. Reached two ways: automatically after a
 * successful generation (a duty manager who just reserved paper wants it printed, not a second
 * click to find it) and from the "print" action on any row in the list below (a reprint of a kit
 * generated earlier, e.g. after the printer itself came back from being the thing that was down).
 */
const POLL_MS = 15_000;

const KNOWN_KIT_CODES = new Set(["downtime_kit_empty", "downtime_kit_duplicate_desk"]);

const deskSchema = z.object({
  desk: z.string().min(1),
  registration: z.string(),
  consultation: z.string(),
  receipt: z.string(),
});
const kitFormSchema = z.object({
  note: z.string().max(2000),
  desks: z.array(deskSchema).min(1),
});
type KitFormValues = z.infer<typeof kitFormSchema>;

function blankDesk(): z.infer<typeof deskSchema> {
  return { desk: "", registration: "", consultation: "", receipt: "" };
}

/** One printed sheet: the corner label and its signed QR (D9). */
function KitFormCard({ formKind, serial, qr }: { formKind: DowntimeFormKind; serial: number; qr: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid={`kit-form-${formKind}-${serial}`} className="flex items-center gap-2 rounded border p-2">
      <QRCodeSVG value={qr} size={64} />
      <span className="font-mono text-xs">
        {t(`opsKit.formKind.${formKind}`)} #{serial}
      </span>
    </div>
  );
}

/** The paper, rendered exactly as the printer sees it (D8). `.print-doc` isolation lives in `styles.css`. */
function DowntimeKitPrint({ data }: { data: WireKitPrintPayload }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="print-doc space-y-3 rounded-lg border p-4">
        <header className="space-y-1 border-b pb-2">
          <h2 className="text-lg font-bold">{t("opsKit.print.title")}</h2>
          <p data-testid="kit-print-id" className="font-mono text-xs text-neutral-600">{t("opsKit.print.kitId")}: {data.kitId}</p>
          {data.note !== null && data.note !== "" && <p className="text-xs text-neutral-600">{data.note}</p>}
        </header>
        {data.ranges.map((range) => (
          <section key={range.id} className="space-y-2 border-b pb-2 last:border-b-0">
            <h3 className="text-sm font-semibold">
              {range.desk} · {t(`opsKit.formKind.${range.formKind}`)}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {range.forms.map((form) => (
                <KitFormCard key={form.serial} formKind={form.formKind} serial={form.serial} qr={form.qr} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <Button type="button" className="no-print" onClick={() => window.print()}>
        {t("opsKit.print.print")}
      </Button>
    </div>
  );
}

export function OpsDowntimeKit(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [printKitId, setPrintKitId] = useState<string | null>(null);

  const kits = useQuery({ queryKey: ["ops", "downtime-kits"], queryFn: listDowntimeKits, refetchInterval: POLL_MS });
  const printPayload = useQuery({
    queryKey: ["ops", "downtime-kits", "print", printKitId ?? ""],
    queryFn: () => getKitPrintPayload(printKitId ?? ""),
    enabled: printKitId !== null,
  });

  const form = useForm<KitFormValues>({
    resolver: zodResolver(kitFormSchema),
    defaultValues: { note: "", desks: [blankDesk()] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "desks" });

  // ——— the printable kit REPLACES this screen (exactly one `.print-doc` is ever mounted) ———
  if (printKitId !== null) {
    return (
      <div className="space-y-4 p-6">
        <div className="no-print">
          <Button type="button" variant="outline" onClick={() => setPrintKitId(null)}>
            {t("opsKit.print.back")}
          </Button>
        </div>
        {printPayload.data !== undefined && <DowntimeKitPrint data={printPayload.data} />}
      </div>
    );
  }

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    const desks: DowntimeKitDeskInput[] = v.desks.map((d) => {
      const counts: Partial<Record<DowntimeFormKind, number>> = {};
      for (const kind of DOWNTIME_FORM_KINDS) {
        const raw = d[kind].trim();
        const n = raw === "" ? 0 : Number(raw);
        if (Number.isFinite(n) && n > 0) counts[kind] = n;
      }
      return { desk: d.desk, counts };
    });
    try {
      const result = await generateDowntimeKit({ note: v.note.trim() === "" ? null : v.note.trim(), desks });
      form.reset({ note: "", desks: [blankDesk()] });
      await qc.invalidateQueries({ queryKey: ["ops", "downtime-kits"] });
      setPrintKitId(result.id);
    } catch (e) {
      setError({ code: opsErrorCode(e), message: opsErrorMessage(e) });
    }
  });

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t("opsKit.title")}</h1>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("opsKit.generate.title")}</h2>
        <FormProvider {...form}>
          <FormKit onSubmit={submit} className="max-w-2xl">
            {fields.map((f, i) => (
              <div key={f.id} className="flex flex-wrap items-end gap-2 border-b pb-2">
                <TextField name={`desks.${i}.desk`} label={t("opsKit.generate.desk")} />
                <TextField name={`desks.${i}.registration`} label={t("opsKit.formKind.registration")} type="number" />
                <TextField name={`desks.${i}.consultation`} label={t("opsKit.formKind.consultation")} type="number" />
                <TextField name={`desks.${i}.receipt`} label={t("opsKit.formKind.receipt")} type="number" />
                {fields.length > 1 && (
                  <Button type="button" size="sm" variant="outline" onClick={() => remove(i)}>
                    {t("opsKit.generate.removeDesk")}
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => append(blankDesk())}>
              {t("opsKit.generate.addDesk")}
            </Button>
            <div>
              <label className="block text-sm font-medium" htmlFor="f-kit-note">{t("opsKit.generate.note")}</label>
              <textarea id="f-kit-note" data-field className="w-full rounded border px-2 py-1" rows={2} {...form.register("note")} />
            </div>
            {error !== null && (
              <p role="alert" data-testid="kit-generate-error" data-code={error.code ?? ""} className="text-sm text-red-600">
                {error.code !== null && KNOWN_KIT_CODES.has(error.code) ? t(`opsKit.error.${error.code}`) : error.message}
              </p>
            )}
            <Button type="submit">{t("opsKit.generate.submit")}</Button>
          </FormKit>
        </FormProvider>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("opsKit.list.title")}</h2>
        {(kits.data?.kits.length ?? 0) === 0 ? (
          <p data-testid="kit-list-empty" className="text-sm text-neutral-500">{t("opsKit.list.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("opsKit.list.note")}</TableHead>
                <TableHead>{t("opsKit.list.generatedAt")}</TableHead>
                <TableHead>{t("opsKit.list.totalForms")}</TableHead>
                <TableHead>{t("opsKit.list.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(kits.data?.kits ?? []).map((kit) => (
                <TableRow key={kit.id} data-testid={`kit-row-${kit.id}`}>
                  <TableCell>{kit.note ?? "—"}</TableCell>
                  <TableCell>{kit.generatedAt}</TableCell>
                  <TableCell className="tabular-nums">{kit.totalForms}</TableCell>
                  <TableCell>
                    <Button type="button" size="sm" variant="outline" onClick={() => setPrintKitId(kit.id)}>
                      {t("opsKit.list.print")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
