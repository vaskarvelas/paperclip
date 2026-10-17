import { useQuery } from "@tanstack/react-query";
import { reviewsApi } from "../api/reviews";
import { queryKeys } from "../lib/queryKeys";

/** Number of reviews waiting on the board user; `review.updated` live events keep it fresh. */
export function useReviewsBadge(companyId: string | null | undefined): number {
  const { data } = useQuery({
    queryKey: queryKeys.reviews.summary(companyId ?? ""),
    queryFn: () => reviewsApi.summary(companyId!),
    enabled: Boolean(companyId),
    staleTime: 30_000,
  });
  return data?.pending_review ?? 0;
}
