import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { commands, type UsageSummary, type SessionQuery } from "@/lib/bindings";
import { native } from "@/lib/errors";

export function useSessionFeed(query: SessionQuery) {
  const scope = { ...query, offset: 0, limit: 50 };
  const feed = useInfiniteQuery({
    queryKey: ["sessions", "infinite", scope],
    queryFn: ({ pageParam }) => native(commands.getSessions({ ...scope, offset: pageParam })),
    initialPageParam: 0,
    getNextPageParam: (page) => {
      const next = page.offset + page.sessions.length;
      return next < page.total && page.sessions.length ? next : undefined;
    },
    enabled: isTauri(),
    staleTime: Infinity,
    gcTime: 60_000,
  });
  const sessions = useMemo(
    () => [
      ...new Map(
        feed.data?.pages.flatMap((page) =>
          page.sessions.map((session) => [session.id, session] as const),
        ),
      ).values(),
    ],
    [feed.data],
  );
  const usage = useMemo<Record<string, UsageSummary>>(
    () => Object.assign({}, ...(feed.data?.pages.map((page) => page.usage) ?? [])),
    [feed.data],
  );
  return {
    ...feed,
    sessions,
    usage,
    total: feed.data?.pages[0]?.total ?? 0,
    loadMore: () => {
      if (feed.hasNextPage && !feed.isFetching && !feed.isFetchNextPageError)
        void feed.fetchNextPage();
    },
  };
}
