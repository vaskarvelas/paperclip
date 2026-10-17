import type {
  StudioCategoryFilter,
  StudioPageItem,
  StudioPageListResponse,
  UpdateStudioChoice,
  UpsertStudioPage,
} from "@paperclipai/shared";
import { api } from "./client";

export const studioApi = {
  list: (companyId: string, category: StudioCategoryFilter = "all") =>
    api.get<StudioPageListResponse>(`/companies/${companyId}/studio?category=${encodeURIComponent(category)}`),
  get: (pageId: string) => api.get<StudioPageItem>(`/studio/${pageId}`),
  upsert: (companyId: string, body: UpsertStudioPage) =>
    api.post<StudioPageItem>(`/companies/${companyId}/studio`, body),
  updateChoice: (pageId: string, body: UpdateStudioChoice) =>
    api.patch<StudioPageItem>(`/studio/${pageId}/choice`, body),
};
