import { lazy, Suspense, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { fullCatalogOptions } from "@/lib/queries";
import { addDays, startOfDay, subDays } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { useUsage, historyScope } from "@/lib/history";
import type { HistoryScope } from "@/lib/bindings";
import { ModelUsage } from "@/lib/components/model-usage";
import { Button } from "@/lib/components/ui/button";
import { Skeleton } from "@/lib/components/ui/skeleton";
const PricingCatalog = lazy(() => import("./model-catalog"));

export default function Models({
  modelKey,
  pricing,
  reading,
  onRoute,
  scope,
  offerings,
  range,
  now,
  scrollRef,
}: {
  modelKey?: string;
  pricing: boolean;
  reading?: string;
  onRoute: (patch: { modelKey?: string; pricing?: boolean; reading?: string }) => void;
  scope: HistoryScope;
  offerings: string[];
  range: number;
  now: number;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const setPricing = (pricing: boolean) => onRoute({ pricing });
  const details = useQuery({ ...fullCatalogOptions, enabled: pricing && isTauri() });
  const start = startOfDay(subDays(now, range - 1)).getTime();
  const end = addDays(startOfDay(now), 1).getTime();
  const { stats } = useUsage(historyScope({ ...scope, start, end }));
  const { stats: lifetime } = useUsage(scope);
  if (pricing && details.error) throw details.error;
  return (
    <>
      <div hidden={pricing}>
        <ModelUsage
          modelKey={modelKey}
          reading={reading}
          onRoute={onRoute}
          stats={stats}
          scope={scope}
          lifetime={lifetime}
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
            <PricingCatalog catalog={details.data} offerings={offerings} scrollRef={scrollRef} />
          </Suspense>
        </>
      )}
    </>
  );
}
