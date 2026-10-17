import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const reviewItems = pgTable(
  "review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("result"),
    status: text("status").notNull().default("pending_review"),
    title: text("title").notNull(),
    summary: text("summary"),
    filePath: text("file_path"),
    inlineHtml: text("inline_html"),
    externalUrl: text("external_url"),
    /** Capability token for the sandboxed content route; rotated never, scoped to this review. */
    contentToken: text("content_token").notNull(),
    lavishEnabled: boolean("lavish_enabled").notNull().default(false),
    lavishSessionUrl: text("lavish_session_url"),
    lavishEndedAt: timestamp("lavish_ended_at", { withTimezone: true }),
    lavishEndedBy: text("lavish_ended_by"),
    lavishLastPolledAt: timestamp("lavish_last_polled_at", { withTimezone: true }),
    lavishLastError: text("lavish_last_error"),
    createdByUserId: text("created_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("review_items_company_status_idx").on(table.companyId, table.status, table.updatedAt),
    contentTokenIdx: uniqueIndex("review_items_content_token_idx").on(table.contentToken),
    issueIdx: index("review_items_issue_idx").on(table.issueId),
  }),
);

export const reviewMessages = pgTable(
  "review_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id").notNull().references(() => reviewItems.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    source: text("source").notNull().default("paperclip"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** Agent messages: when the reply reached the Lavish browser conversation. */
    lavishDeliveredAt: timestamp("lavish_delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewCreatedIdx: index("review_messages_review_created_idx").on(table.reviewId, table.createdAt),
  }),
);
