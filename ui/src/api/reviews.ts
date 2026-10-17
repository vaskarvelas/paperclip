import type {
  CreateReviewMessage,
  ReviewCounts,
  ReviewItemDetail,
  ReviewListResponse,
  ReviewListStatusFilter,
  ReviewPollResult,
  UpdateReview,
} from "@paperclipai/shared";
import { api } from "./client";

export const reviewsApi = {
  list: (companyId: string, status: ReviewListStatusFilter = "open") =>
    api.get<ReviewListResponse>(`/companies/${companyId}/reviews?status=${encodeURIComponent(status)}`),
  summary: (companyId: string) => api.get<ReviewCounts>(`/companies/${companyId}/reviews/summary`),
  get: (reviewId: string) => api.get<ReviewItemDetail>(`/reviews/${reviewId}`),
  update: (reviewId: string, body: UpdateReview) => api.patch<ReviewItemDetail>(`/reviews/${reviewId}`, body),
  addMessage: (reviewId: string, body: CreateReviewMessage) =>
    api.post<ReviewItemDetail>(`/reviews/${reviewId}/messages`, body),
  pollNow: (companyId: string) => api.post<ReviewPollResult>(`/companies/${companyId}/reviews/poll`, {}),
};
