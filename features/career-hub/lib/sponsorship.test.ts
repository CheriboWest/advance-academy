// getSponsoredCompanyPage's failure messages. The page used to say only
// "Could not load companies (500)": backend-python let a missing
// coach_company_page (migration 048) escape as a bare 500, and this reader
// dropped whatever explanation the backend did send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/auth/supabase-server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      async getSession() {
        return { data: { session: { access_token: "fake-token" } } };
      },
    },
  }),
}));

import { getSponsoredCompanyPage } from "@/features/career-hub/lib/sponsorship";

const PARAMS = { scope: "licensed" as const, q: "", page: 1 };

beforeEach(() => {
  process.env.BACKEND_PYTHON_URL = "http://fake-api.test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BACKEND_PYTHON_URL;
});

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getSponsoredCompanyPage", () => {
  it("shows the backend's explanation, e.g. the missing-migration 503", async () => {
    stubFetch(async () =>
      Response.json(
        { detail: "The database is missing coach_company_page(): section 4 of supabase/migrations/048_all_companies_and_hourly_expiry.sql has not been applied." },
        { status: 503 }
      )
    );
    await expect(getSponsoredCompanyPage(PARAMS)).rejects.toThrow(
      /^Could not load companies \(503\)\. The database is missing coach_company_page\(\): section 4 of .*048_all_companies/
    );
  });

  it("keeps the plain status when the body carries no string detail", async () => {
    stubFetch(async () => new Response("Internal Server Error", { status: 500 }));
    await expect(getSponsoredCompanyPage(PARAMS)).rejects.toThrow(/^Could not load companies \(500\)\.$/);

    stubFetch(async () => Response.json({ detail: [{ loc: ["query", "scope"], msg: "bad" }] }, { status: 422 }));
    await expect(getSponsoredCompanyPage(PARAMS)).rejects.toThrow(/^Could not load companies \(422\)\.$/);
  });

  it("caps a long detail rather than rendering it whole", async () => {
    stubFetch(async () => Response.json({ detail: "x".repeat(5000) }, { status: 502 }));
    const error = await getSponsoredCompanyPage(PARAMS).catch((e: Error) => e);
    expect((error as Error).message.length).toBeLessThan(400);
  });

  it("says the API didn't respond instead of a raw 'fetch failed'", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(getSponsoredCompanyPage(PARAMS)).rejects.toThrow(/Career Hub API didn't respond/);
  });

  it("still maps a healthy page", async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({
        companies: [{ id: "c1", slug: "acme", name: "Acme", sector: null, region: "London", hq_location: null, lead_score: null, open_jobs: 2, contacts: 1 }],
        total: 1,
        page_size: 30,
      })
    );
    const page = await getSponsoredCompanyPage(PARAMS);
    expect(page).toEqual({
      total: 1,
      page_size: 30,
      companies: [{ company_id: "c1", slug: "acme", name: "Acme", location: "London", sector: null, open_jobs: 2, lead_score: 0, contacts: 1 }],
    });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://fake-api.test/sponsors/companies?scope=licensed&q=&page=1");
  });
});
