export { rosterManifest } from "./manifest";
export { RosterModule } from "./roster.module";
export { ROSTER_ERROR_CODES, ROSTER_ERROR_SENTENCES, RosterError, rosterHttpStatus } from "./errors";
export type { RosterErrorCode } from "./errors";
export {
  ROSTER_ACTS, ROSTER_ACTOR_KINDS, ROSTER_MANAGE, ROSTER_PERMISSIONS, ROSTER_PUBLISH, ROSTER_READ,
  ROSTER_VIAS, rosterActMatrix, rosterActPolicy,
} from "./policy";
export type { RosterAct, RosterActorKind, RosterPermission, RosterVia } from "./policy";
export { requireRosterAct } from "./access";
export type { RosterScope } from "./access";
export {
  ORG_DEPARTMENTS, ROSTER_POSITIONS, listOrgDepartments, listRosterPositions, orgDepartmentByCode,
  rosterMasterCounts, seedOrgDepartments, seedRosterPositions,
} from "./masters";
export type {
  OrgDepartmentRow, OrgDepartmentSeed, RosterPositionRow, RosterPositionSeed, SeedCount,
} from "./masters";
export {
  ROSTER_EVENTS, rosterAmendmentApplied, rosterDutyChanged, rosterPeriodDrafted,
  rosterPeriodPublished, rosterPeriodSuperseded,
} from "./events";
export {
  MAX_PRESENCE_HOURS, amend, asKnownAt, assign, contentHash, draftPeriod, effectiveDrift,
  periodWithAssignments, publishedPeriodCount,
  periodsTouching, presenceClashes, publishPeriod, publishPeriods, unassign,
} from "./periods";
export type {
  AmendInput, AssignInput, DraftPeriodInput, PresenceClash, PublishRequest, PublishResult,
  RosterAmendmentRow, RosterAssignmentRow, RosterPeriodRow, RosterScopeRef,
} from "./periods";
export {
  UNIT_COUNT, UNIT_ESTABLISHMENT, closeTeam, confirmTeam, createTeam, listTeams, nightPoolFor,
  seedUnits, teamByCode, teamMembers, unconfirmedTeams,
} from "./teams";
export type { CreateTeamInput, RosterTeamRow, TeamMember } from "./teams";
export {
  addMembership, endMembership, importMemberships, membershipsOf, parentTeamOf,
} from "./memberships";
export type {
  AddMembershipInput, ImportProblem, MembershipImportRow, RosterMembershipRow,
} from "./memberships";
export { endOfficiating, officiatingAt, recordOfficiating } from "./officiating";
export type { OfficiatingInput, RosterOfficiatingRow } from "./officiating";
export { AUTHORITY_PERMISSION, delegationsInForce, recordDelegation } from "./delegations";
export type { DelegationInput, RosterDelegationRow } from "./delegations";
export {
  CRMI_LEAVE_DAYS, CRMI_TABLE, CRMI_TOTAL_WEEKS, MAX_BLOCK_WEEKS, crmiBlocks, crmiWeeksTotal,
  extensionPostings, internYear, splitBlock,
} from "./interns";
export type { CrmiBlock, InternAbsence, InternPosting, InternYearInput } from "./interns";
export {
  absentUserIds, approveAbsence, attendanceProjection, cancelAbsence, listAbsences,
  markAebasEntered, recordAbsence, recordAbsenceUnchecked, recordAbsences, redactReason,
  rejectAbsence, requestAbsence,
} from "./absences";
export type {
  AbsenceQuery, AttendanceProjection, RequestAbsenceInput, StaffAbsenceRow,
} from "./absences";
export {
  credentialsOf, expiringCredentials, holdsCredential, recordCredential, verifyCredential,
} from "./credentials";
export type { RecordCredentialInput, StaffCredentialRow } from "./credentials";
export { rosterAbsenceApproved, rosterAbsenceRequested } from "./events";
export {
  LOOK_BACK_DAYS, ROSTER_RESOLVER_FLAG, calloutList, dutiesOf, onDutyNow, resolverEnabled,
  whoIsAt, whoIsOn,
} from "./resolve";
export type {
  CallRung, Duty, OnDutyNow, RosterAnswerSource, WhoIsOnAnswer, WhoIsOnQuery,
} from "./resolve";
export {
  escalationRecipients, escalationTarget, listEscalationTargets, setEscalationTarget,
} from "./escalation";
export type {
  EscalationContext, EscalationRecipients, RosterEscalationTargetRow, SetEscalationTargetInput,
} from "./escalation";
export {
  HORIZON_DAYS, SHORT_OPD_MINUTES, addIstDays, backupUnit, declareHoliday,
  departmentsWithTakeGaps, expandCycle, extendWindows, istMidnightUtc, istWeekday,
  materialiseWindows, publishCycle, publishedCycleCount, sweepRosterWindows, takeGaps,
  unitOnTake,
} from "./calendar";
export type {
  CycleEntrySpec, CycleSpec, DeclareHolidayInput, HolidaySpec, OnTakeAnswer, OverlayEntrySpec,
  PlannedWindow, PublishCycleResult, WindowGap,
} from "./calendar";
export { CYCLE_TEMPLATES, cycleTemplate, draftCycleFromTemplate } from "./templates";
export type { CycleTemplate } from "./templates";
export { istDateOfInstant, istMinutesOfInstant } from "./calendar";
// PHASE R (R8) — whether a roster is any good.
export {
  BLOCKING_RULE_KEYS, ROSTER_RULES, ROSTER_RULE_COUNT, rulesInForce, seedRosterRules,
} from "./rules";
export type { EffectiveRule, RosterRuleSeed } from "./rules";
export { blockingFindings, findingKey, templateFeasibility, validate } from "./validator";
export type {
  Feasibility, FeasibilityInput, HypotheticalRoster, RosterFinding, ValidateInput,
} from "./validator";
export {
  PROPOSAL_DAY_OF_MONTH, PROPOSAL_STRATEGIES, PROPOSER_ACTOR, fairnessOf, fairnessSpread,
  proposeMonth, runMonthlyProposals,
} from "./proposer";
export type {
  FairnessCounters, ProposalResult, ProposalStrategy, ProposeMonthInput,
} from "./proposer";
export { hoursCarried, simulate } from "./simulate";
export type { Exclusion, SimulateDelta, SimulateOptions, SimulateResult } from "./simulate";
export {
  acceptFinding, acceptedFindingKeys, asFinding, listFindings, recordFindings,
} from "./findings";
export type { RosterFindingRow } from "./findings";
export {
  declareSkeletonMode, modeDeclarations, skeletonModeOn, withdrawSkeletonMode,
} from "./modes";
export type { DeclareModeInput, RosterModeDeclarationRow } from "./modes";
