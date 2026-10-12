"use server";

import { revalidatePath } from "next/cache";

/**
 * Revalidate the pages whose rendered output depends on a company's
 * contacts, after a contact is added, edited, or deleted.
 *
 * Contact mutations (features/career-hub/lib/contacts-api.ts) go straight from the
 * browser to the FastAPI backend — there is no Server Action or Supabase
 * write on this path for Next.js to key a cache invalidation off of, unlike
 * every other coach mutation in this app (see companies/actions.ts,
 * outreach/actions.ts). Without this, the Sponsored Companies list's
 * "N contacts" count keeps showing whatever it was the last time that page
 * was rendered: the Contacts section on the company detail page updates
 * instantly from its own local state, but navigating back to the list (or
 * reloading it) re-served a stale Router Cache entry with the pre-mutation
 * count instead of hitting the server again.
 *
 * Revalidates both the list (the contact count shown there) and this
 * company's own detail page (so a reload reflects the change too, even
 * though the Contacts section already shows it live via local state).
 */
export async function revalidateContactPaths(companyId: string): Promise<void> {
  revalidatePath("/coach/sponsored-companies");
  revalidatePath(`/coach/sponsored-companies/${companyId}`);
}
