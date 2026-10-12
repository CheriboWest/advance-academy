"""Self-check for candidate search + entity resolution.

`python test_sponsor_matching.py` — offline. The database is a fake that records
the filters it was asked for (so the "Claude never sees the register" property is
testable), and the Anthropic client is a stub, so no API key and no network are
involved.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from app.sponsors.candidates import CandidateSearch
from app.sponsors.resolver import (
    MIN_MATCH_CONFIDENCE,
    build_user_prompt,
    resolve,
)
from app.sponsors.service import store_resolution

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


REGISTER = [
    {"id": "lic-1", "organisation_name": "Acme Fintech Limited", "town_city": "London",
     "county": "Greater London", "route": "Skilled Worker", "licence_type": "Worker",
     "rating": "A", "normalized_name": "acme fintech", "normalized_town": "london"},
    {"id": "lic-2", "organisation_name": "Acme Fintech Limited", "town_city": "London",
     "county": "Greater London", "route": "Creative Worker",
     "licence_type": "Temporary Worker", "rating": "A",
     "normalized_name": "acme fintech", "normalized_town": "london"},
    {"id": "lic-3", "organisation_name": "Acme Fintech Group Ltd", "town_city": "Leeds",
     "county": "West Yorkshire", "route": "Skilled Worker", "licence_type": "Worker",
     "rating": "A", "normalized_name": "acme fintech group", "normalized_town": "leeds"},
    {"id": "lic-4", "organisation_name": "Northgate Analytics Ltd",
     "town_city": "Manchester", "county": "Greater Manchester", "route": "Skilled Worker",
     "licence_type": "Worker", "rating": "A",
     "normalized_name": "northgate analytics", "normalized_town": "manchester"},
]


class FakeRest:
    """Applies PostgREST-shaped filters over the fixture register."""

    def __init__(self, rows: Optional[list[dict]] = None) -> None:
        self.rows = rows if rows is not None else REGISTER
        self.filters: list[dict] = []
        self.writes: list[tuple[str, list[dict]]] = []

    async def select(self, client, table, params=None, timeout=None):
        params = params or {}
        self.filters.append(dict(params))
        rows = [dict(r) for r in self.rows]
        for field in ("normalized_name", "normalized_town"):
            raw = params.get(field)
            if not raw:
                continue
            if raw.startswith("eq."):
                rows = [r for r in rows if r.get(field) == raw[3:]]
            elif raw.startswith("like."):
                pattern = raw[5:]
                if pattern.startswith("*") and pattern.endswith("*"):
                    rows = [r for r in rows if pattern[1:-1] in (r.get(field) or "")]
                elif pattern.endswith("*"):
                    rows = [r for r in rows
                            if (r.get(field) or "").startswith(pattern[:-1])]
        return rows[: int(params.get("limit", "100"))]

    async def upsert(self, client, table, rows, on_conflict, prefer="", timeout=None):
        self.writes.append((table, rows))
        return []


class StubAnthropic:
    """Returns a canned resolver payload and records the prompt it was given."""

    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.prompts: list[str] = []
        self.kwargs: list[dict] = []
        self.messages = self

    def create(self, **kwargs):
        import json as _json

        self.kwargs.append(kwargs)
        self.prompts.append(kwargs["messages"][0]["content"])

        class _Block:
            type = "text"
            text = _json.dumps(self._payload)

        class _Message:
            stop_reason = "end_turn"
            content = [_Block()]

        return _Message()


def search(name: str, city: Optional[str] = None, rest: Optional[FakeRest] = None):
    rest = rest or FakeRest()
    result = asyncio.run(CandidateSearch(rest).find(None, name=name, city=city))
    return result[0], result[1], rest


# ---------------------------------------------------------------------------
# Candidate search — deterministic, indexed, and narrow.
# ---------------------------------------------------------------------------
candidates, strategies, rest = search("Acme Fintech Ltd", "London")
check("exact normalized name + town is tried first",
      strategies[0] == "exact_name_and_town", f"got {strategies}")
check("both routes for the matched organisation are returned",
      {c["id"] for c in candidates} >= {"lic-1", "lic-2"},
      f"got {[c['id'] for c in candidates]}")
check("every search is scoped to currently-listed rows",
      all(f.get("is_current") == "eq.true" for f in rest.filters))
check("the search is filtered in the database, not in Python",
      all("normalized_name" in f or "normalized_town" in f for f in rest.filters))

candidates, strategies, _ = search("Acme Fintech", None)
check("a prefix search reaches the longer trading name",
      "lic-3" in {c["id"] for c in candidates}, f"got {[c['id'] for c in candidates]}")

candidates, strategies, _ = search("Totally Unrelated Business", "Cardiff")
check("an unknown company yields no candidates", candidates == [], f"got {candidates}")
check("no candidates is a real answer, not an error", strategies == [])

candidates, _, _ = search("!!!", "London")
check("a name that normalizes to nothing yields no candidates", candidates == [])

_, _, rest = search('Bad", Name', "London")
check("a name with filter metacharacters is not sent as a filter",
      all('"' not in str(f.get("normalized_name", "")) for f in rest.filters))

candidates, _, _ = search("Acme Fintech Ltd", "London", FakeRest(rows=REGISTER * 10))
check("the candidate set is capped before it reaches the model",
      len(candidates) <= 12, f"got {len(candidates)}")

# ---------------------------------------------------------------------------
# Resolution — the prompt, and the guardrails around what comes back.
# ---------------------------------------------------------------------------
COMPANY = {"id": "co-1", "name": "Acme Fintech Ltd", "website": "acme-fintech.co.uk",
           "hq_location": "London", "sector": "Financial services"}

prompt = build_user_prompt(COMPANY, REGISTER[:2])
check("the prompt carries the company's supplied fields", "acme-fintech.co.uk" in prompt)
check("the prompt carries each candidate id", "lic-1" in prompt and "lic-2" in prompt)
check("the prompt names no unsupplied field", "<" not in prompt)
check("only the supplied candidates appear in the prompt", "lic-4" not in prompt)

stub = StubAnthropic({"selected_candidate_id": "lic-1", "confidence": 0.94,
                      "decision": "match", "matched_on": ["name_exact", "city"],
                      "reasoning": "Exact name and town."})
res = resolve(COMPANY, REGISTER[:2], api_key="k", model="claude-opus-5", client=stub)
check("a confident match is accepted", res.decision == "match")
check("the selected candidate is carried through", res.selected_candidate_id == "lic-1")
check("matched_on is preserved", res.matched_on == ["name_exact", "city"])
check("the model is asked for structured output",
      stub.kwargs[0]["output_config"]["format"]["type"] == "json_schema")
check("the resolver defaults to the configured model",
      stub.kwargs[0]["model"] == "claude-opus-5")

stub = StubAnthropic({"selected_candidate_id": "lic-1", "confidence": 0.55,
                      "decision": "match", "matched_on": ["name_variant"],
                      "reasoning": "Names look similar."})
res = resolve(COMPANY, REGISTER[:2], api_key="k", model="m", client=stub)
check(f"a match below {MIN_MATCH_CONFIDENCE} is downgraded to ambiguous",
      res.decision == "ambiguous", f"got {res.decision}")
check("a downgraded match carries no selection", res.selected_candidate_id is None)
check("the downgrade is explained in the reasoning", "threshold" in res.reasoning)

stub = StubAnthropic({"selected_candidate_id": "lic-999", "confidence": 0.99,
                      "decision": "match", "matched_on": ["name_exact"],
                      "reasoning": "Invented."})
res = resolve(COMPANY, REGISTER[:2], api_key="k", model="m", client=stub)
check("an id that was never supplied is discarded",
      res.decision == "ambiguous" and res.selected_candidate_id is None,
      f"got {res.decision}/{res.selected_candidate_id}")

stub = StubAnthropic({"selected_candidate_id": None, "confidence": 0.9,
                      "decision": "match", "matched_on": [], "reasoning": "?"})
res = resolve(COMPANY, REGISTER[:2], api_key="k", model="m", client=stub)
check("a match with no selection is downgraded", res.decision == "ambiguous")

stub = StubAnthropic({"selected_candidate_id": "lic-1", "confidence": 0.5,
                      "decision": "ambiguous", "matched_on": [],
                      "reasoning": "Two candidates fit."})
res = resolve(COMPANY, REGISTER[:2], api_key="k", model="m", client=stub)
check("an ambiguous result never keeps a selection",
      res.selected_candidate_id is None, f"got {res.selected_candidate_id}")

stub = StubAnthropic({"selected_candidate_id": None, "confidence": 5.0,
                      "decision": "wat", "matched_on": None, "reasoning": None})
res = resolve(COMPANY, REGISTER[:2], api_key="k", model="m", client=stub)
check("an out-of-range confidence is clamped", 0.0 <= res.confidence <= 1.0)
check("an unknown decision becomes ambiguous", res.decision == "ambiguous")

called = StubAnthropic({"decision": "match", "selected_candidate_id": "x",
                        "confidence": 1, "matched_on": [], "reasoning": ""})
res = resolve(COMPANY, [], api_key="k", model="m", client=called)
check("no candidates means no model call at all", called.prompts == [])
check("no candidates resolves to no_match", res.decision == "no_match")
check("no_match carries no selection", res.selected_candidate_id is None)

# ---------------------------------------------------------------------------
# Persistence — only a match becomes a link.
# ---------------------------------------------------------------------------
def stored_for(decision: str, selected: Optional[str]) -> list:
    from app.sponsors.resolver import Resolution

    rest = FakeRest()
    asyncio.run(store_resolution(
        None, rest,
        Resolution(company_id="co-1", selected_candidate_id=selected,
                   confidence=0.9, decision=decision, matched_on=["name_exact"],
                   reasoning="r"),
        model="claude-opus-5",
    ))
    return rest.writes


check("a match is written to company_sponsorship",
      len(stored_for("match", "lic-1")) == 1)
check("an ambiguous result writes nothing", stored_for("ambiguous", None) == [])
check("a no_match writes nothing", stored_for("no_match", None) == [])
writes = stored_for("match", "lic-1")
check("the stored link keys both sides",
      writes[0][1][0]["company_id"] == "co-1"
      and writes[0][1][0]["sponsor_licence_id"] == "lic-1")
check("the stored link records the model that decided it",
      writes[0][1][0]["model"] == "claude-opus-5")
check("the link is upserted on the company/licence pair",
      writes[0][0] == "company_sponsorship")

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL SPONSOR MATCHING TESTS PASSED")
