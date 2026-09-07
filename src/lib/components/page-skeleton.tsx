import type { ReactNode } from "react";
import { Skeleton } from "./ui/skeleton";

function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
function Heading({ description = false }: { description?: boolean }) {
  return (
    <div className="mb-8 flex min-h-9 items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <Skeleton className="h-7.5 w-36 max-w-full rounded-md" />
        {description && <Skeleton className="mt-2 h-4.5 w-72 max-w-full rounded" />}
      </div>
      <Skeleton className="h-9 w-24 shrink-0 rounded-lg" />
    </div>
  );
}
function Metrics({ reader = false }: { reader?: boolean }) {
  return (
    <div
      className={
        reader
          ? "grid grid-cols-3 gap-x-6 gap-y-5 min-[1200px]:grid-cols-6"
          : "grid grid-cols-2 gap-6 xl:grid-cols-4"
      }
    >
      {Array.from({ length: reader ? 6 : 4 }, (_, index) => (
        <div key={index} className="min-w-0 py-1">
          <Skeleton className="h-4 w-24 max-w-full rounded" />
          <Skeleton className="mt-3 h-7 w-20 max-w-full rounded" />
          {!reader && <Skeleton className="mt-3 h-4 w-36 max-w-full rounded" />}
        </div>
      ))}
    </div>
  );
}
function Chart() {
  return (
    <div>
      <div className="mb-4 flex h-9 items-center justify-between gap-4">
        <Skeleton className="h-4 w-28 rounded" />
        <Skeleton className="h-9 w-40 max-w-[45%] rounded-lg" />
      </div>
      <div className="flex h-64 flex-col justify-between pt-2 pb-6 pl-12">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-px w-full rounded-none" />
        ))}
        <Skeleton className="h-3 w-full rounded" />
      </div>
    </div>
  );
}
function Rows() {
  return (
    <div className="overflow-hidden">
      <div className="min-w-150">
        <div className="grid h-10 grid-cols-[minmax(200px,1fr)_repeat(4,minmax(80px,120px))] items-center gap-6 px-3">
          {[0, 1, 2, 3, 4].map((column) => (
            <Skeleton key={column} className="h-3 w-14 rounded" />
          ))}
        </div>
        {Array.from({ length: 7 }, (_, row) => (
          <div
            key={row}
            className="grid h-15 grid-cols-[minmax(200px,1fr)_repeat(4,minmax(80px,120px))] items-center gap-6 px-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Skeleton className="size-7 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <Skeleton className={row % 2 ? "h-3.5 w-3/4 rounded" : "h-3.5 w-5/6 rounded"} />
                <Skeleton className="mt-2 h-3 w-1/2 rounded" />
              </div>
            </div>
            {[0, 1, 2, 3].map((column) => (
              <Skeleton key={column} className="h-3 w-14 rounded" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
export function TableSkeleton({ label = "Loading sessions" }: { label?: string }) {
  return (
    <Loading label={label}>
      <Rows />
    </Loading>
  );
}
function Messages() {
  return (
    <div className="space-y-8 py-5">
      {[0, 1, 2].map((message) => (
        <div key={message}>
          <div className="mb-4 flex items-center gap-3">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-3 w-24 rounded" />
          </div>
          <div className="space-y-2.5 pl-9">
            <Skeleton className="h-3.5 w-5/6 rounded" />
            <Skeleton className="h-3.5 w-full rounded" />
            <Skeleton className="h-3.5 w-2/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
export function MessagesSkeleton() {
  return (
    <Loading label="Searching transcript">
      <Messages />
    </Loading>
  );
}
export function ReaderSkeleton() {
  return (
    <Loading label="Loading session">
      <div className="mb-7 flex items-start gap-4">
        <Skeleton className="mt-1 size-10 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-8 w-3/4 rounded-md" />
          <Skeleton className="mt-2 h-4 w-1/2 rounded" />
        </div>
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
      <div className="mb-7">
        <Metrics reader />
      </div>
      <Skeleton className="mb-3 h-3 w-24 rounded" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="my-4 h-9 w-full rounded-lg" />
      <Messages />
    </Loading>
  );
}
function Allowances() {
  return (
    <>
      <div className="grid gap-4 min-[1100px]:grid-cols-2">
        {[0, 1].map((allowance) => (
          <div key={allowance} className="rounded-xl bg-card p-5">
            <Skeleton className="h-4 w-20 rounded" />
            <Skeleton className="mt-5 h-9 w-32 rounded" />
            <Skeleton className="mt-4 h-2 w-full rounded" />
            <Skeleton className="mt-4 h-3 w-3/4 rounded" />
            <Skeleton className="mt-3 h-3 w-1/2 rounded" />
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-xl bg-card p-5">
        <Chart />
      </div>
    </>
  );
}
export function AllowancesSkeleton() {
  return (
    <Loading label="Loading subscription usage">
      <Allowances />
    </Loading>
  );
}
export function PageSkeleton({
  page,
  back = false,
}: {
  back?: boolean;
  page:
    | "overview"
    | "sessions"
    | "models"
    | "subscriptions"
    | "connections"
    | "catalog"
    | "model-detail";
}) {
  return (
    <Loading
      label={`Loading ${page === "catalog" ? "pricing catalog" : page === "model-detail" ? "model details" : page}`}
    >
      {back && <Skeleton className="mb-6 h-9 w-32 rounded-lg" />}
      <Heading description={["sessions", "models", "connections", "catalog"].includes(page)} />
      {page === "sessions" || page === "models" || page === "catalog" ? (
        <>
          <div className="mb-5 flex gap-3">
            <Skeleton className="h-9 min-w-0 flex-1 rounded-lg" />
            {page !== "models" && <Skeleton className="h-9 w-32 shrink-0 rounded-lg" />}
          </div>
          <Rows />
        </>
      ) : page === "connections" ? (
        <>
          <Skeleton className="mb-4 h-5 w-24 rounded" />
          <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
            {[0, 1, 2, 3, 4, 5].map((source) => (
              <div key={source} className="rounded-xl bg-card p-5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-lg" />
                  <div>
                    <Skeleton className="h-4 w-24 rounded" />
                    <Skeleton className="mt-2 h-3 w-32 rounded" />
                  </div>
                </div>
                <Skeleton className="mt-5 h-9 w-full rounded-lg" />
              </div>
            ))}
          </div>
        </>
      ) : page === "subscriptions" ? (
        <>
          <div className="mb-6 flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4].map((tab) => (
              <Skeleton key={tab} className="h-9 w-28 rounded-lg" />
            ))}
          </div>
          <div className="mb-6 flex items-center gap-3">
            <Skeleton className="size-10 rounded-lg" />
            <Skeleton className="h-8 w-44 rounded" />
          </div>
          <Allowances />
        </>
      ) : (
        <>
          <div className="mb-10">
            <Metrics />
          </div>
          <Chart />
          {page === "overview" ? (
            <div className="my-10">
              <Metrics />
              <Skeleton className="mt-10 h-32 w-full rounded-lg" />
            </div>
          ) : (
            <div className="mt-8">
              <Rows />
            </div>
          )}
        </>
      )}
    </Loading>
  );
}
