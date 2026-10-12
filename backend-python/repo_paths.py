"""Where the rest of the repo sits, as seen from this service.

Several self-checks here assert *agreement* between the FastAPI layer and the
web and migration layers — that a route the API exposes has a client calling it,
that a column the code reads exists in a migration. That makes them the tests
most sensitive to the tree moving, and the career-hub merge moved it twice:
`apps/api` -> `backend-python`, and `careerhub/apps/web` -> the merged Next app.

Each test used to derive its own root with `Path(__file__).resolve().parents[2]`,
which silently became wrong the moment this directory changed depth — six tests
failing with "file not found" for a file that had simply moved. Defining the
layout in one place means the next move edits this file, not six.

ponytail: three constants, no path-resolution helper. Add one when a caller
needs something these don't already give it.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Next.js routes. career-hub's pages now live here too (app/search,
#: app/companies, app/coach) after Stage 4 folded its app into this one.
APP_DIR = REPO_ROOT / "app"

#: career-hub's non-route web code — the `lib/` clients this service is the
#: other half of, and its components. Stage 4 moved these out of the old
#: apps/web and under this app's feature convention.
CAREERHUB_DIR = REPO_ROOT / "features" / "career-hub"

#: This service.
API_ROOT = REPO_ROOT / "backend-python"

#: All migrations, both sides. career-hub's 0001-0015 were renumbered into
#: AdvanceAcademyTools' sequence as 024_ch0001_* .. 038_ch0015_*, keeping the
#: original number in the name so the "requires migration 0009" notes inside
#: those files still resolve (grep ch0009).
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"
