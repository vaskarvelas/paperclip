import { z } from "zod";

/**
 * Reviews: agent-produced results (HTML pages, Lavish review sessions,
 * samples, questions) waiting for the board user's review, with a two-way
 * conversation between the user and the responsible agent.
 */

export const REVIEW_ITEM_STATUSES = ["pending_review", "changes_requested", "approved", "closed"] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];

/** Statuses that keep a review open (visible by default, polled when Lavish-backed). */
export const OPEN_REVIEW_ITEM_STATUSES = ["pending_review", "changes_requested"] as const satisfies readonly ReviewItemStatus[];

export const REVIEW_ITEM_KINDS = ["result", "sample", "question", "plan", "report"] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];

export const REVIEW_MESSAGE_AUTHOR_TYPES = ["user", "agent", "system"] as const;
export type ReviewMessageAuthorType = (typeof REVIEW_MESSAGE_AUTHOR_TYPES)[number];

export const REVIEW_MESSAGE_SOURCES = ["paperclip", "lavish"] as const;
export type ReviewMessageSource = (typeof REVIEW_MESSAGE_SOURCES)[number];

export const REVIEW_LIST_STATUS_FILTERS = ["open", "all", ...REVIEW_ITEM_STATUSES] as const;
export type ReviewListStatusFilter = (typeof REVIEW_LIST_STATUS_FILTERS)[number];

export const REVIEW_MAX_INLINE_HTML_BYTES = 2 * 1024 * 1024;
export const REVIEW_MAX_MESSAGE_CHARS = 20_000;

export type ReviewCounts = Record<ReviewItemStatus, number>;

export interface ReviewAgentRef {
  id: string;
  name: string;
  icon: string | null;
}

export interface ReviewIssueRef {
  id: string;
  identifier: string | null;
  title: string;
}

export interface ReviewItem {
  id: string;
  companyId: string;
  issueId: string | null;
  agentId: string;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  title: string;
  summary: string | null;
  filePath: string | null;
  hasInlineHtml: boolean;
  externalUrl: string | null;
  /** Paperclip-served, sandbox-only URL for the HTML content (null when there is none). */
  contentUrl: string | null;
  lavishEnabled: boolean;
  lavishSessionUrl: string | null;
  lavishEndedAt: string | null;
  lavishEndedBy: string | null;
  lavishLastPolledAt: string | null;
  lavishLastError: string | null;
  agent: ReviewAgentRef | null;
  issue: ReviewIssueRef | null;
  messageCount: number;
  lastMessageAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMessage {
  id: string;
  reviewId: string;
  authorType: ReviewMessageAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  source: ReviewMessageSource;
  body: string;
  metadata: Record<string, unknown> | null;
  lavishDeliveredAt: string | null;
  createdAt: string;
}

export interface ReviewItemDetail extends ReviewItem {
  messages: ReviewMessage[];
}

export interface ReviewListResponse {
  reviews: ReviewItem[];
  counts: ReviewCounts;
}

export interface ReviewPollResult {
  polled: number;
  feedbackBatches: number;
  repliesDelivered: number;
  errors: number;
}

const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/"), "filePath must be an absolute path")
  .refine((value) => /\.html?$/i.test(value), "filePath must point to an .html or .htm file");

const utf8Encoder = new TextEncoder();

const inlineHtmlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= REVIEW_MAX_INLINE_HTML_BYTES,
    `html must be at most ${REVIEW_MAX_INLINE_HTML_BYTES} bytes`,
  );

const externalUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "url must use http or https");

export const createReviewSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    summary: z.string().max(REVIEW_MAX_MESSAGE_CHARS).optional().nullable(),
    kind: z.enum(REVIEW_ITEM_KINDS).optional().default("result"),
    issueId: z.string().guid().optional().nullable(),
    /** Responsible agent. Agents default to themselves; board callers must supply it. */
    agentId: z.string().guid().optional(),
    filePath: absolutePathSchema.optional().nullable(),
    html: inlineHtmlSchema.optional().nullable(),
    url: externalUrlSchema.optional().nullable(),
    /** Open (or resume) a Lavish review session for `filePath` and poll it for feedback. */
    lavish: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    const sources = [value.filePath, value.html, value.url].filter((entry) => entry != null);
    if (sources.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at most one of filePath, html, url", path: ["filePath"] });
    }
    if (value.lavish && !value.filePath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lavish requires filePath", path: ["lavish"] });
    }
  });
export type CreateReview = z.infer<typeof createReviewSchema>;

export const updateReviewSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    summary: z.string().max(REVIEW_MAX_MESSAGE_CHARS).optional().nullable(),
    kind: z.enum(REVIEW_ITEM_KINDS).optional(),
    status: z.enum(REVIEW_ITEM_STATUSES).optional(),
    filePath: absolutePathSchema.optional().nullable(),
    html: inlineHtmlSchema.optional().nullable(),
    url: externalUrlSchema.optional().nullable(),
    /** Optional note attached to a status change (approval comment, close reason). */
    note: z.string().trim().min(1).max(REVIEW_MAX_MESSAGE_CHARS).optional(),
  })
  .superRefine((value, ctx) => {
    const sources = [value.filePath, value.html, value.url].filter((entry) => entry != null);
    if (sources.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at most one of filePath, html, url", path: ["filePath"] });
    }
  });
export type UpdateReview = z.infer<typeof updateReviewSchema>;

export const createReviewMessageSchema = z.object({
  body: z.string().trim().min(1).max(REVIEW_MAX_MESSAGE_CHARS),
  /** Agent messages only: mark the review ready for the user again (default true). */
  readyForReview: z.boolean().optional(),
});
export type CreateReviewMessage = z.infer<typeof createReviewMessageSchema>;

export const listReviewsQuerySchema = z.object({
  status: z.enum(REVIEW_LIST_STATUS_FILTERS).optional().default("open"),
  agentId: z.string().guid().optional(),
  issueId: z.string().guid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
