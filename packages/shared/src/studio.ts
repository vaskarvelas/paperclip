import { z } from "zod";
import type { ReviewAgentRef, ReviewIssueRef } from "./reviews.js";

/**
 * Studio: persistent, categorized showroom pages (Voices & Sound, Art Styles &
 * Mascots, Episodes & Hooks, Design Decisions) stored in a shared disk folder
 * (`~/.paperclip/instances/<id>/studio/<slug>/`) where the board user can
 * audition, compare, and record persistent creative/production choices.
 */

export const STUDIO_PAGE_CATEGORIES = [
  "voices_sound",
  "art_mascots",
  "episodes",
  "decisions",
  "other",
] as const;
export type StudioPageCategory = (typeof STUDIO_PAGE_CATEGORIES)[number];

export const STUDIO_CATEGORY_FILTER_VALUES = ["all", ...STUDIO_PAGE_CATEGORIES] as const;
export type StudioCategoryFilter = (typeof STUDIO_CATEGORY_FILTER_VALUES)[number];

export const STUDIO_SELECTION_STATUSES = [
  "awaiting_choice",
  "choice_made",
  "reference",
] as const;
export type StudioSelectionStatus = (typeof STUDIO_SELECTION_STATUSES)[number];

export interface StudioChoiceOption {
  id: string;
  label: string;
  group?: string | null;
  description?: string | null;
}

export interface StudioPageItem {
  id: string;
  companyId: string;
  slug: string;
  category: StudioPageCategory;
  selectionStatus: StudioSelectionStatus;
  title: string;
  summary: string | null;
  agentId: string | null;
  issueId: string | null;
  reviewId: string | null;
  filePath: string | null;
  externalUrl: string | null;
  contentUrl: string | null;
  choices: StudioChoiceOption[];
  selectedChoices: string[];
  choiceNotes: string | null;
  chosenAt: string | null;
  pinnedOrder: number;
  lavishEnabled: boolean;
  lavishSessionUrl: string | null;
  agent: ReviewAgentRef | null;
  issue: ReviewIssueRef | null;
  createdAt: string;
  updatedAt: string;
}

export type StudioCategoryCounts = Record<StudioPageCategory, number>;

export interface StudioPageListResponse {
  pages: StudioPageItem[];
  counts: StudioCategoryCounts;
  awaitingChoiceCount: number;
  studioRootDir: string;
}

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with hyphens");

const absoluteHtmlPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/"), "filePath must be an absolute path")
  .refine((value) => /\.html?$/i.test(value), "filePath must point to an .html or .htm file");

const externalUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "url must use http or https");

export const studioChoiceOptionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(300),
  group: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(1000).nullish(),
});

export const upsertStudioPageSchema = z.object({
  slug: slugSchema,
  category: z.enum(STUDIO_PAGE_CATEGORIES).default("other"),
  selectionStatus: z.enum(STUDIO_SELECTION_STATUSES).optional(),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(20_000).nullish(),
  agentId: z.string().uuid().nullish(),
  issueId: z.string().uuid().nullish(),
  reviewId: z.string().uuid().nullish(),
  filePath: absoluteHtmlPathSchema.nullish(),
  externalUrl: externalUrlSchema.nullish(),
  /** Copy source filePath and its sibling assets into the shared studio/<slug>/ directory. */
  copyToStudioDir: z.boolean().default(true),
  choices: z.array(studioChoiceOptionSchema).max(100).optional(),
  selectedChoices: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  choiceNotes: z.string().trim().max(20_000).nullish(),
  pinnedOrder: z.number().int().min(0).max(10_000).optional(),
  lavish: z.boolean().default(false),
});
export type UpsertStudioPage = z.infer<typeof upsertStudioPageSchema>;

export const updateStudioChoiceSchema = z.object({
  selectedChoices: z.array(z.string().trim().min(1).max(500)).max(100),
  choiceNotes: z.string().trim().max(20_000).nullish(),
  selectionStatus: z.enum(STUDIO_SELECTION_STATUSES).optional(),
  notifyAgent: z.boolean().default(true),
});
export type UpdateStudioChoice = z.infer<typeof updateStudioChoiceSchema>;

export const listStudioPagesQuerySchema = z.object({
  category: z.enum(STUDIO_CATEGORY_FILTER_VALUES).default("all"),
});
export type ListStudioPagesQuery = z.infer<typeof listStudioPagesQuerySchema>;
