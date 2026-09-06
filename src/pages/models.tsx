import { lazy, Suspense, useMemo, useState, type RefObject } from "react";
import { addDays, startOfDay, subDays } from "date-fns";
import { ArrowLeft } from "lucide-react";
import type { Session } from "@/lib/bindings";
import { emptyModels, type Catalog } from "@/lib/models/catalog";
import { aggregate } from "@/lib/usage/analytics";
import { ModelUsage } from "@/lib/components/model-usage";
import { Button } from "@/lib/components/ui/button";
import { Skeleton } from "@/lib/components/ui/skeleton";
const PricingCatalog = lazy(() => import("./model-catalog"));

export default function Models({
  initialModelKey,
  catalog,
  sessions,
  range,
  now,
  scrollRef,
}: {
  initialModelKey?: string;
  catalog?: Catalog;
  sessions: Session[];
  range: number;
  now: number;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [pricing, setPricing] = useState(false);
  const models = catalog?.models ?? emptyModels;
  const start = startOfDay(subDays(now, range - 1)).getTime();
  const end = addDays(startOfDay(now), 1).getTime();
  const stats = useMemo(
    () => aggregate(sessions, models, start, end),
    [sessions, models, start, end],
  );
  return (
    <>
      <div hidden={pricing}>
        <ModelUsage
          initialModelKey={initialModelKey}
          stats={stats}
          sessions={sessions}
          models={models}
          start={start}
          end={end}
          now={now}
          range={range}
          scrollRef={scrollRef}
          openCatalog={() => {
            setPricing(true);
            scrollRef.current?.scrollTo({ top: 0 });
          }}
        />
      </div>
      {pricing && (
        <>
          <Button variant="ghost" className="mb-6 -ml-3" onClick={() => setPricing(false)}>
            <ArrowLeft />
            Back to models
          </Button>
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <PricingCatalog catalog={catalog} sessions={sessions} scrollRef={scrollRef} />
          </Suspense>
        </>
      )}
    </>
  );
}
