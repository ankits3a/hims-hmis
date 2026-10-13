/**
 * THE cross-module interface of the passes module (E1.3, #720): attendant and visitor passes per admission, the scan
 * at a ward door, the lost-pass reissue, and the expiry of every pass when the stay ends.
 */
export { passesManifest, PASSES_ISSUE, PASSES_MANAGE, PASSES_PAUSE, PASSES_SCAN } from "./manifest";
export { PassesModule } from "./passes.module";
export { PASSES_ADMISSION_CONSUMER, passesAdmissionConsumer } from "./consumer";
export { PassForbidden, PassRefusal, passRefusalStatus } from "./errors";
export {
  PASSES_SYSTEM_ACTOR, expireAdmissionPasses, issuePasses, issueVisitorPass, movePassesToCurrentWard, newPassToken,
  pausePasses, reissuePass, resumePasses, setPoliceCustody,
} from "./passes";
export { listPassWards, scanPass, viewAdmissionPasses } from "./read";
export { PASS_CHILD_AGE_YEARS, PASS_CRITICAL_CLASSES, entitlementFor, inVisitingHours, scanResult } from "./policy";
