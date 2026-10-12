import type { EngagementResponse } from '@advance-academy/contracts/engagement';
import { getSupabase } from '../lib/supabase.js';

/**
 * The email-reminder switch. Weekly goals and points moved to gamification
 * (migration 047); `points_ledger` (045) is kept as history only.
 */

function dbError(action: string, error: { message?: string } | null): Error {
  return Object.assign(new Error(`Failed to ${action}: ${error?.message ?? 'unknown error'}`), { statusCode: 500 });
}

export async function getEngagement(userId: string): Promise<EngagementResponse> {
  const { data, error } = await getSupabase().from('users').select('email_reminders').eq('id', userId).maybeSingle();
  if (error) throw dbError('load settings', error);
  return { emailReminders: (data as { email_reminders?: boolean } | null)?.email_reminders ?? true };
}

export async function setEmailReminders(userId: string, enabled: boolean): Promise<void> {
  const { error } = await getSupabase().from('users').update({ email_reminders: enabled }).eq('id', userId);
  if (error) throw dbError('update email reminders', error);
}
