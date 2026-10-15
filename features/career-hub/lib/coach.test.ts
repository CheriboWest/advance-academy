// getCoachCompanies (the coach Companies tab). It used to wait for the coach's
// meta rows, then fetch the companies hiring one 1,000-row page after another:
// 1 + ceil(n / 1000) round trips from the Next server to Supabase, in series.
// The fake below answers only when the test flushes it, so the number of
// flushes is the number of sequential round trips — no timing involved.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; result: () => unknown };

const db = vi.hoisted(() => ({
  companies: [] as Array<Record<string, unknown>>,
  meta: [] as Array<Record<string, unknown>>,
  maxRows: 1000,
  pending: [] as Array<{ resolve: (value: unknown) => void; result: () => unknown }>,
  requests: [] as Array<{ table: string; filters: string[]; count: boolean; range: [number, number] | null }>,
}));

class FakeQuery {
  private filters: Array<{ op: string; column: string; value: unknown }> = [];
  private count = false;
  private rangeArgs: [number, number] | null = null;

  constructor(private table: string) {}

  select(_columns: string, options?: { count?: string }) {
    this.count = options?.count === "exact";
    return this;
  }
  gt(column: string, value: unknown) {
    this.filters.push({ op: "gt", column, value });
    return this;
  }
  in(column: string, value: unknown) {
    this.filters.push({ op: "in", column, value });
    return this;
  }
  not(column: string, op: string, value: unknown) {
    this.filters.push({ op: `not.${op}`, column, value });
    return this;
  }
  order() {
    return this;
  }
  range(from: number, to: number) {
    this.rangeArgs = [from, to];
    return this;
  }

  private run(): unknown {
    const source = this.table === "coach_company_meta" ? db.meta : db.companies;
    const matching = source.filter((row) =>
      this.filters.every((f) =>
        f.op === "gt" ? (row[f.column] as number) > (f.value as number)
        : f.op === "in" ? (f.value as unknown[]).includes(row[f.column])
        : true
      )
    );
    const [from, to] = this.rangeArgs ?? [0, matching.length - 1];
    const data = matching.slice(from, Math.min(to + 1, from + db.maxRows));
    return { data, error: null, count: this.count ? matching.length : null };
  }

  then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
    db.requests.push({
      table: this.table,
      filters: this.filters.map((f) => f.op),
      count: this.count,
      range: this.rangeArgs,
    });
    return new Promise((resolve) => db.pending.push({ resolve, result: () => this.run() })).then(
      onFulfilled,
      onRejected
    );
  }
}

vi.mock("@/shared/auth/supabase-server", () => ({
  createSupabaseServerClient: async () => ({ from: (table: string) => new FakeQuery(table) }),
}));

import { getCoachCompanies } from "@/features/career-hub/lib/coach";

/** Runs `work`, answering every request in flight at once each round; returns
 *  the result and how many rounds (sequential round trips) it took. */
async function roundTrips<T>(work: () => Promise<T>): Promise<{ result: T; rounds: number }> {
  let done = false;
  let result!: T;
  const running = work().then((value) => {
    done = true;
    result = value;
  });
  let rounds = 0;
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (db.pending.length === 0) continue;
    rounds += 1;
    const batch = db.pending.splice(0);
    for (const request of batch as Pending[]) request.resolve(request.result());
  }
  await running;
  return { result, rounds };
}

function company(i: number, openJobs: number): Row {
  const id = `co-${String(i).padStart(5, "0")}`;
  return { id, slug: id, name: `Company ${String(i).padStart(5, "0")}`, region: "London", hq_location: null, open_jobs: openJobs, lead_score: i % 100 };
}

beforeEach(() => {
  // 2,500 companies hiring, 300 not: three 1,000-row pages.
  db.companies = [
    ...Array.from({ length: 2500 }, (_, i) => company(i, 1 + (i % 4))),
    ...Array.from({ length: 300 }, (_, i) => company(5000 + i, 0)),
  ];
  db.meta = [
    { company_id: "co-00010", starred: false, notes: null, hidden: true },
    { company_id: "co-01500", starred: false, notes: null, hidden: true },
    { company_id: "co-00002", starred: true, notes: "call back", hidden: false },
  ];
  db.maxRows = 1000;
  db.pending = [];
  db.requests = [];
});

describe("getCoachCompanies — All companies", () => {
  it("takes two sequential round trips for three pages (it took four)", async () => {
    const { rounds } = await roundTrips(() => getCoachCompanies());
    expect(rounds).toBe(2);
    const companyRequests = db.requests.filter((r) => r.table === "public_company_summary");
    expect(companyRequests.map((r) => r.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(companyRequests.map((r) => r.count)).toEqual([true, false, false]);
  });

  it("returns every company hiring, in order, minus the coach's hidden ones, with their meta", async () => {
    const { result } = await roundTrips(() => getCoachCompanies());
    expect(result).toHaveLength(2498);
    const ids = result.map((row) => row.company_id);
    expect(ids).not.toContain("co-00010");
    expect(ids).not.toContain("co-01500");
    expect(ids).not.toContain("co-05000"); // not hiring
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.find((row) => row.company_id === "co-00002")).toMatchObject({ starred: true, notes: "call back" });
  });

  it("no longer puts the hidden ids in the URL", async () => {
    await roundTrips(() => getCoachCompanies());
    expect(db.requests.flatMap((r) => r.filters)).not.toContain("not.in");
  });

  it("gets every row when the API's Max rows is under 1,000", async () => {
    db.maxRows = 400;
    const { result } = await roundTrips(() => getCoachCompanies());
    expect(result).toHaveLength(2498);
  });

  it("one page of companies is still one round trip alongside the meta", async () => {
    db.companies = db.companies.slice(0, 20);
    const { result, rounds } = await roundTrips(() => getCoachCompanies());
    expect(rounds).toBe(1);
    expect(result).toHaveLength(19);
  });
});

describe("getCoachCompanies — Removed", () => {
  it("lists exactly the hidden companies, hiring or not", async () => {
    db.meta.push({ company_id: "co-05001", starred: false, notes: null, hidden: true });
    const { result } = await roundTrips(() => getCoachCompanies({ hidden: true }));
    expect(result.map((row) => row.company_id)).toEqual(["co-00010", "co-01500", "co-05001"]);
  });

  it("skips the companies query when nothing is hidden", async () => {
    db.meta = [];
    const { result, rounds } = await roundTrips(() => getCoachCompanies({ hidden: true }));
    expect(result).toEqual([]);
    expect(rounds).toBe(1);
  });
});
