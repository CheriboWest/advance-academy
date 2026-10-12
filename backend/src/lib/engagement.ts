import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure helpers for the reminder emails — no I/O, so node:test covers them.
 */

/** `YYYY-MM-DD` of a UTC instant. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Unsubscribe token for the reminder emails: HMAC of the user id, so the link
 * needs no stored token and can't be forged for someone else's id.
 */
export function unsubscribeToken(userId: string, secret: string): string {
  return createHmac('sha256', secret).update(`reminders:${userId}`).digest('base64url');
}

export function verifyUnsubscribeToken(userId: string, token: string, secret: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Server-only secret for unsubscribe tokens. Falls back to the service-role key, which is already secret. */
export function unsubscribeSecret(): string {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
