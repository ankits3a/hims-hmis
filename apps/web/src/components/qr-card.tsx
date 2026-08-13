import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export type QrCardData = { payload: string; uhid: string; name: string; sex: string; dob: string | null };

/** The printed patient card (§15: print is a first-class surface; every printed doc carries its signed QR). */
export function QrCard({ data }: { data: QrCardData }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="qr-card w-[340px] rounded-lg border p-4">
        <p className="text-xs text-neutral-500">{t("hospital.name")}</p>
        <div className="flex items-center gap-4 pt-2">
          <QRCodeSVG value={data.payload} size={112} />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{data.name}</p>
            <p className="font-mono text-base">{data.uhid}</p>
            <p className="text-sm text-neutral-600">
              {t("card.sex")}: {data.sex}
              {data.dob !== null ? ` · ${t("card.dob")}: ${data.dob.slice(0, 10)}` : ""}
            </p>
          </div>
        </div>
      </div>
      <Button type="button" className="no-print" onClick={() => window.print()}>
        {t("card.print")}
      </Button>
    </div>
  );
}
