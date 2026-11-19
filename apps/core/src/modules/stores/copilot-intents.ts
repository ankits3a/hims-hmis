import { strongCue as S, weakCue as W } from "../../kernel/copilot/intents";
import type { CopilotIntentDecl, ModuleCopilotIntent } from "../../kernel/copilot/intents";

/**
 * #1113 (S3) — THE STORES CONCIERGE'S SEVEN QUESTIONS, declared through the open intent seam (#598) in the shape
 * `radiology` uses (#1082).
 *
 * FLOOR-ONLY (spec #1113 decision 8): no `menu` and no `help`, so the chat model's system prompt and the chooser's
 * request stay byte-identical and the frozen eval set's recordings are untouched. The phrasebook alone routes
 * these; adding menu lines is its own issue, with a re-recording.
 *
 * ═══ HOW THE WORDS WERE CHOSEN ═══
 *
 * The floor matches SUBSTRINGS of the normalised question; a cue token belongs to exactly one intent (the boot
 * collector refuses a second claimant), and the winner must beat the runner-up by 2. So the bare words other desks
 * already own are never cues here — the kernel's "stock", "shelf", "wait", "order", "khatam", the radiology desk's
 * "stuck" and "atka hai", the doctor desk's "waiting on me" and "mere liye" — and a question that contains one of
 * them (a stores question often says "shelf" or "waiting") is reached by a PHRASE worth more than that word.
 *
 * `MIN<<` is the indent number as the masker leaves it: the series prefix stays, the digits are the placeholder
 * (`kernel/copilot/mask.ts`), so "MIN2611190007 kahan hai?" is about a Stores ticket and "<<P1>> kahan hai?" (a
 * UHID at the OPD desk) is not. "kahan hai" alone is weak on purpose: it never takes a patient's whereabouts.
 *
 * English, Devanagari and romanised Hinglish for every intent.
 */
export const storesCopilotIntents: Readonly<Record<ModuleCopilotIntent, CopilotIntentDecl>> = {
  "stores.where_is_ticket": {
    cues: [
      S("min<<"), S("min <<"), S("where is my ticket"), S("where is my indent"), S("where is the ticket"), S("where is the indent"),
      S("ticket kahan"), S("indent kahan"), S("mera saman kahan"), S("mera samaan kahan"), S("mera maal kahan"),
      S("ticket ka status"), S("indent ka status"), S("ticket status"), S("indent status"),
      S("टिकट कहाँ"), S("इंडेंट कहाँ"), S("मेरा सामान कहाँ"),
      W("kahan hai"), W("कहाँ है"), W("ticket"), W("indent"), W("टिकट"), W("इंडेंट"),
    ],
    notCues: ["stuck", "atke", "अटके", "red card", "mangwa", "मंगवा", "bhej", "भेज", "approve", "मंज़ूरी", "store mein", "स्टोर में"],
    answerKeys: ["copilot.answer.storesNoTicket", "copilot.answer.storesTicketWhere", "copilot.answer.storesTicketStuck", "copilot.answer.notPermitted"],
  },
  "stores.my_tickets": {
    cues: [
      S("my tickets"), S("our tickets"), S("my indents"), S("our indents"), S("open tickets"), S("open indents"), S("department tickets"),
      S("mere tickets"), S("mere indent"), S("hamare tickets"), S("hamare indent"),
      S("मेरे टिकट"), S("मेरे इंडेंट"), S("हमारे टिकट"), S("हमारे इंडेंट"), S("खुले इंडेंट"),
    ],
    notCues: ["stuck", "atke", "अटके"],
    answerKeys: ["copilot.answer.storesMyTickets", "copilot.answer.storesMyTicketsNone", "copilot.answer.storesNoShelf", "copilot.answer.notPermitted"],
  },
  "stores.waiting_for_me": {
    cues: [
      S("waiting for me"), S("what is waiting"), S("anything waiting"), S("pending with me"), S("on my plate"),
      S("to approve"), S("to pick"), S("to receive"), S("to carry"), S("approve karne"), S("uthane hain"), S("pahunchane hain"),
      S("mujhe kya karna"), S("mere zimme"), S("mere paas pending"),
      S("मुझे क्या करना"), S("मेरे ज़िम्मे"), S("मंज़ूरी के लिए"), S("मंजूरी के लिए"),
    ],
    notCues: ["stuck", "atke", "अटके"],
    answerKeys: ["copilot.answer.storesWaiting", "copilot.answer.storesWaitingNone", "copilot.answer.notPermitted"],
  },
  "stores.where_is_item": {
    cues: [
      S("in the store"), S("store mein"), S("स्टोर में"), S("on hand"), S("where do we have"), S("which store"),
      S("kis store"), S("किस स्टोर"), S("kitne pade"), S("kitna pada"), S("kahan pada"), S("kahan rakha"), S("कितने पड़े"), S("कहाँ रखा"),
    ],
    answerKeys: ["copilot.answer.storesNoItem", "copilot.answer.storesItemWhere", "copilot.answer.notPermitted"],
  },
  "stores.shelf_low": {
    cues: [
      S("low on my shelf"), S("which items are low"), S("what is low"), S("items low"), S("running low"), S("shelf low"),
      S("kya kam"), S("khatam hone"), S("shelf pe kya kam"),
      S("क्या कम"), S("ख़त्म होने"), S("खत्म होने"),
    ],
    answerKeys: ["copilot.answer.storesShelfLow", "copilot.answer.storesShelfLowNone", "copilot.answer.storesNoShelf", "copilot.answer.notPermitted"],
  },
  "stores.stuck": {
    cues: [
      S("red card"), S("red cards"), S("stuck tickets"), S("stuck indents"), S("tickets are stuck"), S("indents are stuck"), S("are stuck"),
      S("kitne atke"), S("atke hue"), S("atke hain"), S("kaun se atke"),
      S("अटके हुए"), S("कितने अटके"), S("अटके हैं"), S("रेड कार्ड"),
    ],
    answerKeys: ["copilot.answer.storesStuck", "copilot.answer.storesStuckNone"],
  },
  "stores.reorder": {
    cues: [
      S("reorder"), S("reorder my"), S("reorder the"), S("refill my shelf"), S("refill the shelf"), S("raise a ticket"), S("raise an indent"),
      S("mangwa do"), S("mangwao"), S("mangwa lo"), S("indent bhej"), S("indent bana"),
      S("मंगवा दो"), S("मंगवाओ"), S("मंगा दो"), S("इंडेंट भेज"), S("इंडेंट बना"),
    ],
    answerKeys: [
      "copilot.answer.storesNoShelf", "copilot.answer.storesReorderNone", "copilot.answer.storesReorderOpen", "copilot.answer.storesReorderPick",
      "copilot.answer.storesReorderSent", "copilot.answer.storesStateChanged", "copilot.answer.notPermitted",
    ],
  },
};
