# Bulk company and contact import (migration 048)

Admins upload an Excel workbook or a CSV at **/coach/contacts/import**. They map
its columns, review every row, then import it into the existing `companies` and
`contacts` tables. No new company or contact table exists. The only new tables
are:

- `company_aliases`, for verified alternative names;
- `contact_import_batches` and `contact_import_rows`, for import history.

The import runs in four steps.

1. **Upload.** `POST /contacts/imports?filename=…` takes the file as the raw
   request body. The limits are:
   - 10 MB per file;
   - 150 MB uncompressed for an .xlsx;
   - 20 sheets;
   - 20,000 rows per sheet.

   Every non-blank row is stored with its raw cells (value, original type,
   display text and hyperlink) under its sheet row number. Uploading the same
   bytes again is flagged, using the SHA-256 of the file.
2. **Map.** A role is suggested for each column from its header and sample
   values. The admin can change any of them. The roles are:

   | Role | Meaning |
   |---|---|
   | `company_name` | The company's name |
   | `company_website` | The company's own site |
   | `contact` | A name; the cell's link, if valid, is the person's LinkedIn profile |
   | `contact_name` | A plain name |
   | `contact_linkedin_url` | A column of LinkedIn profile URLs |
   | `contact_job_title` | The person's role |
   | `phone` | Phone number |
   | `email` | Email address |
   | `source` | Job title, link or notes, kept as source information |
   | `ignore` | Not read |

   Each sheet also has two options:
   - **Grouping:** a blank company cell continues the company above it until a
     completely blank row.
   - **Link is website:** the company cell's link is the company's own site.

   For your workbook the suggestion is:
   - `JOB AGENCIES UK`: Company → company name, Link Job/Company → source,
     LinkedIn → contact, Phone → phone, Email → email; grouping on, link is
     website on.
   - `UK COMPANIES`: COMPANY → company name, JOB TITLE/LINK → source; both
     options off.
3. **Review.** Each row is classified **matched**, **new**, **needs review**,
   **invalid** or **skipped**, with its reasons and candidates. The admin
   decides needs-review rows: match a candidate (optionally saving the name as
   a verified alias), create, or skip. Undecided rows are skipped.
4. **Import.** `contact_import_commit` writes everything in **one transaction**.
   Every row's result and any errors are kept in the history.

## Rules

Extraction runs in `backend-python/app/contacts_import/mapping.py`, reusing
`clean.py` and `rows.py`.

- **Raw values are kept.** `contact_import_rows.raw` is never modified.
- **Nothing is guessed.**
  - After a completely blank row, a row with no company is **invalid**.
  - A company cell holding only a URL gives a website, never a name. Such a row
    can match an existing company by domain, but cannot create one.
- **Links must be valid.**
  - LinkedIn display text such as "Jane Doe | LinkedIn" is a name.
  - Text is a URL only if it is a valid http(s) URL.
  - Something like "linkedin.com/in/jane" is neither a URL nor a name; it
    becomes a contact error.
  - A link is a LinkedIn profile only if it points to `linkedin.com/in/…`.
- **Job titles and links are source information.**
  - They are stored on the import row, never turned into a job or a contact
    field.
  - A real URL that equals an existing `jobs.source_url` is linked
    (`source_job_id`).
  - No job is ever created (the old one-off CLI created `manual_import_xlsx`
    jobs; the wizard does not).
- **Unusable contact data** (two people in one cell, no usable email, phone or
  profile) does not lose the company. The row needs review until the admin
  leaves the contact out.

## Matching

Matching runs in SQL, in `contact_import_classify`, through the `ci_norm_*`
normalizers. The preview and the commit therefore use the same rules.

**Companies.** These keys must agree on **one** company:

- website domain, excluding job boards, social sites and webmail
  (`ci_generic_domain`);
- exact normalized name (case, punctuation, whitespace and `&`/`and`; legal
  suffixes are kept);
- verified alias.

These cases go to **needs review**:

- the keys point at different companies, or more than one company;
- only the looser slug matches, for example "Gamma UK" against "Gamma Group".
  Such a company can't be created anyway, because the slug is unique.

Rows in the same file that name the same new company create it once.

**Contacts.** Matching is tried in this order:

1. Email.
2. LinkedIn profile, normalized so `uk.`, `www.`, case and a trailing slash
   don't matter.
3. Company + name + phone. UK numbers are normalized, so `+44 (0)20…` and
   `020…` are equal.

These cases go to **needs review**:

- an email or profile that belongs to a contact at another company;
- several contacts sharing that email or profile;
- the same name at the company without a confirming phone number.

Repeats inside the file (same email, profile, or company + name + phone)
resolve to one contact.

**Filling fields.** A matched company or contact only has *empty* fields filled:

- contacts: `job_title`, `email`, `phone`, `linkedin_url`, and `notes` only
  from real source notes;
- companies: `website` and `canonical_domain`.

A differing value is reported as a **conflict** and left as it was. Names are
never changed.

## Safety

- **One commit at a time.** The commit runs under an advisory lock and
  re-classifies inside its own transaction. Two admins importing overlapping
  files create each company and contact once
  (`048_contact_import_concurrency.test.sh`).
- **All or nothing.** If any row fails, every write is rolled back:
  - the failing rows get `result_status = 'failed'` and their error;
  - the other rows get `rolled_back`;
  - the batch gets `failed`.

  It can be committed again after the admin fixes or skips those rows.
- **Repeat imports.** Importing the same file again creates nothing.
- **Admins only.** The API depends on `get_current_user`, which is
  backend-python's admin gate (`users.is_admin` or `ADMIN_USER_IDS`), and
  `/coach/*` pages are gated the same way.
  - History is shared by all admins.
  - Changing or committing a batch is limited to its uploader. This is checked
    in the router and again in `contact_import_commit`.
- **Database privileges.** The new tables and the classify and commit
  functions are service_role only (RLS on; revoked from anon and
  authenticated).
- **Company deletion keeps working.** `company_aliases` is on
  `delete_companies_permanently`'s allowlist (on delete cascade). The staging
  tables hold company and contact ids without foreign keys, so permanent
  company deletion keeps working and history outlives a deleted company.

## Rollout

1. **Staging first.** Apply `supabase/migrations/048_contact_import.sql` in the
   SQL editor.
   - It depends on 001–046 (047 is not required) and can be re-run.
   - It adds seven expression indexes on `companies` and `contacts`. Creating
     them briefly locks writes to those tables, so apply outside busy hours.
2. **Check RLS.** This should return 0 rows:
   `select tablename from pg_tables where schemaname='public' and rowsecurity=false;`
3. **Deploy.** Deploy backend-python, then the frontend.
4. **Dry run.** Import your workbook on staging and review the preview before
   committing.

To undo:

- drop the two functions `contact_import_commit` and `contact_import_classify`;
- drop the tables `contact_import_rows`, `contact_import_batches` and
  `company_aliases`;
- drop the seven `*_ci_*` indexes and the `ci_*` functions;
- re-apply 039 to restore the delete function's previous allowlist.

Companies and contacts created by an import stay; each new contact's notes say
which file and row it came from.

## Tests

Run `PGHOST=127.0.0.1 PGPORT=<port> supabase/tests/run_local.sh`. Its 048 parts
are:

- `048_contact_import.test.sql`: classification, decisions, commit, fill-only
  merging, conflicts, aliases, re-import, rollback, partial rows, privileges
  and the delete guard.
- `048_contact_import_concurrency.test.sh`: two simultaneous commits of
  overlapping files.

The `backend-python` self-checks run with
`for f in test_*.py; do .venv/bin/python $f; done`:

- `test_contact_import_wizard.py`: parsing, raw preservation, suggested
  mapping, blank-row grouping, LinkedIn and URL rules, source info, CSV, limits.
- `test_contact_imports_routes.py`: the real auth gate (401, 403 for
  non-admins, 403 for another admin's batch), upload validation, decisions,
  and commit error mapping.
- `test_contact_import_e2e.py`: the whole flow through PostgREST against a
  scratch database, including a re-import. It is skipped unless
  `CONTACT_IMPORT_E2E_SUPABASE_URL` and `CONTACT_IMPORT_E2E_SERVICE_KEY` are
  set.

The frontend tests run with `npm test`:

- `features/career-hub/lib/contact-import.test.ts`
- `features/career-hub/components/coach/contact-import-preview.test.tsx`
