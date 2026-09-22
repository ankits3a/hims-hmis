import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  attestSubstance, fetchSaltsPage, fetchWorklistPage, formularyErrorMessage, ruleSubstanceUnmappable,
} from "../lib/formulary-api";
import { Button } from "@/components/ui/button";
import type {
  AttestTarget, WireDraft, WireMappingDecision, WireSubstanceStatus, WireWorklistItem,
} from "../lib/formulary-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MAPPING WORKLIST — A DRAFTER PROPOSES, THE PHARMACIST ATTESTS, ONE SUBSTANCE AT A TIME
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling R1, 2026-09-16 (`docs/superpowers/plans/2026-09-16-phase2-formulary-mapping-loop.md`).
 * The national release names 3,283 substances; the checks need moieties. The system drafts which
 * moiety each substance is. The hospital's pharmacist decides, here.
 *
 * ═══ THE RISK OF THIS SCREEN IS A RUBBER STAMP, AND FOUR THINGS STAND AGAINST IT ═══
 *
 *   1. NO BULK ACT. Every button acts on ONE substance. There is no "accept all", no checkbox
 *      column, and the API client has no plural form to call.
 *   2. NOTHING IS PRE-SELECTED. A draft is a button the pharmacist presses, never a default a
 *      "save" would carry.
 *   3. THE BASIS IS VISIBLE. "The release states it" and "a model drafted it" look different, and a
 *      model's draft carries its rationale and the word *verify*.
 *   4. DISSENT IS SHOWN. Where the release names more than one base, every one is on screen with
 *      its count.
 *
 * The event each decision writes records whether it agreed with the draft on screen, which is how
 * the P&T committee audits the drafter. So a manual choice still sends the first draft's id: a
 * disagreement is a fact worth recording, not an absence.
 *
 * ═══ EVERY DRAFT IS UNTRUSTED TEXT ═══
 *
 * A model wrote the rationale, and the national release wrote the generic names. Both render
 * through React's text path only. The test drives markup through it.
 */

/** Ten substances a page: a sitting is about fifty, and a card is tall. */
const PAGE = 10;
const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;
const MOIETY_HITS = 10;
const NUMBERS = new Intl.NumberFormat("en-IN");

/** SNOMED's semantic tag is noise on a pharmacist's screen; the release name is otherwise verbatim. */
function displayName(released: string): string {
  return released.replace(/\s*\(substance\)\s*$/i, "");
}

function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setSettled(value.trim()); }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [value]);
  return settled;
}

export function MappingWorklist(): React.ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WireSubstanceStatus>("pending");
  const [query, setQuery] = useState("");
  const asked = useDebounced(query);
  const [done, setDone] = useState<string | null>(null);

  const q = asked.length >= MIN_QUERY ? asked : "";
  const list = useInfiniteQuery({
    queryKey: ["formulary", "substances", status, q],
    queryFn: ({ pageParam }) => fetchWorklistPage({ status, q, limit: PAGE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = (list.data?.pages ?? []).flatMap((p) => p.items);

  const statuses: WireSubstanceStatus[] = ["pending", "mapped", "unmappable"];
  return (
    <section data-testid="mapping-worklist" className="space-y-3 rounded border p-3">
      <h2 className="font-medium">{t("formularyAdmin.mapping.title")}</h2>
      <p className="max-w-3xl text-sm text-neutral-600">{t("formularyAdmin.mapping.intro")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t("formularyAdmin.mapping.statusLabel")} className="flex gap-1">
          {statuses.map((s) => (
            <Button
              key={s} type="button" size="sm" role="tab"
              variant={s === status ? "default" : "outline"}
              aria-selected={s === status}
              data-testid={`mapping-status-${s}`}
              onClick={() => { setStatus(s); setDone(null); }}
            >
              {t(`formularyAdmin.mapping.status.${s}`)}
            </Button>
          ))}
        </div>
        <label className="sr-only" htmlFor="mapping-search">{t("formularyAdmin.mapping.searchLabel")}</label>
        <input
          id="mapping-search" data-testid="mapping-search" value={query} autoComplete="off"
          placeholder={t("formularyAdmin.mapping.searchPlaceholder")}
          onChange={(e) => { setQuery(e.target.value); }}
          className="w-full max-w-xs rounded border px-2 py-1 text-sm"
        />
      </div>

      {done !== null && <p data-testid="mapping-done" role="status" className="text-sm text-emerald-700">{done}</p>}

      {list.isPending
        ? <p className="text-sm text-neutral-600">{t("formularyAdmin.mapping.loading")}</p>
        : list.isError
          /* A failed load must not read as "nothing to do". */
          ? <p data-testid="mapping-load-error" role="alert" className="text-sm text-red-700">{formularyErrorMessage(list.error)}</p>
          : items.length === 0
            ? <p data-testid="mapping-empty" className="text-sm text-neutral-600">{t(`formularyAdmin.mapping.empty.${status}`)}</p>
            : (
              <ul className="space-y-3">
                {items.map((item) => (
                  <li key={item.id}>
                    <SubstanceCard item={item} onDecided={setDone} onFind={(name) => { setQuery(name); setDone(null); }} />
                  </li>
                ))}
              </ul>
            )}

      {list.hasNextPage && (
        <Button
          type="button" variant="outline" size="sm" data-testid="mapping-more"
          disabled={list.isFetchingNextPage}
          onClick={() => { void list.fetchNextPage(); }}
        >
          {list.isFetchingNextPage ? t("formularyAdmin.mapping.loading") : t("formularyAdmin.mapping.more")}
        </Button>
      )}
    </section>
  );
}

function SubstanceCard({
  item, onDecided, onFind,
}: {
  item: WireWorklistItem;
  onDecided: (message: string) => void;
  /** Put a name in the worklist's search: "decide that substance first" must say where it is. */
  onFind: (name: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const decided = item.status !== "pending";
  const [correcting, setCorrecting] = useState(false);
  const [correctionReason, setCorrectionReason] = useState("");
  const [moietyQuery, setMoietyQuery] = useState("");
  const moietyAsk = useDebounced(moietyQuery);
  const [newName, setNewName] = useState("");
  const [unmappableReason, setUnmappableReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = displayName(item.name);
  const canAct = !decided || correcting;
  /** The draft that was on screen, for the agreement measure (see the header). */
  const draftOnScreen = item.proposals[0]?.id ?? null;

  const moieties = useQuery({
    queryKey: ["formulary", "salts", "moieties", moietyAsk],
    queryFn: () => fetchSaltsPage({ q: moietyAsk, activeOnly: true, moietiesOnly: true, limit: MOIETY_HITS }),
    enabled: canAct && moietyAsk.length >= MIN_QUERY,
  });

  const finish = async (decision: WireMappingDecision, message: string): Promise<void> => {
    const p = decision.projection;
    onDecided(message
      + (p.rowsMoved > 0 ? ` ${t("formularyAdmin.mapping.moved", { count: p.rowsMoved, medicines: NUMBERS.format(p.medicinesMoved) })}` : "")
      + (p.medicinesBlocked > 0 ? ` ${t("formularyAdmin.mapping.blocked", { count: p.medicinesBlocked })}` : ""));
    await qc.invalidateQueries({ queryKey: ["formulary"] });
  };

  /** A correction must say why; a first decision must not pretend to be one. */
  const reasonOrRefuse = (): string | null | undefined => {
    if (!decided) return null;
    const reason = correctionReason.trim();
    if (reason === "") { setError(t("formularyAdmin.mapping.correctionReasonRequired")); return undefined; }
    return reason;
  };

  const attest = async (target: AttestTarget, label: string, proposalId: string | null): Promise<void> => {
    setError(null);
    const reason = reasonOrRefuse();
    if (reason === undefined) return;
    setBusy(true);
    try {
      const decision = await attestSubstance(item.id, {
        target, proposalId, ...(reason === null ? {} : { correctionReason: reason }),
      });
      await finish(decision, t("formularyAdmin.mapping.mappedTo", { substance: name, moiety: label }));
    } catch (e) {
      setError(formularyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const unmappable = async (): Promise<void> => {
    setError(null);
    const reason = unmappableReason.trim();
    if (reason === "") { setError(t("formularyAdmin.mapping.unmappableReasonRequired")); return; }
    setBusy(true);
    try {
      const decision = await ruleSubstanceUnmappable(item.id, { reason, ...(decided ? { correction: true } : {}) });
      await finish(decision, t("formularyAdmin.mapping.ruledUnmappable", { substance: name }));
    } catch (e) {
      setError(formularyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** The release's other names for it, without repeating the one in the heading. */
  const otherNames = [...new Set(item.synonyms.map(displayName))].filter((synonym) => synonym !== name);
  /**
   * ═══ "IT IS ITS OWN MOIETY" IS NOT A NEUTRAL SHORTCUT WHEN A DRAFT DISAGREES ═══
   *
   * Found in the browser, on real data. The card for "Clavulanate potassium" offered "Clavulanate
   * potassium is its own moiety" as a prominent button beside the release's own statement that
   * the moiety is clavulanic acid. Pressing it records a SALT FORM as a moiety, which is the
   * second-warfarin failure the schema header warns about, made one tap away.
   *
   * So the shortcut is offered plainly only where no draft names something else. Where one does,
   * it sits behind a question the pharmacist has to answer first, with the salt-form caution
   * beside it. It stays reachable, because a draft can be wrong, and without it "create
   * <this name>" is refused: the entry already holds the name.
   */
  const ownEntryOffered = item.proposals.some((p) => p.existingState === "own_entry");
  const draftDisagrees = item.proposals.some((p) => p.existingState !== "own_entry");
  const [ownEntryAsked, setOwnEntryAsked] = useState(false);
  const ownEntryShown = item.ownEntryId !== null && !ownEntryOffered && (!draftDisagrees || ownEntryAsked);

  return (
    <article data-testid={`mapping-card-${item.id}`} className="space-y-2 rounded border p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-medium" data-testid={`mapping-name-${item.id}`}>{name}</h3>
          <p className="text-xs text-neutral-600">
            SNOMED CT {item.sctid}
            {otherNames.length > 0 && ` · ${otherNames.join(" · ")}`}
          </p>
        </div>
        <p className="text-sm" data-testid={`mapping-coverage-${item.id}`}>
          {t("formularyAdmin.mapping.coverage", { count: item.coverage, shown: NUMBERS.format(item.coverage) })}
        </p>
      </header>

      {item.sampleGenerics.length > 0 && (
        <ul className="list-inside list-disc text-xs text-neutral-600" aria-label={t("formularyAdmin.mapping.inDrugs")}>
          {item.sampleGenerics.map((g) => <li key={g}>{g}</li>)}
        </ul>
      )}

      {decided && (
        <p data-testid={`mapping-decision-${item.id}`} className="text-sm">
          {item.status === "mapped"
            ? t("formularyAdmin.mapping.decidedMapped", { moiety: item.saltName ?? "", by: item.mappedBy ?? "" })
            : t("formularyAdmin.mapping.decidedUnmappable", { by: item.mappedBy ?? "" })}
          {/* Phase 3: an adopted decision is not a reviewed one, and the card says which it is. */}
          {typeof item.adoptedUnder === "string" && (
            <>{" "}{t("formularyAdmin.mapping.adoptedUnder", { resolution: item.adoptedUnder })}</>
          )}
          {" "}
          {!correcting && (
            <Button
              type="button" size="sm" variant="outline" data-testid={`mapping-correct-${item.id}`}
              onClick={() => { setCorrecting(true); }}
            >
              {t("formularyAdmin.mapping.correct")}
            </Button>
          )}
        </p>
      )}

      {canAct && (
        <>
          {decided && (
            <div>
              <label className="block text-sm font-medium" htmlFor={`mapping-correction-${item.id}`}>
                {t("formularyAdmin.mapping.correctionReason")}
              </label>
              <input
                id={`mapping-correction-${item.id}`} data-testid={`mapping-correction-${item.id}`}
                value={correctionReason} onChange={(e) => { setCorrectionReason(e.target.value); }}
                className="w-full max-w-md rounded border px-2 py-1 text-sm"
              />
            </div>
          )}

          {item.proposals.length === 0
            ? <p className="text-sm text-neutral-600" data-testid={`mapping-no-drafts-${item.id}`}>{t("formularyAdmin.mapping.noDrafts")}</p>
            : (
              <ul className="space-y-2" aria-label={t("formularyAdmin.mapping.drafts")}>
                {item.proposals.map((p) => (
                  <DraftRow
                    key={p.id} draft={p} busy={busy} substanceName={name} onFind={onFind}
                    onMap={(target, label) => { void attest(target, label, p.id); }}
                  />
                ))}
              </ul>
            )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-2">
            {item.ownEntryId !== null && !ownEntryOffered && draftDisagrees && !ownEntryAsked && (
              <Button
                type="button" size="sm" variant="ghost"
                data-testid={`mapping-own-entry-ask-${item.id}`}
                onClick={() => { setOwnEntryAsked(true); }}
              >
                {t("formularyAdmin.mapping.ownMoietyAsk", { name })}
              </Button>
            )}
            {ownEntryShown && draftDisagrees && (
              <p className="w-full text-xs text-amber-800" data-testid={`mapping-own-entry-caution-${item.id}`}>
                {t("formularyAdmin.mapping.ownMoietyCaution", { name })}
              </p>
            )}
            {ownEntryShown && (
              <Button
                type="button" size="sm" variant="outline" disabled={busy}
                data-testid={`mapping-own-entry-${item.id}`}
                onClick={() => { void attest({ saltId: item.ownEntryId as string }, name, draftOnScreen); }}
              >
                {t("formularyAdmin.mapping.ownMoiety", { name })}
              </Button>
            )}
            <label className="sr-only" htmlFor={`mapping-moiety-${item.id}`}>{t("formularyAdmin.mapping.chooseMoiety")}</label>
            <input
              id={`mapping-moiety-${item.id}`} data-testid={`mapping-moiety-search-${item.id}`}
              value={moietyQuery} autoComplete="off"
              placeholder={t("formularyAdmin.mapping.chooseMoiety")}
              onChange={(e) => { setMoietyQuery(e.target.value); }}
              className="rounded border px-2 py-1 text-sm"
            />
            <label className="sr-only" htmlFor={`mapping-new-${item.id}`}>{t("formularyAdmin.mapping.newMoiety")}</label>
            <input
              id={`mapping-new-${item.id}`} data-testid={`mapping-new-name-${item.id}`}
              value={newName} autoComplete="off"
              placeholder={t("formularyAdmin.mapping.newMoiety")}
              onChange={(e) => { setNewName(e.target.value); }}
              className="rounded border px-2 py-1 text-sm"
            />
            <Button
              type="button" size="sm" variant="outline" disabled={busy || newName.trim() === ""}
              data-testid={`mapping-create-${item.id}`}
              onClick={() => { void attest({ newMoiety: { name: newName.trim() } }, newName.trim(), draftOnScreen); }}
            >
              {t("formularyAdmin.mapping.createAndMap")}
            </Button>
          </div>

          {moietyAsk.length >= MIN_QUERY && (
            moieties.isError
              ? <p role="alert" className="text-xs text-red-700" data-testid={`mapping-moiety-error-${item.id}`}>{t("formularyAdmin.saltSearchFailed")}</p>
              : (moieties.data?.items ?? []).length === 0 && !moieties.isPending
                ? <p className="text-xs text-neutral-600">{t("formularyAdmin.mapping.noMoiety")}</p>
                : (
                  <ul className="flex flex-wrap gap-1" data-testid={`mapping-moiety-hits-${item.id}`}>
                    {(moieties.data?.items ?? []).map((s) => (
                      <li key={s.id}>
                        <Button
                          type="button" size="sm" variant="outline" disabled={busy}
                          data-testid={`mapping-pick-${item.id}-${s.id}`}
                          onClick={() => { void attest({ saltId: s.id }, s.name, draftOnScreen); }}
                        >
                          {t("formularyAdmin.mapping.mapTo", { name: s.drugClass === null ? s.name : `${s.name} (${s.drugClass})` })}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`mapping-unmappable-${item.id}`}>{t("formularyAdmin.mapping.unmappableReason")}</label>
            <input
              id={`mapping-unmappable-${item.id}`} data-testid={`mapping-unmappable-reason-${item.id}`}
              value={unmappableReason} autoComplete="off"
              placeholder={t("formularyAdmin.mapping.unmappableReason")}
              onChange={(e) => { setUnmappableReason(e.target.value); }}
              className="w-full max-w-md rounded border px-2 py-1 text-sm"
            />
            {item.status !== "unmappable" && (
              <Button
                type="button" size="sm" variant="outline" disabled={busy}
                data-testid={`mapping-unmappable-${item.id}`}
                onClick={() => { void unmappable(); }}
              >
                {t("formularyAdmin.mapping.unmappable")}
              </Button>
            )}
          </div>
        </>
      )}

      {error !== null && <p role="alert" data-testid={`mapping-error-${item.id}`} className="text-sm text-red-700">{error}</p>}
    </article>
  );
}

function DraftRow({
  draft, busy, substanceName, onFind, onMap,
}: {
  draft: WireDraft;
  busy: boolean;
  /** The card's own display name: "its own moiety" is said about the SUBSTANCE, in its own spelling. */
  substanceName: string;
  onFind: (name: string) => void;
  onMap: (target: AttestTarget, label: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const ev = draft.evidence;
  const model = draft.basis === "agent";
  return (
    <li
      data-testid={`mapping-draft-${draft.id}`}
      className={model ? "space-y-1 rounded border border-amber-300 bg-amber-50 p-2" : "space-y-1 rounded border p-2"}
    >
      <p className="text-sm">
        <span data-testid={`mapping-basis-${draft.id}`} className={model ? "font-medium text-amber-800" : "font-medium"}>
          {draft.basis === "release_boss" && t("formularyAdmin.mapping.basis.releaseBoss")}
          {draft.basis === "release_base" && t("formularyAdmin.mapping.basis.releaseBase")}
          {model && t("formularyAdmin.mapping.basis.agent", { model: ev.model ?? draft.draftedBy })}
        </span>
        {": "}
        <span className="font-semibold">{draft.moietyName}</span>
        {ev.support !== undefined && (
          <span className="text-neutral-600"> · {t("formularyAdmin.mapping.support", { count: ev.support })}</span>
        )}
        {ev.droppedWord !== undefined && (
          <span className="text-neutral-600"> · {t("formularyAdmin.mapping.droppedWord", { word: ev.droppedWord })}</span>
        )}
      </p>
      {ev.rationale !== undefined && (
        <p data-testid={`mapping-rationale-${draft.id}`} className="text-xs text-neutral-700">{ev.rationale}</p>
      )}
      {(ev.alternatives ?? []).length > 0 && (
        <p data-testid={`mapping-dissent-${draft.id}`} className="text-xs text-amber-800">
          {t("formularyAdmin.mapping.dissent", {
            names: (ev.alternatives ?? []).map((a) => `${a.name} (${String(a.support)})`).join(", "),
          })}
        </p>
      )}
      {(ev.generics ?? []).length > 0 && (
        <p className="text-xs text-neutral-600">{(ev.generics ?? [])[0]?.name}</p>
      )}
      <div>
        {draft.existingState === "moiety" && draft.existingSaltId !== null && (
          <Button
            type="button" size="sm" disabled={busy} data-testid={`mapping-accept-${draft.id}`}
            onClick={() => { onMap({ saltId: draft.existingSaltId as string }, draft.moietyName); }}
          >
            {t("formularyAdmin.mapping.mapTo", { name: draft.moietyName })}
          </Button>
        )}
        {draft.existingState === "own_entry" && draft.existingSaltId !== null && (
          <Button
            type="button" size="sm" disabled={busy} data-testid={`mapping-accept-${draft.id}`}
            onClick={() => { onMap({ saltId: draft.existingSaltId as string }, substanceName); }}
          >
            {t("formularyAdmin.mapping.ownMoiety", { name: substanceName })}
          </Button>
        )}
        {draft.existingState === "none" && (
          <Button
            type="button" size="sm" disabled={busy} data-testid={`mapping-accept-${draft.id}`}
            onClick={() => { onMap({ newMoiety: { name: draft.moietyName } }, draft.moietyName); }}
          >
            {t("formularyAdmin.mapping.createNamed", { name: draft.moietyName })}
          </Button>
        )}
        {draft.existingState === "other_entry" && (
          <p data-testid={`mapping-decide-first-${draft.id}`} className="flex flex-wrap items-center gap-2 text-xs text-neutral-700">
            {t("formularyAdmin.mapping.decideFirst", { name: draft.moietyName })}
            <Button
              type="button" size="sm" variant="outline"
              data-testid={`mapping-find-${draft.id}`}
              onClick={() => { onFind(draft.moietyName); }}
            >
              {t("formularyAdmin.mapping.findIt", { name: draft.moietyName })}
            </Button>
          </p>
        )}
      </div>
    </li>
  );
}
