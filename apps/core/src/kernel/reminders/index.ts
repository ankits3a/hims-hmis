/** E1.2 — personal reminders. The copilot act (E2.3) calls `createReminder` from here, after its one confirm. */
export {
  PERSONAL_REMINDER_KIND, REMINDER_REF_TYPE, RemindersError, activeReminderCount, cancelReminder, createReminder, createReminderBody,
  createReminderIn,
  listReminders, reminderKey, runDueReminders,
} from "./reminders";
export type { CreateReminderInput, RemindersErrorCode } from "./reminders";
