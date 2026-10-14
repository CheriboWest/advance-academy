import type {
  Classification,
  CompanyDecision,
  ContactDecision,
  ImportConflict,
  ImportRole,
  ImportRow,
  ImportSummary,
  ResultStatus,
  RowResolution,
} from "@/features/career-hub/lib/contact-import-api";

/**
 * Pure helpers for the import wizard — no React, no fetch — so the rules for
 * what an admin may decide on a row are unit-tested on their own
 * (contact-import.test.ts). The database re-checks every decision anyway
 * (contact_import_classify), so these only shape what the UI offers.
 */

export const ROLE_LABELS: Record<ImportRole, string> = {
  company_name: "Company name",
  company_website: "Company website",
  contact: "Contact (name; link = LinkedIn profile)",
  contact_name: "Contact name",
  contact_linkedin_url: "Contact LinkedIn URL",
  contact_job_title: "Contact job title",
  phone: "Phone",
  email: "Email",
  source: "Source info (job title / link / notes)",
  ignore: "Ignore",
};

export const ROLE_ORDER: ImportRole[] = [
  "company_name",
  "company_website",
  "contact",
  "contact_name",
  "contact_linkedin_url",
  "contact_job_title",
  "phone",
  "email",
  "source",
  "ignore",
];

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  matched: "Matched",
  new: "New",
  needs_review: "Needs review",
  invalid: "Invalid",
  skipped: "Skipped",
};

export const CLASSIFICATION_HELP: Record<Classification, string> = {
  matched: "Everything in this row already exists. Empty fields may be filled in; nothing is overwritten.",
  new: "Creates a company and/or contact.",
  needs_review: "An uncertain match or unusable contact. Decide below, or it is skipped.",
  invalid: "Can't be imported as it stands. See the reason.",
  skipped: "Left out by a decision or because its sheet is excluded.",
};

export const RESULT_LABELS: Record<ResultStatus, string> = {
  created: "Created",
  updated: "Filled in",
  matched: "Matched",
  skipped: "Skipped",
  failed: "Failed",
  rolled_back: "Rolled back",
};

const MATCH_REASON_LABELS: Record<string, string> = {
  domain: "same website domain",
  name: "same name",
  alias: "verified alias",
  similar_name: "similar name",
};

export interface DecisionOption<T> {
  key: string;
  label: string;
  decision: T;
}

export function needsCompanyDecision(row: ImportRow): boolean {
  return row.company_status === "needs_review";
}

export function needsContactDecision(row: ImportRow): boolean {
  return row.contact_status === "needs_review";
}

/** What an admin can do with a row's company: match a candidate, create
 *  (only when the file gives a name — a name is never guessed), or skip. */
export function companyOptions(row: ImportRow): DecisionOption<CompanyDecision>[] {
  const options: DecisionOption<CompanyDecision>[] = row.company_candidates.map((c) => ({
    key: `match:${c.id}`,
    label: `Match ${c.name}${c.reasons.length ? ` (${c.reasons.map((r) => MATCH_REASON_LABELS[r] ?? r).join(", ")})` : ""}`,
    decision: { action: "match", company_id: c.id },
  }));
  const name = row.extracted?.company?.name;
  const slugTaken = row.company_candidates.some((c) => c.reasons.includes("similar_name"));
  if (name && !slugTaken) {
    options.push({ key: "create", label: `Create "${name}" as a new company`, decision: { action: "create" } });
  }
  options.push({ key: "skip", label: "Skip this row", decision: { action: "skip" } });
  return options;
}

/** What an admin can do with a row's contact. A contact the file couldn't
 *  read (contact_error) can only be skipped, which lets the company import.
 *  Only contacts at the row's own (settled) company can be matched — the
 *  database refuses any other match and would mark the row invalid. */
export function contactOptions(row: ImportRow): DecisionOption<ContactDecision>[] {
  if (row.extracted?.contact_error || !row.extracted?.contact) {
    return [{ key: "skip", label: "Leave the contact out", decision: { action: "skip" } }];
  }
  const matchable = row.contact_candidates.filter((c) => contactMatchAllowed(row, c.id));
  const options: DecisionOption<ContactDecision>[] = matchable.map((c) => ({
    key: `match:${c.id}`,
    label: `Same person as ${c.full_name} at ${c.company_name}${c.email ? ` (${c.email})` : ""}`,
    decision: { action: "match", contact_id: c.id },
  }));
  options.push({
    key: "create",
    label: `Create "${row.extracted.contact.full_name}" as a new contact`,
    decision: { action: "create" },
  });
  options.push({ key: "skip", label: "Leave the contact out", decision: { action: "skip" } });
  return options;
}

/** A contact can only be matched to a contact at the row's own company. */
export function contactMatchAllowed(row: ImportRow, contactId: string): boolean {
  const companyId = row.company_match?.id;
  const candidate = row.contact_candidates.find((c) => c.id === contactId);
  return Boolean(candidate && companyId && candidate.company_id === companyId);
}

export function toResolutionPayload(decisions: Record<number, RowResolution>) {
  return Object.entries(decisions)
    .filter(([, d]) => d.company || d.contact)
    .map(([rowId, d]) => ({ row_id: Number(rowId), ...d }));
}

export function companyLabel(row: ImportRow): string {
  const company = row.extracted?.company;
  if (!company) return "—";
  if (company.name) return company.name;
  if (company.website) return `(no name) ${company.website}`;
  return "—";
}

export function contactLabel(row: ImportRow): string {
  const contact = row.extracted?.contact;
  if (!contact) return row.extracted?.contact_error ? "unreadable contact" : "—";
  return [contact.full_name, contact.job_title].filter(Boolean).join(" · ");
}

/** One line for a value the import kept as it was. */
export function conflictText(c: ImportConflict): string {
  if (c.reason === "used_by_other_contact") {
    return `Did not add ${c.record} ${c.field} "${c.incoming}": another contact already has it`;
  }
  return `Kept existing ${c.record} ${c.field} "${c.existing ?? ""}" (file had "${c.incoming}")`;
}

/** Contact candidates the row can't be matched to, shown so the admin knows why "create" was refused. */
export function otherCompanyContacts(row: ImportRow) {
  return row.contact_candidates.filter((c) => !contactMatchAllowed(row, c.id));
}

export function summaryLines(summary: ImportSummary | null): Array<{ label: string; value: number }> {
  if (!summary) return [];
  if (summary.status === "failed") {
    return [{ label: "Rows that failed", value: summary.failed_rows ?? 0 }];
  }
  return [
    { label: "Companies created", value: summary.companies?.created ?? 0 },
    { label: "Companies matched", value: summary.companies?.matched ?? 0 },
    { label: "Contacts created", value: summary.contacts?.created ?? 0 },
    { label: "Contacts matched", value: summary.contacts?.matched ?? 0 },
    { label: "Contacts filled in", value: summary.contacts?.updated ?? 0 },
    { label: "Rows skipped", value: summary.rows?.skipped ?? 0 },
    { label: "Rows failed", value: summary.rows?.failed ?? 0 },
    { label: "Conflicts kept as they were", value: summary.conflicts ?? 0 },
    { label: "Aliases saved", value: summary.aliases_created ?? 0 },
  ];
}
