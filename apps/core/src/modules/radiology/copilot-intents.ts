import { strongCue as S, weakCue as W } from "../../kernel/copilot/intents";
import type { CopilotIntentDecl, ModuleCopilotIntent } from "../../kernel/copilot/intents";

/**
 * #1082 (IM5) — THE IMAGING DEPARTMENT'S FOURTEEN COPILOT QUESTIONS, declared through the open intent
 * seam (#598) in the shape `doctor-desk` and `roster` use.
 *
 * FLOOR-ONLY (spec #1082, DECIDED): no `menu` and no `help`, so the chat model's system prompt and the
 * chooser's request stay byte-identical and the frozen eval set's recordings are untouched. The
 * phrasebook alone routes these; adding menu lines is its own issue, with a re-recording.
 *
 * ═══ HOW THE WORDS WERE CHOSEN ═══
 *
 * The floor matches SUBSTRINGS of the normalised question, and a cue token belongs to exactly one
 * intent (the boot collector refuses a second claimant). So nothing here is a bare word another
 * desk already says — "book", "move", "due", "report", "status", "slot" are the kernel's — and each
 * intent is reached by phrases that name the imaging thing ("scan slot", "reading list", "critical
 * call", "film"), worth more together than the kernel's one word ("book" 3 + "slot" 1) so the margin
 * rule (2) is met. Bare "ct" is never a cue: it is inside "doctor" and "acted".
 *
 * English, Devanagari and romanised Hinglish for every intent. `notCues` keep the four acts and the
 * slot question apart from each other.
 */
export const radiologyCopilotIntents: Readonly<Record<ModuleCopilotIntent, CopilotIntentDecl>> = {
  "radiology.my_list": {
    cues: [
      S("my list"), S("my reading list"), S("reading list"), S("my worklist"), S("worklist"), S("prep list"), S("on my list"),
      S("meri list"), S("meri reading"), S("mera worklist"), S("list mein kitne"),
      S("मेरी लिस्ट"), S("रीडिंग लिस्ट"), S("वर्कलिस्ट"), S("लिस्ट में कितने"), S("मेरी सूची"),
      W("list"), W("लिस्ट"),
    ],
    notCues: ["overdue", "late", "लेट", "follow", "फॉलो"],
    answerKeys: ["copilot.answer.radMyListRead", "copilot.answer.radMyListPrep", "copilot.answer.radMyListFloor"],
  },
  "radiology.study_status": {
    cues: [
      S("held up"), S("holding up"), S("what is holding"), S("scan status"), S("study status"), S("where is the scan"), S("stuck"),
      S("kahan atka"), S("kahan atki"), S("atka hai"), S("atki hai"), S("kyun ruka"), S("kyon ruka"), S("ruka hua"), S("ruki hui"),
      S("कहाँ अटकी"), S("कहाँ अटका"), S("अटकी है"), S("अटका है"), S("क्यों रुकी"), S("क्यों रुका"), S("रुकी हुई"),
      W("atka"), W("atki"), W("अटक"),
    ],
    answerKeys: ["copilot.answer.radNoStudy", "copilot.answer.radStudies", "copilot.answer.radStudyHeld", "copilot.answer.radStudyState"],
  },
  "radiology.next_slot": {
    cues: [
      S("next slot"), S("next free slot"), S("free slot"), S("earliest slot"), S("agla slot"), S("agla khali slot"), S("khali slot"),
      S("slot kab"), S("slot milega"), S("अगला स्लॉट"), S("खाली स्लॉट"), S("स्लॉट कब"), S("स्लॉट मिलेगा"),
    ],
    notCues: ["book", "बुक", "move", "no show", "नो शो", "another slot"],
    answerKeys: [
      "copilot.answer.radNoStudy", "copilot.answer.radStudies", "copilot.answer.radNextSlot", "copilot.answer.radNextSlotNone",
      "copilot.answer.radNothingToBook",
    ],
  },
  "radiology.overdue_reads": {
    cues: [
      S("overdue read"), S("overdue"), S("past target"), S("over target"), S("late reads"), S("reads late"), S("reads past"),
      S("reports late"), S("late chal"), S("late report"), S("der se chal"),
      S("समय से पीछे"), S("लेट चल"), S("रिपोर्ट लेट"), S("देर से चल"),
    ],
    notCues: ["follow", "फॉलो"],
    answerKeys: ["copilot.answer.radOverdue", "copilot.answer.radOverdueNone"],
  },
  "radiology.open_criticals": {
    cues: [
      S("critical"), S("critical call"), S("critical calls"), S("open critical"), S("criticals"), S("critical finding"),
      S("क्रिटिकल"), S("क्रिटिकल कॉल"), S("गंभीर रिपोर्ट"),
    ],
    answerKeys: ["copilot.answer.radCriticals", "copilot.answer.radCriticalsNone"],
  },
  "radiology.report_ready": {
    cues: [
      S("report ready"), S("report taiyar"), S("report tayyar"), S("report ban gayi"), S("report ban gaya"), S("ready to hand"),
      S("hand over"), S("handover"), S("report ready hai"), S("रिपोर्ट तैयार"), S("रिपोर्ट बन गई"), S("रिपोर्ट बनी"),
      W("ready"), W("तैयार"),
    ],
    notCues: ["draft", "ड्राफ्ट", "film", "फिल्म"],
    answerKeys: [
      "copilot.answer.radNoStudy", "copilot.answer.radStudies", "copilot.answer.radReportNotReady", "copilot.answer.radReportReady",
      "copilot.answer.radReportHeld", "copilot.answer.radReportHanded",
    ],
  },
  "radiology.machine_status": {
    cues: [
      S("machine down"), S("machines down"), S("which machine"), S("machine status"), S("machines working"), S("is down"), S("are down"),
      S("machine band"), S("machine kharab"), S("machine chal"), S("मशीन बंद"), S("मशीन खराब"), S("मशीन ख़राब"), S("कौन सी मशीन"), S("मशीन चल"),
      W("machine"), W("machines"), W("मशीन"),
    ],
    answerKeys: ["copilot.answer.radMachines", "copilot.answer.radMachinesDown", "copilot.answer.radMachinesNone"],
  },
  "radiology.numbers": {
    cues: [
      S("imaging numbers"), S("radiology numbers"), S("our numbers"), S("north star"), S("turnaround"), S("numbers batao"),
      S("department numbers"), S("आंकड़े"), S("आँकड़े"), S("इमेजिंग के आंकड़े"), S("aankde"), S("aankade"),
      W("numbers"),
    ],
    answerKeys: ["copilot.answer.radNumbers"],
  },
  "radiology.followups_due": {
    cues: [
      S("follow up"), S("followup"), S("follow ups"), S("followups"), S("follow up due"), S("follow ups due"), S("follow up kitne"),
      S("फॉलो अप"), S("फ़ॉलो अप"), S("फॉलो अप बाकी"),
    ],
    answerKeys: ["copilot.answer.radFollowups", "copilot.answer.radFollowupsNone"],
  },
  "radiology.draft_report": {
    cues: [
      S("draft the report"), S("draft report"), S("report draft"), S("draft bana"), S("draft kar"), S("draft likh"), S("write a draft"),
      S("ड्राफ्ट"), S("रिपोर्ट का ड्राफ्ट"), S("ड्राफ्ट बना"),
      W("draft"),
    ],
    answerKeys: ["copilot.answer.radNoStudy", "copilot.answer.radStudies", "copilot.answer.radDraftReady", "copilot.answer.radNotReportable"],
  },
  "radiology.book_slot": {
    cues: [
      S("scan slot"), S("book a scan"), S("book the scan"), S("book this scan"), S("scan book"), S("book a slot"), S("book the slot"),
      S("book the next slot"), S("slot book"), S("slot book kar"), S("स्लॉट बुक"), S("स्लॉट बुक कर"), S("स्कैन बुक"), S("जाँच बुक"),
    ],
    notCues: ["kab", "कब", "when", "move", "no show", "नो शो", "another slot"],
    answerKeys: [
      "copilot.answer.radNoStudy", "copilot.answer.radNothingToBook", "copilot.answer.radBookPick", "copilot.answer.radNextSlotNone",
      "copilot.answer.radBooked", "copilot.answer.radSlotTaken", "copilot.answer.radStudyChanged",
    ],
  },
  "radiology.move_or_no_show": {
    cues: [
      S("no show"), S("noshow"), S("नो शो"), S("did not come"), S("didn t come"), S("nahi aaya"), S("nahin aaya"), S("nahi aayi"),
      S("nahin aayi"), S("नहीं आया"), S("नहीं आई"), S("नहीं आए"),
      S("move the scan"), S("scan move"), S("move this scan"), S("reschedule the scan"), S("scan to"), S("another slot"),
      S("dusra slot"), S("doosra slot"), S("scan aage"), S("scan ko aage"), S("दूसरा स्लॉट"), S("स्कैन आगे"), S("जाँच आगे"),
    ],
    notCues: ["lene", "dawa", "दवा", "medicine", "paisa", "paise"],
    answerKeys: [
      "copilot.answer.radNoStudy", "copilot.answer.radNothingToMove", "copilot.answer.radMovePick", "copilot.answer.radNoShowPick",
      "copilot.answer.radNeedReason", "copilot.answer.radNextSlotNone", "copilot.answer.radMoved", "copilot.answer.radNoShowDone",
      "copilot.answer.radSlotTaken", "copilot.answer.radStudyChanged",
    ],
  },
  "radiology.mark_acted": {
    cues: [
      S("acted"), S("report acted"), S("acted on"), S("mark acted"), S("action taken"), S("report pe action"), S("report par action"),
      S("action le liya"), S("action liya"), S("रिपोर्ट पर कार्रवाई"), S("कार्रवाई"), S("कार्यवाही"),
    ],
    answerKeys: [
      "copilot.answer.radNoStudy", "copilot.answer.radActedNothing", "copilot.answer.radActedPick", "copilot.answer.radActedNeedNote",
      "copilot.answer.radActedNotYours", "copilot.answer.radActedDone", "copilot.answer.radActedAlready", "copilot.answer.radStudyChanged",
    ],
  },
  "radiology.request_film_cd": {
    cues: [
      S("film"), S("films"), S("film chahiye"), S("film de do"), S("print film"), S("film print"), S("cd chahiye"), S("cd de do"),
      S("cd bana"), S("a cd"), S("the cd"), S("cd for"), S("cd of"), S("फिल्म"), S("फ़िल्म"), S("फिल्म चाहिए"), S("सीडी"),
    ],
    answerKeys: [
      "copilot.answer.radNoStudy", "copilot.answer.radMediaNotReleased", "copilot.answer.radMediaPick", "copilot.answer.radMediaDone",
      "copilot.answer.radStudyChanged",
    ],
  },
};
