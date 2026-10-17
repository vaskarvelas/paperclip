import { useQuery } from "@tanstack/react-query";
import { studioApi } from "../api/studio";
import { queryKeys } from "../lib/queryKeys";

/** Number of Studio pages awaiting a user choice; `studio.updated` live events keep it fresh. */
export function useStudioBadge(companyId: string | null | undefined): number {
  const { data } = useQuery({
    queryKey: queryKeys.studio.list(companyId ?? "", "all"),
    queryFn: () => studioApi.list(companyId!, "all"),
    enabled: Boolean(companyId),
    staleTime: 30_000,
  });
  return data?.awaitingChoiceCount ?? 0;
}
