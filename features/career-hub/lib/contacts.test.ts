// getContactsForCompanies batches company ids into short GET requests: the
// ids end up in a PostgREST `in.(...)` URL, and app/routers/contacts.py
// refuses more than 500 per request (fetchContacts reads any non-2xx as "no
// contacts", which once zeroed every count on Sponsored Companies).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/auth/supabase-server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      async getSession() {
        return { data: { session: { access_token: "fake-token" } } };
      },
    },
  }),
}));

const ABSOLUTE_RECRUIT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeContact(id: string, companyId: string) {
  return {
    id,
    company_id: companyId,
    full_name: `Contact ${id}`,
    job_title: null,
    email: `${id}@example.com`,
    phone: null,
    linkedin_url: null,
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** Stands in for the real app/routers/contacts.py: two real contacts for
 *  Absolute Recruit, and enforces the same MAX_COMPANY_IDS_PER_LIST=500 cap
 *  the real backend does — a `company_ids` request over that many ids is a
 *  422, exactly like the real router. */
function installFakeBackend() {
  const CONTACTS = [
    makeContact("c1", ABSOLUTE_RECRUIT_ID),
    makeContact("c2", ABSOLUTE_RECRUIT_ID),
  ];
  const MAX_COMPANY_IDS_PER_LIST = 500;

  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(url.toString());
    const companyId = u.searchParams.get("company_id");
    const companyIds = u.searchParams.get("company_ids");

    if (companyId) {
      return jsonResponse(CONTACTS.filter((c) => c.company_id === companyId));
    }
    if (companyIds) {
      const ids = companyIds.split(",").filter(Boolean);
      if (ids.length > MAX_COMPANY_IDS_PER_LIST) {
        return new Response(
          JSON.stringify({
            detail: `Provide at most ${MAX_COMPANY_IDS_PER_LIST} company_ids.`,
          }),
          { status: 422 }
        );
      }
      const idSet = new Set(ids);
      return jsonResponse(CONTACTS.filter((c) => idSet.has(c.company_id)));
    }
    return new Response(JSON.stringify({ detail: "Provide company_id or company_ids." }), {
      status: 422,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("contacts across companies", () => {
  it("finds a company's contacts in a batch, same as its own detail read", async () => {
    installFakeBackend();
    process.env.BACKEND_PYTHON_URL = "http://fake-api.test";

    const { getContactsForCompanies, getContacts } = await import("@/features/career-hub/lib/contacts");

    expect(await getContacts(ABSOLUTE_RECRUIT_ID)).toHaveLength(2);
    expect(await getContactsForCompanies([ABSOLUTE_RECRUIT_ID])).toHaveLength(2);
  });

  it("splits a large id list into requests of at most 100 ids", async () => {
    const fetchMock = installFakeBackend();
    process.env.BACKEND_PYTHON_URL = "http://fake-api.test";

    const { getContactsForCompanies } = await import("@/features/career-hub/lib/contacts");

    const manyOtherIds = Array.from({ length: 500 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`
    );
    const contacts = await getContactsForCompanies([...manyOtherIds, ABSOLUTE_RECRUIT_ID]);
    expect(contacts).toHaveLength(2);

    const sizes = fetchMock.mock.calls.map(
      ([url]) => new URL(url.toString()).searchParams.get("company_ids")!.split(",").length
    );
    expect(sizes).toHaveLength(6);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });
});
