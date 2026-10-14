"""Self-check for sponsor-register ingestion: `python test_sponsor_register.py`.

Offline by design: the GOV.UK download is never exercised against the live site.
The parser runs on a fixture CSV that carries the shapes the real file has
(BOM, quoted commas, ampersands, accents, dotted abbreviations, a blank line, a
nameless row, a repeated line), and the write path runs against a fake Supabase
that enforces the `natural_key` unique index.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.sponsors.importer import run_import
from app.sponsors.models import ImportStats, SponsorRecord
from app.sponsors.normalize import (
    natural_key,
    normalize_organisation_name,
    normalize_town,
    parse_type_rating,
)
from app.sponsors.parser import (
    CsvParseError,
    decode,
    deduplicate,
    map_headers,
    parse_register,
)
from fake_supabase import FakeSupabase

FIXTURE = Path(__file__).parent / "tests" / "fixtures" / "sponsor_register_sample.csv"
SOURCE_URL = "https://assets.publishing.service.gov.uk/media/2026-08-01/register.csv"

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


def raises(fn, exc) -> bool:
    """Whether calling `fn` raises `exc`."""
    try:
        fn()
    except exc:
        return True
    return False


# The shared double. It mirrors the unique index, PostgREST's column-level
# merge, the post-0009 `is_current` default and the finalization function; see
# fake_supabase.py for why that is worth keeping in one place.
FakeRest = FakeSupabase


def ingest(rest: FakeRest, csv_bytes: bytes, force: bool = True) -> ImportStats:
    """Ingest the fixture.

    `force=True` by default: the fixture is deliberately dense with edge cases
    (a fifth of its lines are rejected or duplicated), which the pre-import
    safety gate refuses on purpose. These checks are about ingestion mechanics —
    the gate itself is covered in test_sponsor_validation.py.
    """
    _, stats = asyncio.run(
        run_import(
            rest, client=object(), csv_bytes=csv_bytes,
            source_url=SOURCE_URL, force=force,
        )
    )
    return stats


# ---------------------------------------------------------------------------
# Normalization — lookup keys only; originals are never touched.
# ---------------------------------------------------------------------------
check("Ltd and Limited share a normalized name",
      normalize_organisation_name("Acme Fintech Ltd")
      == normalize_organisation_name("ACME FINTECH LIMITED") == "acme fintech")
check("ampersand expands rather than vanishing",
      normalize_organisation_name("Smith & Sons") == "smith and sons")
check("accented names fold to their plain spelling",
      normalize_organisation_name("Ståhl Ltd") == normalize_organisation_name("Stahl Limited"))
check("dotted abbreviations collapse",
      normalize_organisation_name("Pennine Robotics C.I.C.") == "pennine robotics")
check("a name that is only a suffix is not normalized away",
      normalize_organisation_name("Limited Ltd") == "limited")
check("distinct employers keep distinct keys",
      normalize_organisation_name("Smith Recruitment")
      != normalize_organisation_name("Smith Recruitment Group"))
check("town normalization is case and whitespace insensitive",
      normalize_town("  LONDON ") == normalize_town("London") == "london")
check("type and rating are parsed", parse_type_rating("Worker (A rating)") == ("Worker", "A"))
check("an unparseable type/rating yields nulls, not a guess",
      parse_type_rating("Worker") == (None, None))

# The wording the register actually publishes today. A pattern written for the
# older "(A rating)" spelling matched none of these and stored two NULLs for
# every row in the file.
for published, expected in (
    ("Worker (A (Premium))", ("Worker", "A (Premium)")),
    ("Worker (A (SME+))", ("Worker", "A (SME+)")),
    ("Temporary Worker (A (Premium))", ("Temporary Worker", "A (Premium)")),
    ("Temporary Worker (A (SME+))", ("Temporary Worker", "A (SME+)")),
    ("Worker (UK Expansion Worker: Provisional )",
     ("Worker", "UK Expansion Worker: Provisional")),
):
    check(f"the published value {published!r} is split correctly",
          parse_type_rating(published) == expected,
          f"got {parse_type_rating(published)}")

check("the old wording still parses the same way it always did",
      parse_type_rating("Temporary Worker (A rating)") == ("Temporary Worker", "A"))
check("a bare grade is upper-cased so editions agree",
      parse_type_rating("worker (a rating)")[1] == "A")
check("a rating phrase keeps the register's own capitalisation",
      parse_type_rating("Worker (UK Expansion Worker: Provisional )")[1]
      == "UK Expansion Worker: Provisional")
check("unbalanced brackets are refused rather than half-parsed",
      parse_type_rating("Worker (A (Premium)") == (None, None))
check("the published value itself is never rewritten",
      SponsorRecord(
          organisation_name="X", town_city=None, county=None,
          type_rating="Worker (A (SME+))", route=None,
          licence_type="Worker", rating="A (SME+)",
          normalized_name="x", normalized_town=None, natural_key="k",
      ).as_row("u", None)["type_rating"] == "Worker (A (SME+))")
check("natural key separates routes for one organisation",
      natural_key("acme", "london", "GL", "Worker (A rating)", "Skilled Worker")
      != natural_key("acme", "london", "GL", "Worker (A rating)", "Creative Worker"))

# ---------------------------------------------------------------------------
# Parsing the fixture.
# ---------------------------------------------------------------------------
raw = FIXTURE.read_bytes()
check("fixture carries a UTF-8 BOM (as GOV.UK has published)", raw[:3] == b"\xef\xbb\xbf")
text = decode(raw)
records, rejections, data_lines = parse_register(text)
records, duplicates = deduplicate(records)

check("every non-blank data line is counted", data_lines == 10, f"got {data_lines}")
check("valid rows are parsed", len(records) == 8, f"got {len(records)}")
check("the nameless row is rejected with a reason",
      len(rejections) == 1 and "missing organisation name" in rejections[0].reason,
      f"got {[r.reason for r in rejections]}")
check("the repeated line is collapsed", duplicates == 1, f"got {duplicates}")
check("a blank line is not counted as data", data_lines == 10)

by_name = {r.organisation_name: r for r in records}
check("the original organisation name is preserved verbatim",
      "Bramble, Hart & Co Solicitors" in by_name)
check("a quoted comma does not split the row",
      by_name["Bramble, Hart & Co Solicitors"].town_city == "Leeds")
check("accents survive in the stored original",
      "Ståhl Precision Engineering Ltd" in by_name)
check("the normalized form is folded, the original is not",
      by_name["Ståhl Precision Engineering Ltd"].normalized_name
      == "stahl precision engineering")
check("a missing county is null, not an empty string",
      by_name["Riverside Care Group PLC"].county is None)
check("licence type and rating are split out",
      (by_name["Riverside Care Group PLC"].licence_type,
       by_name["Riverside Care Group PLC"].rating) == ("Worker", "B"))
check("one organisation can hold several routes",
      len([r for r in records if r.normalized_name == "acme fintech"]) == 2)

# ---------------------------------------------------------------------------
# Parser robustness.
# ---------------------------------------------------------------------------
check("header aliases are recognised",
      map_headers(["Organisation Name", "Town / City", "County", "Type & Rating", "Route"])
      == {"organisation_name": 0, "town_city": 1, "county": 2, "type_rating": 3, "route": 4})
check("a file with no organisation column is refused outright",
      raises(lambda: parse_register("Foo,Bar\n1,2\n"), CsvParseError))
check("a header below a preamble line is still found",
      len(parse_register(
          "Register of licensed sponsors\n"
          "Organisation Name,Town/City,County,Type & Rating,Route\n"
          "Test Ltd,York,North Yorkshire,Worker (A rating),Skilled Worker\n"
      )[0]) == 1)
check("a short row does not crash the parser",
      len(parse_register(
          "Organisation Name,Town/City,County,Type & Rating,Route\nShort Ltd,York\n"
      )[0]) == 1)
check("windows-1252 bytes decode without an exception",
      "Caf" in decode("Café Ltd,London".encode("cp1252")))

# ---------------------------------------------------------------------------
# Ingestion — first run, repeat run, changed row, withdrawal.
# ---------------------------------------------------------------------------
rest = FakeRest()
stats = ingest(rest, raw)
check("first run publishes every parsed row", stats.rows_processed == 8,
      f"got {stats.rows_processed}")
check("first run reports the rejected and duplicate lines",
      stats.rows_rejected == 2, f"got {stats.rows_rejected}")
check("rows_downloaded reflects the file, not what survived",
      stats.rows_downloaded == 10, f"got {stats.rows_downloaded}")
check("rows_parsed reflects what survived", stats.rows_parsed == 8)
check("rows_current_after describes the table, not the file",
      stats.rows_current_after == 8, f"got {stats.rows_current_after}")
check("the import run is recorded as successful",
      rest.imports[-1]["status"] == "success")
check("the import run carries the statistics",
      rest.imports[-1]["rows_processed"] == 8)
check("the counters that needed a full-table scan are null, not zero",
      stats.rows_inserted is None and stats.rows_updated is None
      and stats.rows_unchanged is None)
check("provenance is stored on every row",
      all(r["source_url"] == SOURCE_URL for r in rest.rows))
check("the register publication date is stored",
      all(r["register_published_at"] is None for r in rest.rows))
check("every row is credited to the import that published it",
      all(r["last_import_id"] == rest.imports[-1]["id"] for r in rest.rows))

stats = ingest(rest, raw)
check("RE-RUN: no duplicate rows are created", len(rest.rows) == 8,
      f"got {len(rest.rows)}")
check("RE-RUN: nothing is withdrawn", stats.rows_withdrawn == 0)
check("RE-RUN: the same rows are published again", stats.rows_processed == 8,
      f"got {stats.rows_processed}")
check("RE-RUN: the whole table is still current", stats.rows_current_after == 8)

changed = text.replace("Northgate Analytics Ltd", "Northgate Analytics Group Ltd")
stats = ingest(rest, changed.encode("utf-8"))
check("a renamed organisation is a new register line",
      stats.rows_processed == 8 and len(rest.rows) == 9,
      f"processed={stats.rows_processed} rows={len(rest.rows)}")
check("the line it replaced is withdrawn, not deleted",
      stats.rows_withdrawn == 1, f"got {stats.rows_withdrawn}")
withdrawn = [r for r in rest.rows if not r.get("is_current")]
check("the withdrawn row is flagged and stamped",
      len(withdrawn) == 1 and withdrawn[0].get("withdrawn_at"))
check("the withdrawn row keeps its original organisation name",
      withdrawn[0]["organisation_name"] == "Northgate Analytics Ltd")
check("the withdrawn row is not credited to the edition that dropped it",
      withdrawn[0]["last_import_id"] != rest.imports[-1]["id"])

# A row whose published details change keeps its identity and is updated.
rest2 = FakeRest()
ingest(rest2, raw)
rerated = text.replace("Riverside Care Group PLC,Bristol,,Worker (B rating)",
                       "Riverside Care Group PLC,Bristol,,Worker (A rating)")
stats = ingest(rest2, rerated.encode("utf-8"))
check("a re-rated licence is a new register line (rating is part of identity)",
      stats.rows_withdrawn == 1 and len(rest2.rows) == 9,
      f"withdrawn={stats.rows_withdrawn} rows={len(rest2.rows)}")

# ---------------------------------------------------------------------------
# An empty register cannot withdraw the world — it cannot publish at all.
# ---------------------------------------------------------------------------
rest3 = FakeRest()
ingest(rest3, raw)
header_only = b"Organisation Name,Town/City,County,Type & Rating,Route\n"
try:
    ingest(rest3, header_only)
    empty_published = True
except Exception:  # noqa: BLE001 — the database refuses it
    empty_published = False
check("an edition that stages no rows cannot publish", not empty_published)
check("an empty edition withdraws nothing",
      len([r for r in rest3.rows if r.get("is_current")]) == 8,
      f"got {len([r for r in rest3.rows if r.get('is_current')])}")
check("and the run is recorded as an error", rest3.imports[-1]["status"] == "error",
      f"got {rest3.imports[-1]['status']}")


# ---------------------------------------------------------------------------
# A failed import is recorded, not silent.
# ---------------------------------------------------------------------------
rest4 = FakeRest()
try:
    ingest(rest4, b"Foo,Bar\n1,2\n")
    raised = False
except CsvParseError:
    raised = True
check("an unparseable file raises", raised)
check("the failed run is recorded as an error",
      rest4.imports[-1]["status"] == "error", f"got {rest4.imports[-1].get('status')}")
check("the failure reason is stored", bool(rest4.imports[-1].get("error")))

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL SPONSOR REGISTER TESTS PASSED")
