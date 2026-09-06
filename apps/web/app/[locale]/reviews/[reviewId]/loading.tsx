import { Skeleton } from '@repo/ui/components/skeleton';
import { ReviewPageFrame } from '../../../../src/features/reviews/review-page-frame';

export default function ReviewDetailLoading() {
  return (
    <ReviewPageFrame className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-9 w-44 rounded-xl" />
      </div>
      <header className="border-b border-border pb-5">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="mt-3 h-9 w-full max-w-xl" />
        <Skeleton className="mt-3 h-4 w-full max-w-md" />
      </header>
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-5">
          <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface">
            <div className="px-6 py-6 sm:px-7">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-8 w-72 max-w-full" />
              <Skeleton className="mt-3 h-4 w-96 max-w-full" />
            </div>
            <div className="grid border-t border-border/70 sm:grid-cols-3 sm:divide-x sm:divide-border/70">
              {['findings', 'files', 'duration'].map((key) => (
                <div key={key} className="px-6 py-5 sm:px-7">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-3 h-6 w-16" />
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-2xl border border-border/75 bg-surface px-6 py-6 sm:px-7">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-3 h-4 w-56" />
            <div className="mt-5 space-y-5 border-t border-border/70 pt-5">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </section>
        </div>
        <aside className="min-w-0 space-y-5">
          <section className="rounded-2xl border border-border/75 bg-surface p-5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="mt-3 h-4 w-full" />
            <div className="mt-5 space-y-2">
              {['useful', 'mixed', 'not-useful', 'unable'].map((key) => (
                <Skeleton key={key} className="h-11 w-full rounded-xl" />
              ))}
            </div>
            <Skeleton className="mt-3 h-24 w-full rounded-xl" />
            <Skeleton className="mt-3 h-11 w-full rounded-xl" />
          </section>
          <Skeleton className="h-56 w-full rounded-2xl" />
        </aside>
      </div>
    </ReviewPageFrame>
  );
}
