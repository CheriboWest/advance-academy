"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Linkedin, Lock, Mail, Send, UserRound } from "lucide-react";

import {
  CONTACT_CATEGORY_LABELS,
  CONTACT_CATEGORY_ORDER,
  type CompanyContact,
  type CompanyContactSummary,
} from "@advance-academy/contracts/contacts";
import { useAuth } from "@/features/auth/context/AuthContext";
import { fetchJson, HttpClientError } from "@/shared/api/http-client";
import { getAuthHeaders } from "@/shared/auth/get-auth-headers";
import { Button } from "@/components/ui/button";

interface CompanyContactsProps {
  companyId: string;
  companyName: string;
  slug: string;
  summary: CompanyContactSummary;
}

const MENTORSHIP_URL = process.env.NEXT_PUBLIC_MENTORSHIP_URL ?? "#";

function teaser(summary: CompanyContactSummary): string {
  return CONTACT_CATEGORY_ORDER.filter((key) => summary.byCategory[key])
    .map((key) => `${summary.byCategory[key]} ${CONTACT_CATEGORY_LABELS[key]}`)
    .join(" · ");
}

/**
 * Company → Open jobs → **Contacts** → Outreach, on the public company page.
 * The counts come from the server (public, no names); the names come from
 * GET /api/company-contacts, which only answers for Membership. Signed-out
 * visitors and trial accounts see the same locked card with a different CTA.
 */
export function CompanyContacts({ companyId, companyName, slug, summary }: CompanyContactsProps) {
  const { session, status, loading } = useAuth();
  // Only approved accounts ask: a pending one would get 403 ACCOUNT_PENDING,
  // which HttpClientError turns into a redirect to /pending — off a public page.
  const approved = Boolean(session) && status === "approved";

  const query = useQuery({
    queryKey: ["company-contacts", companyId],
    queryFn: async () =>
      fetchJson<{ contacts: CompanyContact[] }>(`/api/company-contacts/${companyId}`, {
        headers: await getAuthHeaders(),
      }),
    enabled: approved,
    retry: false,
  });

  if (summary.total === 0) return null;

  const membershipRequired =
    query.error instanceof HttpClientError && query.error.status === 403;
  const contacts = query.data?.contacts;

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-2xl">Contacts</h2>
        <span className="label-caps tabular-nums">{summary.total} people</span>
      </div>

      {contacts ? (
        <ul className="mt-5 space-y-3">
          {contacts.map((contact) => {
            const outreach = new URLSearchParams({
              view: "outreach",
              company: companyName,
              person: contact.full_name,
            });
            return (
              <li
                key={contact.id}
                className="card-surface flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 font-medium">
                    <UserRound className="size-4 shrink-0 text-muted-foreground" />
                    {contact.full_name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {contact.job_title ?? CONTACT_CATEGORY_LABELS[contact.category]}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {contact.email && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={`mailto:${contact.email}`}>
                        <Mail className="size-4" />
                        Email
                      </a>
                    </Button>
                  )}
                  {contact.linkedin_url && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer">
                        <Linkedin className="size-4" />
                        LinkedIn
                      </a>
                    </Button>
                  )}
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/?${outreach}`}>
                      <Send className="size-4" />
                      Write outreach
                    </Link>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="card-surface mt-5 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="flex items-center gap-2 font-medium">
              <Lock className="size-4 text-highlight-ink" />
              Direct contacts at {companyName}
            </p>
            <p className="text-sm text-muted-foreground">{teaser(summary)}</p>
          </div>
          {loading ? null : !session ? (
            <Button asChild variant="highlight">
              <Link href={`/login?next=${encodeURIComponent(`/companies/${slug}`)}`}>
                Unlock company contacts
              </Link>
            </Button>
          ) : !approved || query.isPending ? null : membershipRequired ? (
            <Button asChild variant="highlight">
              <a href={MENTORSHIP_URL}>Upgrade to Membership</a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Couldn&apos;t load contacts. Try again later.</p>
          )}
        </div>
      )}
    </section>
  );
}
