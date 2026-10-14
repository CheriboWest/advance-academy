"""Self-check for the four coach-facing crawl metrics.

`python test_crawl_display_stats.py` (no pytest, no network, no Supabase
project — same offline style as test_crawl_stats.py, whose fakes this reuses
from crawl_test_support.py).

Covers the scenarios from the crawl-complete-summary audit:
  B. An all-duplicate crawl: new_jobs=0, duplicate_jobs_total>0, jobs_verified>0.
  C. A mix of new / in-crawl-duplicate / already-existing(updated) jobs.
  D. Two sources aggregate into one run's counters, neither overwriting
     the other.
  H. A completed run with real stats never reports the frontend's default
     zeros — the status response's display fields are non-zero whenever the
     underlying counters are.
"""

from __future__ import annotations

from app.crawler.models import NormalizedJob, compute_display_stats
from app.crawler.normalize import company_slug, content_hash, normalize_city
from app.routers.discover import _row_to_status
from crawl_test_support import FakeRest, check, crawled, failures, run_crawl_with

RUN_ID = "33333333-3333-3333-3333-333333333333"


def existing_job_row(job: NormalizedJob) -> dict:
    """A `jobs` row that will collide with `job`'s content_hash — i.e. this
    exact posting was already ingested by an earlier crawl."""
    slug = company_slug(job.company_name)
    digest = content_hash(slug, job.title, normalize_city(job.city))
    return {"content_hash": digest, "company_id": f"existing:{slug}", "is_active": True}


# ---------------------------------------------------------------------------
# B. All-duplicate crawl: every job the pipeline sees already exists in the
#    database from a prior crawl, so nothing is newly inserted.
# ---------------------------------------------------------------------------
b_jobs = [
    crawled("Software Engineer", "Acme Ltd"),
    crawled("Data Analyst", "Acme Ltd"),
]
b_rest = FakeRest(
    companies=[{"id": "c-acme", "slug": "acme", "name": "Acme Ltd",
                "website": None, "sector": None, "lead_score": 0}],
    jobs=[existing_job_row(j) for j in b_jobs],
)
run_crawl_with(b_rest, b_jobs, run_id=RUN_ID)
b_row = b_rest.crawl_runs[RUN_ID]
b_status = _row_to_status(b_row)

check("B: nothing was newly inserted", b_status.new_jobs == 0, f"got {b_status.new_jobs}")
check("B: both jobs count as duplicates (already existed)",
      b_status.duplicate_jobs_total == 2, f"got {b_status.duplicate_jobs_total}")
check("B: both jobs were still verified (successfully normalized)",
      b_status.jobs_verified == 2, f"got {b_status.jobs_verified}")
check("B: persisted under the real column names (new_jobs/duplicate_jobs/jobs_found)",
      (b_row.get("new_jobs"), b_row.get("duplicate_jobs"), b_row.get("jobs_found"))
      == (0, 2, 2),
      f"got new_jobs={b_row.get('new_jobs')} duplicate_jobs={b_row.get('duplicate_jobs')} "
      f"jobs_found={b_row.get('jobs_found')}")

# ---------------------------------------------------------------------------
# C. A mix: one brand-new job, one in-crawl repeat of it, and one job that
#    already existed from an earlier crawl.
# ---------------------------------------------------------------------------
c_new = crawled("Software Engineer", "Acme Ltd")
c_repeat = crawled("Software Engineer", "Acme Ltd")  # same title/company/city
c_existing = crawled("Data Analyst", "Acme Ltd")
c_jobs = [c_new, c_repeat, c_existing]
c_rest = FakeRest(
    companies=[{"id": "c-acme", "slug": "acme", "name": "Acme Ltd",
                "website": None, "sector": None, "lead_score": 0}],
    jobs=[existing_job_row(c_existing)],
)
run_crawl_with(c_rest, c_jobs, run_id=RUN_ID)
c_row = c_rest.crawl_runs[RUN_ID]
c_status = _row_to_status(c_row)

check("C: exactly one job is genuinely new",
      c_status.new_jobs == 1, f"got {c_status.new_jobs}")
check("C: the repeat + the pre-existing job both read as duplicates",
      c_status.duplicate_jobs_total == 2, f"got {c_status.duplicate_jobs_total}")
check("C: jobs_verified counts all three raw jobs — the new one, the "
      "pre-existing one, and the in-crawl repeat too (it was still "
      "successfully normalized/content-hashed before being recognized as "
      "a repeat of c_new)",
      c_status.jobs_verified == 3, f"got {c_status.jobs_verified}")
check("C: persisted duplicate_jobs folds the in-crawl repeat and the "
      "pre-existing job together (1 + 1 = 2)",
      c_row.get("duplicate_jobs") == 2, f"got {c_row.get('duplicate_jobs')}")
check("C: persisted jobs_found is 3 (matches jobs_verified)",
      c_row.get("jobs_found") == 3, f"got {c_row.get('jobs_found')}")

# ---------------------------------------------------------------------------
# D. Two sources: results are merged before ingest runs once, so the second
#    source's stats add to the first's rather than replacing them.
# ---------------------------------------------------------------------------
adzuna_jobs = [
    crawled("Software Engineer", "Acme Ltd", source="adzuna"),
    crawled("Data Analyst", "Acme Ltd", source="adzuna"),
]
reed_jobs = [
    crawled("QA Engineer", "Globex Inc", source="reed"),
]


async def fake_fetch_all(client, settings, query, city, sources, stats):
    # Mirrors the real `_fetch_all`: fetch each requested source, merge.
    jobs: list[NormalizedJob] = []
    if "adzuna" in sources:
        jobs.extend(adzuna_jobs)
    if "reed" in sources:
        jobs.extend(reed_jobs)
    return jobs


d_rest = FakeRest()
run_crawl_with(
    d_rest, [], run_id=RUN_ID, sources=["adzuna", "reed"], fetch_all=fake_fetch_all
)
d_row = d_rest.crawl_runs[RUN_ID]

check("D: new_jobs aggregates both sources (2 + 1), not just the last one",
      d_row.get("new_jobs") == 3, f"got {d_row.get('new_jobs')}")
check("D: companies_discovered counts both companies across sources",
      d_row.get("companies_discovered") == 2, f"got {d_row.get('companies_discovered')}")
check("D: jobs_found aggregates both sources",
      d_row.get("jobs_found") == 3, f"got {d_row.get('jobs_found')}")
check("D: crawl_runs is written exactly once for the combined run",
      len([1 for t, _, _ in d_rest.updates if t == "crawl_runs"]) == 1)

# ---------------------------------------------------------------------------
# H. A completed run with real stats never renders the frontend's default
#    zeros: every display field the status endpoint returns is non-zero
#    whenever the underlying counters said work happened.
# ---------------------------------------------------------------------------
h_jobs = [
    crawled("Software Engineer", "Acme Ltd"),
    crawled("Backend Developer", "ByteCorp"),
]
h_rest = FakeRest()
run_crawl_with(h_rest, h_jobs, run_id=RUN_ID)
h_status = _row_to_status(h_rest.crawl_runs[RUN_ID])

check("H: status is terminal", h_status.status == "success")
check("H: new_jobs is not the frontend's default zero",
      h_status.new_jobs == 2, f"got {h_status.new_jobs}")
check("H: companies_created is not the frontend's default zero",
      h_status.companies_created == 2, f"got {h_status.companies_created}")
check("H: jobs_verified is not the frontend's default zero",
      h_status.jobs_verified == 2, f"got {h_status.jobs_verified}")

# ---------------------------------------------------------------------------
# I. Integration: 5 normalized jobs — 2 inserted, 1 updated existing, 2 more
#    already-existing (all three folded into "duplicate" for the coach),
#    2 companies newly created. Expected public stats: new_jobs=2,
#    duplicate_jobs=3, companies_created=2, jobs_verified=5. Asserts the
#    crawler's own result, the persisted crawl_runs row, and the
#    /discover/status response all agree — the exact chain the bug broke.
# ---------------------------------------------------------------------------
i_new_1 = crawled("Software Engineer", "Acme Ltd")
i_updated_1 = crawled("Data Analyst", "Acme Ltd")
i_new_2 = crawled("QA Engineer", "Globex Inc")
i_updated_2 = crawled("Support Engineer", "Globex Inc")
i_updated_3 = crawled("Sales Manager", "Globex Inc")
i_jobs = [i_new_1, i_updated_1, i_new_2, i_updated_2, i_updated_3]
i_rest = FakeRest(
    jobs=[existing_job_row(j) for j in (i_updated_1, i_updated_2, i_updated_3)]
)
run_crawl_with(i_rest, i_jobs, run_id=RUN_ID)
i_row = i_rest.crawl_runs[RUN_ID]
i_status = _row_to_status(i_row)

check("I: persisted crawl_runs row matches the expected public stats",
      (i_row.get("new_jobs"), i_row.get("duplicate_jobs"),
       i_row.get("companies_discovered"), i_row.get("jobs_found"))
      == (2, 3, 2, 5),
      f"got new_jobs={i_row.get('new_jobs')} duplicate_jobs={i_row.get('duplicate_jobs')} "
      f"companies_discovered={i_row.get('companies_discovered')} "
      f"jobs_found={i_row.get('jobs_found')}")
check("I: /discover/status response matches the persisted row",
      (i_status.new_jobs, i_status.duplicate_jobs_total,
       i_status.companies_created, i_status.jobs_verified)
      == (i_row.get("new_jobs"), i_row.get("duplicate_jobs"),
          i_row.get("companies_discovered"), i_row.get("jobs_found")),
      f"got {i_status}")
check("I: /discover/status response matches the expected public stats exactly",
      (i_status.new_jobs, i_status.duplicate_jobs_total,
       i_status.companies_created, i_status.jobs_verified)
      == (2, 3, 2, 5),
      f"got {i_status}")

# ---------------------------------------------------------------------------
# J. Integration, multi-source: Adzuna and Reed each contribute nonzero new/
#    duplicate/companies_created stats to ONE crawl_runs row. The parent run
#    must SUM them, not let the second source overwrite the first — and the
#    persisted row and the /discover/status response must agree.
# ---------------------------------------------------------------------------
j_adzuna_new = [crawled("Frontend Engineer", "Initech", source="adzuna")]
j_adzuna_existing = [
    crawled("Backend Engineer", "Initech", source="adzuna"),
    crawled("DevOps Engineer", "Initech", source="adzuna"),
    crawled("Platform Engineer", "Initech", source="adzuna"),
]
j_reed_new = [
    crawled("Support Engineer", "Umbrella Corp", source="reed"),
    crawled("Sales Engineer", "Umbrella Corp", source="reed"),
]
j_reed_existing = [crawled("Test Engineer", "Umbrella Corp", source="reed")]

j_adzuna_jobs = j_adzuna_new + j_adzuna_existing
j_reed_jobs = j_reed_new + j_reed_existing


async def j_fake_fetch_all(client, settings, query, city, sources, stats):
    jobs: list[NormalizedJob] = []
    if "adzuna" in sources:
        jobs.extend(j_adzuna_jobs)
    if "reed" in sources:
        jobs.extend(j_reed_jobs)
    return jobs


j_rest = FakeRest(
    jobs=[existing_job_row(job) for job in (*j_adzuna_existing, *j_reed_existing)]
)
run_crawl_with(
    j_rest, [], run_id=RUN_ID, sources=["adzuna", "reed"], fetch_all=j_fake_fetch_all
)
j_row = j_rest.crawl_runs[RUN_ID]
j_status = _row_to_status(j_row)

# Adzuna alone: 1 new + 3 duplicate, 1 company. Reed alone: 2 new +
# 1 duplicate, 1 company. Neither is zero, so an overwrite bug (second
# source replacing the first) would be caught by either total being wrong.
check("J: new_jobs is the SUM across sources (1 + 2 = 3), not just one source",
      j_row.get("new_jobs") == 3, f"got {j_row.get('new_jobs')}")
check("J: duplicate_jobs is the SUM across sources (3 + 1 = 4)",
      j_row.get("duplicate_jobs") == 4, f"got {j_row.get('duplicate_jobs')}")
check("J: companies_discovered is the SUM across sources (1 + 1 = 2)",
      j_row.get("companies_discovered") == 2, f"got {j_row.get('companies_discovered')}")
check("J: jobs_found is the SUM across sources (4 + 3 = 7)",
      j_row.get("jobs_found") == 7, f"got {j_row.get('jobs_found')}")
check("J: /discover/status agrees with the persisted, summed row",
      (j_status.new_jobs, j_status.duplicate_jobs_total,
       j_status.companies_created, j_status.jobs_verified)
      == (3, 4, 2, 7),
      f"got {j_status}")
check("J: crawl_runs is written exactly once for the combined run — one row, "
      "not one per source",
      len([1 for t, _, _ in j_rest.updates if t == "crawl_runs"]) == 1)

# ---------------------------------------------------------------------------
# compute_display_stats itself: the formulas, pinned directly.
# ---------------------------------------------------------------------------
example = compute_display_stats(
    normalized_jobs=12, inserted_jobs=12, updated_jobs=0, duplicate_jobs=28
)
check("worked example: new_jobs", example["new_jobs"] == 12, f"got {example}")
check("worked example: duplicate_jobs_total", example["duplicate_jobs_total"] == 28,
      f"got {example}")
check("worked example: jobs_verified == new + duplicate (40)",
      example["jobs_verified"] == 40, f"got {example}")

print()
if failures():
    print(f"{len(failures())} FAILED:")
    for failure in failures():
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL CRAWL DISPLAY STATISTICS TESTS PASSED")
