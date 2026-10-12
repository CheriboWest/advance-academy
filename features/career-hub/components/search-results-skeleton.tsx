/** Placeholder grid shown while search results are loading on the server. */
export function SearchResultsSkeleton() {
  return (
    <div>
      <div className="border-b border-border pb-3">
        <div className="h-3 w-32 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="card-surface p-6">
            <div className="size-10 animate-pulse rounded-md bg-muted" />
            <div className="mt-4 h-7 w-2/3 animate-pulse rounded-lg bg-muted" />
            <div className="mt-2 h-4 w-1/2 animate-pulse rounded-lg bg-muted" />
            <div className="mt-5 flex gap-6 border-t border-border pt-4">
              <div className="h-10 w-16 animate-pulse rounded-lg bg-muted" />
              <div className="h-10 w-16 animate-pulse rounded-lg bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
