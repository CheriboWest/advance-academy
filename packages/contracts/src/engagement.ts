/**
 * Reminder emails (App 1): a follow-up reminder on the day a tracked job's
 * follow-up falls due. Weekly goals and points live in gamification (047).
 */

/** GET /api/engagement */
export interface EngagementResponse {
  emailReminders: boolean
}

/** PATCH /api/engagement */
export interface UpdateEngagementSettingsRequest {
  emailReminders: boolean
}
