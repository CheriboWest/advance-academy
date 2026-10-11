# Gamification v2 (migration 047)

Rewards for things a student verifiably did: saving a job, tailoring a CV to it,
writing a cover letter, applying, following up, practising answers, finishing a
mock interview, researching a company. Streaks, daily quests, a weekly
challenge, achievements and Career Coins (earn-only, never credits) are built
on those rewards.

It ships dark. Migration 047 only adds things, and nothing reads them until the
backend runs with `GAMIFICATION_V2_ENABLED=true`. Migration 045's weekly tasks
and points stay as they are, as history.

## How a reward happens

1. **Capture.** AFTER triggers on the source tables write one row to
   `reward_intents` in the same transaction as the action, so an action that
   commits always has its intent. The row holds a snapshot of the facts needed
   to judge it, so judging never reads live state.

   | Intent | Captured when | Snapshot |
   |---|---|---|
   | `job_saved` | A card gets a URL (on insert, or when its `url_key` changes) | card, URL key |
   | `application` | A `job_events` row with `to_status = 'applied'` | URL key, the best completed CV run's JD length, whether a letter came first, whether a follow-up date is set |
   | `follow_up` | A `follow_up` event | event time, first application time |
   | `milestone` | An `interview` / `offer` event | status |
   | `cv_tailor` | A CV run linked to a card (`saved_job_id`) completes | card status, JD length |
   | `cover_letter` | `record_cover_letter` sets a new run id on the card | card status at write |
   | `answer_practice` | An `answer_assessments` row | session, question fingerprint |
   | `mock_complete` | A session first reaches `complete` | distinct questions answered |
   | `company_research` | A Dream Company `tool_results` row | — |

2. **Process.** `process_reward_intents(user)` judges a user's pending intents
   in `seq` order and writes the decision, XP, streak, quest, achievement and
   coin rows. Each intent is judged in its own subtransaction.
   - A per-user advisory lock (`4711, hashtext(user_id)`), also taken by
     capture, orders it against captures still in flight.
   - It must run in READ COMMITTED.
   - `seq` can have gaps after rollbacks, and nothing relies on it being
     contiguous.
3. **Nothing is awarded for reading a page.** The backend calls the processor
   from the summary endpoint, but the processor only judges what was captured.

### Decisions are final

- `reward_decisions` holds one immutable first decision per
  (user, kind, subject).
- For card-based kinds (save, application, CV, letter), the card's first
  decision locks the card, whatever the outcome. Every later intent for that
  card goes to `reward_audit` as `duplicate:card_locked`.
- A granted or capped save or application also locks its URL:
  - another card with a rewarded save URL is audited `url_locked`, and the card
    stays free to earn for a different URL;
  - an application to an already-rewarded URL is `ineligible:url_already_rewarded`.
- A CV run with a thin job description (under `jd_thin_chars`, 400) is audit-only
  (`insufficient:thin_jd`). It does not lock the card, so a later full run can
  still earn.
- Daily caps per kind come from `gamification_config.caps`. A capped decision
  earns no XP, but it still locks and still counts towards tier achievements.

### Application tiers

The tier is judged from the snapshot taken at submission.

| Tier | Rule | XP |
|---|---|---|
| Quick | Anything else | 5 |
| Quality | A completed CV run for this card with a JD of at least 400 characters | 15 |
| Power | Quality, plus a cover letter before submitting, plus a follow-up date after it | 25 |

Prep XP stacks on top: save +2, CV tailor +10, cover letter +5.

### Config

- `gamification_config` is versioned. Every intent records the version it was
  captured under, so changing the numbers never re-judges past actions.
- Version 1's values are **proposed and awaiting product sign-off**.
- To change them, insert version 2. Don't update version 1.

## Privilege model

Source tables keep RLS on with no policies for `anon` / `authenticated`, as
before. The API roles never touch a gamification table directly.

### Owner roles

Four `NOLOGIN NOBYPASSRLS NOINHERIT` roles own the `SECURITY DEFINER`
functions:

| Role | Owns | Can touch |
|---|---|---|
| `gamification_capture` | `enqueue_reward_intent`, the six `trg_*_capture` functions | Insert intents. Read exactly the snapshot columns of the source tables |
| `gamification_processor` | `process_reward_intents`, `gam_decide`, `apply_coin_transaction`, `ensure_daily_quests`, `book_rest_day`, helpers | Only the gamification tables |
| `gamification_cover_letter_writer` | `record_cover_letter`, `charge_credits` | The card's letter columns and status, a `preparing` event, `users.credit_balance` |
| `gamification_admin` | `skip_reward_intent` | Move a `stuck` intent to `skipped`, plus its audit row and an `admin_actions` row |

### Rules every function follows

- Each role has column-level grants and one RLS policy per (table, command, role).
- Every definer function pins `search_path = pg_catalog, pg_temp` and
  schema-qualifies every object.

### What `service_role` can do

- **Read:** every gamification table.
- **Write:**
  - `user_goal_settings`: timezone, intensity, goal type, timeline;
  - `user_achievements.seen_at`.
- **EXECUTE:** only these eight functions: `create_saved_job`,
  `change_job_status`, `record_cover_letter`, `charge_credits`,
  `process_reward_intents`, `ensure_daily_quests`, `book_rest_day`,
  `skip_reward_intent`.
- **Grants left alone:** 047 revokes and grants only on functions it creates.
  Existing RPCs keep their grants. These include `match_bullets`,
  `user_engagement`, the sponsor-register functions and 046's job-expiry
  functions.

### Guards (`SECURITY INVOKER`, so they see the real role)

- **G1:** a CV run may point only at its own user's card, and `saved_job_id`
  never changes afterwards. There is no FK, so the link survives the card being
  deleted.
- **G2:** only `record_cover_letter` may set the cover-letter marker
  (`cover_letter_run_id` / `cover_letter_generated_at`). This is checked with
  `current_user`, not a setting a caller could forge. The letter text itself
  stays freely editable.
- **G3:** the timezone must be a valid IANA zone and can change at most once
  per 24 hours. Even the table owner cannot backdate `timezone_changed_at`.

### Hosted Supabase

`postgres` is not a superuser there, so the migration does two things:

- It makes `postgres` a member of the owner roles (`INHERIT TRUE, SET TRUE`), so
  it can hand functions over and re-run the file.
- It grants the owner roles `CREATE` on `public` only for the ownership
  hand-over, then revokes it.

A superuser migration owner gets neither.

## Errors the backend maps

| Code | Meaning | HTTP |
|---|---|---|
| `GC001` | Credits exhausted | 429 |
| `GN001` | Card not found for this user | 404 |
| `GN002` | Intent is not stuck (admin skip) | 409 |
| `GX001`–`GX006` | Invariant broken: a missing policy or grant, an unexpected row count, a wrong isolation level | 500 |
| `42501` | Privilege or RLS failure | 500 |

## Retries

- When judging an intent fails, its `attempts` count goes up and
  `next_attempt_at` backs off: 1, 2, 4… minutes, capped at one hour.
- Later intents for that user wait behind it (head-of-line).
- After `max_attempts` (10) the intent becomes `stuck`, and the queue stays
  blocked until an admin calls `skip_reward_intent`. That call needs:
  - `users.is_admin`, re-checked in SQL;
  - a reason of at least 10 characters.
- A skip writes the audit row and the `admin_actions` row.

## Rollout

1. **Staging first.** Apply `supabase/migrations/047_gamification.sql` in the
   SQL editor. It depends on 001–046 and can be re-run.
2. **Check RLS.** This should return 0 rows:
   `select tablename from pg_tables where schemaname='public' and rowsecurity=false;`
3. **Check the API roles can't reach the owner roles.** This should also return
   0 rows:
   `select r.rolname, g.rolname from pg_roles r, pg_roles g where g.rolname like 'gamification\_%' and r.rolname in ('anon','authenticated','service_role','authenticator') and pg_has_role(r.oid, g.oid, 'MEMBER');`
4. **Deploy the backend with the flag off.** Behaviour is unchanged. Capture
   starts at once, though, because the triggers fire on every insert. Intents
   pile up harmlessly until the flag is turned on.
5. **Turn on `GAMIFICATION_V2_ENABLED=true`** on staging, then production.

To undo the user-facing part, turn the flag off. Removing the schema means
dropping the triggers, functions and tables 047 created, plus the three added
columns. The owner roles can be dropped once they own nothing.

## Tests

Run the whole suite on a local scratch cluster (Postgres 16 with pgvector):

```bash
PGHOST=127.0.0.1 PGPORT=54340 supabase/tests/run_local.sh
```

`run_local.sh` does the following:

1. Loads the Supabase stand-ins from `supabase/tests/support/`.
2. Applies every migration as the non-superuser `postgres`.
3. Re-applies 046 and 047.
4. Runs `046_job_expiry.test.sql` and `047_gamification.test.sql`. Each runs in
   one transaction that is rolled back.
5. Runs `047_gamification_concurrency.test.sh`, which uses two sessions for:
   - racing credit charges;
   - the READ COMMITTED guard;
   - capture-versus-processor ordering;
   - the real `authenticator` SET ROLE probe.

To check the superuser path too, run with `MIGRATION_ROLE=supabase_admin`.
Roles are cluster-wide, so use a fresh cluster for that run.
