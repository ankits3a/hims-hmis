import {
  checkDuplicateSalt, checkInteractions, isCurrent, matchAllergiesSaltAware,
} from "./rx-checks";
import type { PriorRx, RxCheckLine } from "./rx-checks";
import type { InteractionPair, ResolvedDrug } from "../formulary";
import type { RxLine } from "./fhir";

/**
 * PLAN 16a T4 — the three checks.
 *
 * NO DATABASE, BY CONSTRUCTION: these are pure functions and `purity.test.ts` holds them to it.
 * `now` is an argument, which is what lets the currency legs below put a prescription 91 days in
 * the past without a clock or a wait.
 *
 * Every fixture is a real pharmacological fact. Amoxicillin IS a penicillin and Augmentin IS
 * amoxicillin + clavulanic acid; warfarin × aspirin IS a severe interaction. A suite green over
 * invented pharmacology would prove the plumbing and nothing a patient cares about.
 */
const AMOX = { saltId: "S-AMOX", moiety: "amoxicillin", drugClass: "penicillin" };
const CLAV = { saltId: "S-CLAV", moiety: "clavulanic acid", drugClass: null };
const WARFARIN = { saltId: "S-WARF", moiety: "warfarin", drugClass: null };
const ASPIRIN = { saltId: "S-ASA", moiety: "aspirin", drugClass: "nsaid" };
const DICLOFENAC = { saltId: "S-DICLO", moiety: "diclofenac", drugClass: "nsaid" };
const THYROXINE = { saltId: "S-THYR", moiety: "levothyroxine", drugClass: null };

const NOW = new Date("2026-08-26T09:00:00.000Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function drug(
  brandName: string | null,
  salts: { saltId: string; moiety: string; drugClass: string | null }[],
  routeClass: "systemic" | "topical" | null = "systemic",
): ResolvedDrug {
  return { medicineId: brandName === null ? null : `M-${brandName}`, brandName, routeClass, salts };
}

function line(lineIndex: number, drugText: string, resolution: ResolvedDrug | null): RxCheckLine {
  return { lineIndex, drug: drugText, resolution };
}

function priorRx(
  prescriptionId: string,
  issuedAt: Date,
  lines: { drug: string; durationDays: number | null; resolution: ResolvedDrug | null }[],
): PriorRx {
  return {
    prescriptionId,
    issuedAt,
    lines: lines.map((l) => ({
      line: {
        drug: l.drug, dose: "1", route: "oral", frequency: "OD",
        durationDays: l.durationDays, instructions: null, noSubstitution: false,
      } satisfies RxLine,
      resolution: l.resolution,
    })),
  };
}

const WARFARIN_ASPIRIN: InteractionPair = {
  saltAId: "S-ASA", saltBId: "S-WARF", severity: "severe",
  note: "bleeding risk — avoid or monitor INR closely", routeScope: null,
};
const WARFARIN_DICLOFENAC: InteractionPair = {
  saltAId: "S-DICLO", saltBId: "S-WARF", severity: "severe",
  note: "bleeding risk when systemic", routeScope: "systemic_only",
};

describe("rx-checks: salt-aware allergy matching (Plan 16a T4)", () => {
  /**
   * THE AUGMENTIN REGRESSION, BY NAME. This is the case the whole phase exists for: today's
   * matcher compares "penicillin" to "Augmentin 625" with `includes()` in both directions and
   * finds nothing, because nothing in the system knows that Augmentin contains amoxicillin and
   * that amoxicillin IS a penicillin.
   */
  it("an allergy to a CLASS catches a brand containing a moiety of that class", () => {
    const lines = [line(0, "Augmentin 625", drug("Augmentin 625", [AMOX, CLAV]))];
    const matches = matchAllergiesSaltAware(lines, [{ substance: "penicillin", resolution: null }]);
    expect(matches).toEqual([{ lineIndex: 0, substance: "penicillin" }]);

    // And the negative that makes it a real assertion rather than a matcher that says yes: a class
    // the line does not contain raises nothing.
    expect(matchAllergiesSaltAware(lines, [{ substance: "sulfonamide", resolution: null }])).toEqual([]);
  });

  it("a brand-name allergy catches a line prescribed by moiety, with no shared text at all", () => {
    const lines = [line(0, "Amoxicillin 500", drug(null, [AMOX], null))];
    const matches = matchAllergiesSaltAware(lines, [
      { substance: "Augmentin", resolution: drug("Augmentin 625", [AMOX, CLAV]) },
    ]);
    // "augmentin" and "amoxicillin 500" share no substring in either direction — only the moiety
    // sets can find this, which is exactly what the resolution layer is for.
    expect(matches).toEqual([{ lineIndex: 0, substance: "Augmentin" }]);
  });

  it("the legacy substring layer still protects a line the formulary has never heard of", () => {
    const lines = [line(0, "Sulfamethoxazole 800", null)];
    expect(matchAllergiesSaltAware(lines, [{ substance: "sulfa", resolution: null }]))
      .toEqual([{ lineIndex: 0, substance: "sulfa" }]);
    // Bidirectional, as shipped: the allergy may be the longer side.
    expect(matchAllergiesSaltAware([line(0, "penicillin", null)], [{ substance: "Penicillin G", resolution: null }]))
      .toEqual([{ lineIndex: 0, substance: "Penicillin G" }]);
  });

  /**
   * THE GUARD THE SHIPPED MATCHER LACKS. An allergy recorded as "B" would otherwise warn on every
   * drug containing the letter b — and a hard warning that fires on everything is a hard warning
   * nobody reads.
   */
  it("a side shorter than four characters matches only as a whole token", () => {
    expect(matchAllergiesSaltAware([line(0, "Ibuprofen 400", null)], [{ substance: "b", resolution: null }]))
      .toEqual([]);
    // …but a short substance that IS a token still matches, because that is a real allergy record.
    expect(matchAllergiesSaltAware([line(0, "Vitamin B 12", null)], [{ substance: "B", resolution: null }]))
      .toEqual([{ lineIndex: 0, substance: "B" }]);
  });

  it("one warning per (line, substance) even when every layer agrees", () => {
    // Resolved on both sides AND the class matches AND the raw text overlaps: still one match.
    const matches = matchAllergiesSaltAware(
      [line(0, "amoxicillin", drug(null, [AMOX], null))],
      [{ substance: "amoxicillin", resolution: drug(null, [AMOX], null) }],
    );
    expect(matches).toHaveLength(1);
  });

  it("a substance that is not a drug at all raises nothing and throws nothing", () => {
    // `adrak` (ginger) and `dust` are real production allergy substances, measured 2026-08-26.
    const lines = [line(0, "Augmentin 625", drug("Augmentin 625", [AMOX, CLAV]))];
    expect(matchAllergiesSaltAware(lines, [
      { substance: "adrak", resolution: null },
      { substance: "dust", resolution: null },
      { substance: "   ", resolution: null },
    ])).toEqual([]);
  });
});

describe("rx-checks: currency (Plan 16a T4)", () => {
  it("a recorded duration decides, and a missing one falls back to ninety days — labelled", () => {
    expect(isCurrent(5, daysAgo(3), NOW)).toEqual({ current: true, assumedCurrent: false });
    expect(isCurrent(5, daysAgo(10), NOW)).toEqual({ current: false, assumedCurrent: false });
    expect(isCurrent(null, daysAgo(30), NOW)).toEqual({ current: true, assumedCurrent: true });
    expect(isCurrent(null, daysAgo(91), NOW)).toEqual({ current: false, assumedCurrent: true });
    // The boundary itself is inclusive on both paths.
    expect(isCurrent(5, daysAgo(5), NOW).current).toBe(true);
    expect(isCurrent(null, daysAgo(90), NOW).current).toBe(true);
  });
});

describe("rx-checks: interactions (Plan 16a T4)", () => {
  it("a severe pair across two lines of one prescription is a hit on the later line", () => {
    const lines = [
      line(0, "Warf 5", drug("Warf 5", [WARFARIN])),
      line(1, "Aspirin 75", drug("Aspirin 75", [ASPIRIN])),
    ];
    const hits = checkInteractions(lines, [], [WARFARIN_ASPIRIN], NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      severity: "severe", lineIndex: 1, note: "bleeding risk — avoid or monitor INR closely",
      against: { scope: "in_rx", lineIndex: 0 },
    });
  });

  /**
   * THE PRIOR-SCOPE LEG. A patient already on warfarin, prescribed aspirin today, is the case that
   * cannot be seen by looking at one prescription — and it is the ordinary case, not the exotic one.
   */
  it("a severe pair against a CURRENT prior prescription is a hit", () => {
    const lines = [line(0, "Aspirin 75", drug("Aspirin 75", [ASPIRIN]))];
    const priors = [priorRx("RX-1", daysAgo(10), [
      { drug: "Warf 5", durationDays: 30, resolution: drug("Warf 5", [WARFARIN]) },
    ])];
    const hits = checkInteractions(lines, priors, [WARFARIN_ASPIRIN], NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      severity: "severe", lineIndex: 0,
      against: { scope: "prior", prescriptionId: "RX-1", assumedCurrent: false },
    });
  });

  it("an EXPIRED prior course is not a hit, and a duration-less one is a labelled hit", () => {
    const lines = [line(0, "Aspirin 75", drug("Aspirin 75", [ASPIRIN]))];
    // Both legs in one test so an `isCurrent` that always says true cannot pass by luck.
    const expired = [priorRx("RX-OLD", daysAgo(40), [
      { drug: "Warf 5", durationDays: 5, resolution: drug("Warf 5", [WARFARIN]) },
    ])];
    expect(checkInteractions(lines, expired, [WARFARIN_ASPIRIN], NOW)).toEqual([]);

    const chronic = [priorRx("RX-CHR", daysAgo(30), [
      { drug: "Warf 5", durationDays: null, resolution: drug("Warf 5", [WARFARIN]) },
    ])];
    const hits = checkInteractions(lines, chronic, [WARFARIN_ASPIRIN], NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.against).toMatchObject({ scope: "prior", assumedCurrent: true });
  });

  it("a systemic-only pair does not fire when either side is topical", () => {
    const topicalGel = line(0, "Diclofenac gel", drug("Diclofenac gel", [DICLOFENAC], "topical"));
    const priors = [priorRx("RX-1", daysAgo(5), [
      { drug: "Warf 5", durationDays: 30, resolution: drug("Warf 5", [WARFARIN]) },
    ])];
    expect(checkInteractions([topicalGel], priors, [WARFARIN_DICLOFENAC], NOW)).toEqual([]);

    // The same pair, systemically, DOES fire — otherwise the leg above proves only that nothing works.
    const tablet = line(0, "Diclofenac 50", drug("Diclofenac 50", [DICLOFENAC], "systemic"));
    expect(checkInteractions([tablet], priors, [WARFARIN_DICLOFENAC], NOW)).toHaveLength(1);
  });

  it("a pair INSIDE one line is not a prescriber's problem, so it never fires", () => {
    // A marketed FDC containing both moieties: DD8 puts this check at admission, not here.
    const fdc = [line(0, "Invented Combination", drug("Invented Combination", [WARFARIN, ASPIRIN]))];
    expect(checkInteractions(fdc, [], [WARFARIN_ASPIRIN], NOW)).toEqual([]);
  });

  it("unresolved lines and an empty pair table are quiet, never noisy and never a throw", () => {
    const lines = [line(0, "Some Ayurvedic Tonic", null), line(1, "Aspirin 75", drug("Aspirin 75", [ASPIRIN]))];
    expect(checkInteractions(lines, [], [WARFARIN_ASPIRIN], NOW)).toEqual([]);
    expect(checkInteractions(lines, [], [], NOW)).toEqual([]);
  });
});

describe("rx-checks: duplicate therapy (Plan 16a T4)", () => {
  /**
   * BOTH SCOPES IN ONE TEST, deliberately: an implementation that marks every duplicate hard would
   * pass a test that only checked the in-rx case, and hard-warning every refill is precisely how
   * override fatigue is manufactured.
   */
  it("the same moiety twice in one prescription is HARD; against a prior it is soft", () => {
    const lines = [
      line(0, "Crocin 650", drug("Crocin 650", [{ saltId: "S-PARA", moiety: "paracetamol", drugClass: null }])),
      line(1, "Dolo 650", drug("Dolo 650", [{ saltId: "S-PARA", moiety: "paracetamol", drugClass: null }])),
    ];
    const priors = [priorRx("RX-1", daysAgo(5), [
      { drug: "Calpol", durationDays: 30, resolution: drug("Calpol", [{ saltId: "S-PARA", moiety: "paracetamol", drugClass: null }]) },
    ])];
    const hits = checkDuplicateSalt(lines, priors, NOW);
    const inRx = hits.filter((h) => h.against.scope === "in_rx");
    const vsPrior = hits.filter((h) => h.against.scope === "prior");
    expect(inRx.map((h) => h.hard)).toEqual([true]);
    expect(vsPrior.every((h) => !h.hard)).toBe(true);
    expect(vsPrior.length).toBeGreaterThan(0);
    expect(inRx[0]).toMatchObject({ moiety: "paracetamol", lineIndex: 1 });
  });

  it("the same moiety by two different routes is soft — a gel plus a tablet is often deliberate", () => {
    const lines = [
      line(0, "Diclofenac gel", drug("Diclofenac gel", [DICLOFENAC], "topical")),
      line(1, "Diclofenac 50", drug("Diclofenac 50", [DICLOFENAC], "systemic")),
    ];
    expect(checkDuplicateSalt(lines, [], NOW).map((h) => h.hard)).toEqual([false]);
  });

  it("an UNKNOWN route does not soften the warning", () => {
    // A moiety-only line carries no route. Guessing "probably a different route" to downgrade a
    // double-dose warning is the one guess with a patient on the other end of it.
    const lines = [
      line(0, "levothyroxine 50mcg", drug(null, [THYROXINE], null)),
      line(1, "Thyronorm 50", drug("Thyronorm 50", [THYROXINE], "systemic")),
    ];
    expect(checkDuplicateSalt(lines, [], NOW).map((h) => h.hard)).toEqual([true]);
  });

  it("an expired prior course raises no duplicate at all", () => {
    const lines = [line(0, "Amoxil 500", drug("Amoxil 500", [AMOX]))];
    const priors = [priorRx("RX-OLD", daysAgo(10), [
      { drug: "Amoxil 500", durationDays: 5, resolution: drug("Amoxil 500", [AMOX]) },
    ])];
    expect(checkDuplicateSalt(lines, priors, NOW)).toEqual([]);
  });
});
