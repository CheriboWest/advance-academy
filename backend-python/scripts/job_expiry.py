#!/usr/bin/env python3
"""Close expired jobs and report (or close) stale ones — migration 046.

    # Close every job whose stated closing date has passed (safe any time;
    # the crawler also does this after every crawl)
    python scripts/job_expiry.py expired

    # Which crawled searches still lack enough evidence, per source
    python scripts/job_expiry.py coverage

    # Stale jobs: a REPORT by default — closes nothing
    python scripts/job_expiry.py stale
    python scripts/job_expiry.py stale --include-legacy --source adzuna

    # Actually close them. The database refuses unless every crawled search has
    # enough successful fetches for every --source; see docs/JOB_EXPIRY.md.
    python scripts/job_expiry.py stale --apply

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Prints the database's own
JSON summary. Exit code 1 if the database refused or failed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.crawler.supabase_rest import SupabaseRest  # noqa: E402

DEFAULT_SOURCES = ["adzuna", "reed"]


def _staleness_args(args: argparse.Namespace) -> dict:
    return {
        "p_unseen": f"{args.unseen_days} days",
        "p_min_age": f"{args.min_age_days} days",
        "p_min_fetches": args.min_fetches,
        "p_min_span": f"{args.min_span_days} days",
        "p_sources": args.source or DEFAULT_SOURCES,
    }


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2
    rest = SupabaseRest(settings.supabase_url, settings.supabase_service_role_key)

    async with httpx.AsyncClient() as client:
        try:
            if args.command == "expired":
                closed = await rest.rpc(client, "close_expired_jobs")
                print(json.dumps({"closed_expired": closed}, indent=2))
            elif args.command == "coverage":
                staleness = _staleness_args(args)
                rows = await rest.rpc(client, "job_crawl_coverage", {
                    "p_min_fetches": staleness["p_min_fetches"],
                    "p_min_span": staleness["p_min_span"],
                    "p_sources": staleness["p_sources"],
                })
                rows = rows or []
                uncovered = [r for r in rows if not r.get("covered")]
                print(json.dumps({
                    "searches_x_sources": len(rows),
                    "uncovered": len(uncovered),
                    "uncovered_rows": uncovered,
                }, indent=2, default=str))
            else:
                summary = await rest.rpc(client, "close_stale_jobs", {
                    "p_dry_run": not args.apply,
                    "p_include_legacy": args.include_legacy,
                    **_staleness_args(args),
                })
                print(json.dumps(summary, indent=2, default=str))
        except httpx.HTTPStatusError as exc:
            # The refusal message comes from the database (close_stale_jobs).
            print(f"Refused or failed: HTTP {exc.response.status_code}: {exc.response.text}",
                  file=sys.stderr)
            return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["expired", "coverage", "stale"])
    parser.add_argument("--apply", action="store_true",
                        help="stale: actually close jobs (default is a dry-run report)")
    parser.add_argument("--include-legacy", action="store_true",
                        help="stale: also consider jobs that predate tracking (046)")
    parser.add_argument("--source", action="append", choices=DEFAULT_SOURCES,
                        help="restrict to this source; repeatable (default: adzuna and reed)")
    parser.add_argument("--unseen-days", type=int, default=14)
    parser.add_argument("--min-age-days", type=int, default=21)
    parser.add_argument("--min-fetches", type=int, default=2)
    parser.add_argument("--min-span-days", type=int, default=7)
    args = parser.parse_args()
    if args.apply and args.command != "stale":
        parser.error("--apply only applies to `stale`")
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
