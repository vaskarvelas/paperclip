import type { PrimaryAgentPreference, UpdatePrimaryAgent } from "@paperclipai/shared";
import { ApiError, api } from "./client";

export const primaryAgentApi = {
  get: async (companyId: string) => {
    try {
      return await api.get<PrimaryAgentPreference>(`/companies/${companyId}/primary-agent/me`);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        return {
          companyId,
          userId: "local-board",
          primaryAgentId: null,
          initialized: false,
        };
      }
      throw err;
    }
  },
  set: (companyId: string, body: UpdatePrimaryAgent) => api.put<PrimaryAgentPreference>(`/companies/${companyId}/primary-agent/me`, body),
};
