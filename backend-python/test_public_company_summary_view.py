"""Regression test for "column public_company_summary.ai_summary does not
exist": `python test_public_company_summary_view.py` (no pytest, no network,
no live database).

The bug wasn't a mismatch between the frontend query and the migration
files — features/career-hub/lib/coach.ts's SPONSORED_COMPANY_COLUMNS and migration
0013's view definition already agreed (see 0014_repair_company_summary_view
.sql's header comment for the full root-cause writeup); the live database
had simply never had 0013 applied. This test can't reach across into a live
Supabase project to check that — no test in this repo can — but it CAN make
the class of bug that would show up this way impossible to ship silently:
every column any frontend query selects from `public_company_summary` is
checked here against the column list the migrations actually define for
that view, taking the LAST `create or replace view` in migration order —
exactly the view a freshly-migrated database would end up with. A future
migration that quietly drops a column a query still selects, or a query
added for a column no migration has defined yet, fails this test instead of
becoming a live "does not exist" error.
"""

from __future__ import annotations

import re
from repo_paths import CAREERHUB_DIR, MIGRATIONS_DIR

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


WEB_LIB = CAREERHUB_DIR / "lib"

VIEW_NAME = "public_company_summary"


# ---------------------------------------------------------------------------
# 1. Determine the view's effective column list: the LAST
#    `create or replace view public.public_company_summary` across every
#    migration, in filename (== apply) order — the same one a database with
#    every migration applied, in order, would actually have.
# ---------------------------------------------------------------------------

_VIEW_RE = re.compile(
    r"create\s+or\s+replace\s+view\s+public\." + VIEW_NAME + r"\s+as\s+select(.*?)from\s+public\.companies",
    re.IGNORECASE | re.DOTALL,
)


def _split_top_level_commas(text: str) -> list[str]:
    """Comma-splits a SELECT column list without splitting inside a
    function call's parens (e.g. `count(j.*) filter (where j.is_active)`)."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current))
    return parts


def _column_alias(column_expr: str) -> str:
    """The name this column is exposed as: the part after `as`, or the
    identifier itself for a bare `c.column_name`."""
    expr = column_expr.strip()
    match = re.search(r"\bas\s+(\w+)\s*$", expr, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.match(r"^c\.(\w+)$", expr)
    if match:
        return match.group(1)
    return expr


def all_view_definitions() -> list[tuple[Path, list[str]]]:
    """Every `create or replace view public.public_company_summary`, in
    migration (== apply) order, as its ordered column list — order matters
    here, not just membership (see the ordering check below)."""
    definitions: list[tuple[Path, list[str]]] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        for match in _VIEW_RE.finditer(path.read_text()):
            columns = [
                _column_alias(part)
                for part in _split_top_level_commas(match.group(1))
                if part.strip()
            ]
            definitions.append((path, columns))
    return definitions


VIEW_DEFINITIONS = all_view_definitions()
assert VIEW_DEFINITIONS, (
    f"No `create or replace view public.{VIEW_NAME}` found in any migration "
    f"under {MIGRATIONS_DIR} — the view itself may have been dropped."
)
DEFINING_MIGRATION, _last_columns = VIEW_DEFINITIONS[-1]
VIEW_COLUMNS = set(_last_columns)


# ---------------------------------------------------------------------------
# 1b. Postgres's real constraint on `create or replace view`: a new
#     definition may only APPEND columns at the end of the list — it cannot
#     insert, rename, or reorder any column an earlier definition already
#     had, or the live database rejects it outright (the exact live error
#     that prompted this migration's column order to be fixed:
#     `ERROR 42P16: cannot change name of view column "open_jobs" to
#     "ai_summary"`, from inserting two new columns before it instead of
#     after). Checked here as an ordered-prefix relationship between every
#     consecutive pair of view definitions, so a future migration that
#     repeats this mistake fails before anyone tries to run it live.
# ---------------------------------------------------------------------------

for (prev_path, prev_columns), (curr_path, curr_columns) in zip(
    VIEW_DEFINITIONS, VIEW_DEFINITIONS[1:]
):
    check(
        f"{curr_path.name} only appends to {prev_path.name}'s view columns "
        f"(never inserts, renames, or reorders — Postgres rejects that live)",
        curr_columns[: len(prev_columns)] == prev_columns,
        f"{prev_path.name}: {prev_columns}  ->  {curr_path.name}: {curr_columns}",
    )

check(
    f"a create-or-replace-view for {VIEW_NAME} exists in the migrations",
    bool(VIEW_COLUMNS),
    f"(none found under {MIGRATIONS_DIR})",
)
check(
    "the effective (last-defined) view includes ai_summary",
    "ai_summary" in VIEW_COLUMNS,
    f"columns found: {sorted(VIEW_COLUMNS)} from {DEFINING_MIGRATION.name}",
)
check(
    "the effective view still includes every column present before migration "
    "0013 (additive, nothing dropped)",
    {
        "id", "slug", "name", "website", "careers_url", "sector", "region",
        "hq_location", "lead_score", "open_jobs",
    }
    <= VIEW_COLUMNS,
    f"columns found: {sorted(VIEW_COLUMNS)}",
)
print(f"    effective view (per {DEFINING_MIGRATION.name}): {sorted(VIEW_COLUMNS)}")


# ---------------------------------------------------------------------------
# 2. Every frontend query against `public_company_summary` — resolved from
#    either an inline string literal or a named `const X = "...";` in the
#    same file — must select only columns the view above actually exposes.
# ---------------------------------------------------------------------------


def _resolve_select_arg(source: str, raw_arg: str) -> list[str] | None:
    """Returns the column list a `.select(...)` call requests, or None if
    the argument isn't a plain column-list string this check understands
    (e.g. `"*"`, or something too dynamic to statically resolve)."""
    raw_arg = raw_arg.strip()

    literal_match = re.match(r'^"([^"]*)"$', raw_arg) or re.match(r"^'([^']*)'$", raw_arg)
    if literal_match:
        value = literal_match.group(1)
    else:
        identifier_match = re.match(r"^(\w+)$", raw_arg)
        if not identifier_match:
            return None
        const_match = re.search(
            rf'const\s+{re.escape(identifier_match.group(1))}\s*=\s*"([^"]*)"', source
        )
        if not const_match:
            return None
        value = const_match.group(1)

    if value.strip() == "*":
        return None
    return [c.strip() for c in value.split(",") if c.strip()]


# One call site per `.from("public_company_summary")...select(<arg>` — the
# select may be on the same line or (per this codebase's formatting) the
# next, so this searches a bounded window after each `.from(...)` match
# rather than requiring them on one line. The argument itself is captured
# as a whole quoted string (which may contain commas, e.g.
# "id, slug, name, ...") or a bare identifier — not `[^,)]+`, which would
# truncate at the first comma *inside* a multi-column string literal and
# silently fail to resolve it below instead of checking it.
_FROM_THEN_SELECT_RE = re.compile(
    r'\.from\(\s*"' + VIEW_NAME + r'"\s*\)[\s\S]{0,60}?\.select\(\s*("[^"]*"|\'[^\']*\'|\w+)',
)

CHECKED_FILES = ["queries.ts", "role-search.ts", "coach.ts"]
call_sites_checked = 0

for filename in CHECKED_FILES:
    path = WEB_LIB / filename
    source = path.read_text()
    matches = list(_FROM_THEN_SELECT_RE.finditer(source))
    check(f"{filename}: at least one public_company_summary query found", bool(matches))

    for match in matches:
        line_no = source[: match.start()].count("\n") + 1
        columns = _resolve_select_arg(source, match.group(1))
        if columns is None:
            continue  # "*" or a form this static check doesn't resolve
        call_sites_checked += 1
        missing = [c for c in columns if c not in VIEW_COLUMNS]
        check(
            f"{filename}:{line_no} selects only columns the view defines",
            not missing,
            f"requests {missing} — not in {sorted(VIEW_COLUMNS)}",
        )

check("at least one column-list select was actually resolved and checked", call_sites_checked > 0)


print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL PUBLIC_COMPANY_SUMMARY VIEW CHECKS PASSED")
