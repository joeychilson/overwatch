import type { Accounts, AccountStatus, QuotaSample, Session } from "../bindings";

type Reading = QuotaSample & { usedPercent: number };

export type Forecast = {
  latest: Reading;
  samples: Reading[];
  state: "stale" | "expired" | "collecting" | "steady" | "projected";
  exhaustionAt: number | null;
  atReset: number | null;
};

/** Assemble account history, its latest readings, and local log allowances in one place. */
export function subscriptionForecasts(
  data: Accounts | undefined,
  sessions: Pick<Session, "limits">[],
  now: number,
) {
  const accounts = data?.accounts ?? [];
  return forecasts(
    [
      ...(data?.samples ?? []),
      ...accounts.flatMap((account) => account.usage?.windows ?? []),
      ...sessions.flatMap((session) => session.limits),
    ],
    accounts,
    now,
  );
}

export function reachesLimitBeforeReset(forecast: Forecast): boolean {
  return (
    forecast.state === "projected" &&
    forecast.exhaustionAt != null &&
    forecast.exhaustionAt < (forecast.latest.resetsAt ?? Infinity)
  );
}

/** Warn only about current allowances reached or projected to run out within a day. */
export function subscriptionWarnings(readings: Forecast[], now: number): Forecast[] {
  const urgent = readings.filter(
    (reading) =>
      reading.state !== "stale" &&
      reading.state !== "expired" &&
      (reading.latest.usedPercent >= 100 ||
        (reachesLimitBeforeReset(reading) && reading.exhaustionAt! <= now + 86_400_000)),
  );
  urgent.sort(
    (a, b) =>
      Number(b.latest.usedPercent >= 100) - Number(a.latest.usedPercent >= 100) ||
      (a.exhaustionAt ?? now) - (b.exhaustionAt ?? now) ||
      a.latest.agent.localeCompare(b.latest.agent) ||
      a.latest.bucket.localeCompare(b.latest.bucket),
  );
  const seen = new Set<string>();
  return urgent.filter(({ latest }) => {
    if (seen.has(latest.agent)) return false;
    seen.add(latest.agent);
    return true;
  });
}

function windowOrder(sample: QuotaSample): number {
  if (sample.windowMinutes > 0) return sample.windowMinutes;
  // Calendar-month allowances may not report an exact duration.
  if (/\bmonthly\b/i.test(sample.label)) return 31 * 24 * 60;
  return Number.MAX_SAFE_INTEGER;
}

export function forecasts(
  samples: QuotaSample[],
  accounts: AccountStatus[],
  now: number,
): Forecast[] {
  const current = new Map(
    accounts.flatMap((account) => (account.usage ? [[account.agent, account.usage] as const] : [])),
  );
  const groups = new Map<string, Reading[]>();
  for (const sample of samples) {
    if (sample.usedPercent == null || !Number.isFinite(sample.usedPercent)) continue;
    const account = current.get(sample.agent);
    if (
      account &&
      (sample.accountKey !== account.accountKey ||
        !account.windows.some((window) => window.bucket === sample.bucket))
    )
      continue;
    const key = `${sample.agent}/${sample.bucket}`;
    const group = groups.get(key) ?? [];
    group.push({ ...sample, usedPercent: sample.usedPercent });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group): Forecast => {
      group.sort((a, b) => a.timestamp - b.timestamp);
      const latest = group[group.length - 1];
      let points = [
        ...new Map(
          group
            .filter(
              (point) =>
                point.accountKey === latest.accountKey &&
                point.resetsAt === latest.resetsAt &&
                point.timestamp >= latest.timestamp - 21_600_000,
            )
            .map((point) => [point.timestamp, point]),
        ).values(),
      ];
      for (let i = points.length - 1; i > 0; i--)
        if (points[i].usedPercent < points[i - 1].usedPercent) {
          points = points.slice(i);
          break;
        }
      const result: Forecast = {
        latest,
        samples: points,
        state: "collecting",
        exhaustionAt: null,
        atReset: null,
      };
      if (latest.resetsAt != null && latest.resetsAt <= now) return { ...result, state: "expired" };
      if (now - latest.timestamp > 900_000) return { ...result, state: "stale" };
      if (
        points.length < 3 ||
        latest.timestamp - points[0].timestamp < 900_000 ||
        latest.resetsAt == null
      )
        return result;
      const xs = points.map((p) => (p.timestamp - points[0].timestamp) / 3_600_000);
      const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
      const meanY = points.reduce((a, p) => a + p.usedPercent, 0) / points.length;
      const variance = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
      const slope =
        xs.reduce((sum, x, i) => sum + (x - meanX) * (points[i].usedPercent - meanY), 0) / variance;
      if (!Number.isFinite(slope) || slope <= 0.01) return { ...result, state: "steady" };
      return {
        ...result,
        state: "projected",
        exhaustionAt:
          latest.timestamp + (Math.max(0, 100 - latest.usedPercent) / slope) * 3_600_000,
        atReset: Math.min(
          100,
          latest.usedPercent + (slope * (latest.resetsAt - latest.timestamp)) / 3_600_000,
        ),
      };
    })
    .sort(
      (a, b) =>
        windowOrder(a.latest) - windowOrder(b.latest) ||
        a.latest.agent.localeCompare(b.latest.agent) ||
        a.latest.label.localeCompare(b.latest.label) ||
        a.latest.bucket.localeCompare(b.latest.bucket),
    );
}
