/**
 * Package root.
 *
 * The `.js` specifiers below are what the backend's NodeNext resolution
 * requires, and they are also why importing a *value* from this root breaks the
 * Next.js build — Turbopack resolves them literally, finds no `coaching.js`,
 * and fails the whole page. `import type` from here is safe because types are
 * erased before the bundler ever looks.
 *
 * So, from frontend code: import values from the subpath entry
 * (`@advance-academy/contracts/leads`), not from here.
 */
export * from './admin-person.js'
export * from './coaching.js'
export * from './contacts.js'
export * from './cover-letter.js'
export * from './cv-optimizer.js'
export * from './engagement.js'
export * from './gamification.js'
export * from './job-tracking.js'
export * from './jobs.js'
export * from './leads.js'
