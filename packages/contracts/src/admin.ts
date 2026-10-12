// Admin user management (sprint F4).
// The shapes GET/PATCH /api/admin/users send; the backend imports these too.

export type Tier = 'trial' | 'membership'

/** Approval gate (migration 018). Only 'approved' accounts get past the backend. */
export type UserStatus = 'pending' | 'approved' | 'rejected'

export interface AdminUserRow {
  id: string
  email: string | null
  full_name: string | null
  status: UserStatus
  tier: Tier
  is_admin: boolean
  credit_balance: number
  /** Coaching sessions left — a quota separate from the credit wallet. */
  coaching_credits: number
  referral_count: number
  /** Null until the account spends credits on a tool for the first time. */
  first_tool_used_at: string | null
  /** Null until an admin approves or rejects the account. */
  reviewed_at: string | null
  created_at: string
  /*
   * Engagement, derived per request by the user_engagement RPC (migration 021)
   * rather than stored on the row. `first_tool_used_at` above answers only
   * "ever?"; these answer "how much, and how recently?", which is what decides
   * whether an account is worth a coach's hour.
   */
  /** Newest tool run, interview or coaching booking. Null = has done nothing. */
  last_active_at: string | null
  /** Events in the last 30 days. Zero is a real answer, not "unknown". */
  events_30d: number
  total_events: number
}

export interface AdminUsersListResponse {
  users: AdminUserRow[]
  count: number
}

export interface AdminUsersFilters {
  search?: string
  tier?: string
  status?: string
  limit?: number
}

/** PATCH body. Every field optional — send only what changes. */
export interface AdminUserPatch {
  /** Approval decision. 'pending' is the DB default, not something an admin sets. */
  status?: Exclude<UserStatus, 'pending'>
  tier?: Tier
  /** Signed change to the wallet, e.g. +5 or -2. */
  creditDelta?: number
  /** Signed change to the coaching quota, e.g. +1 to grant another session. */
  coachingDelta?: number
  isAdmin?: boolean
}

export interface AdminUserPatchResponse {
  user: AdminUserRow
}
