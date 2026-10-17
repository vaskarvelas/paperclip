import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { StudioChoiceOption } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { reviewItems } from "./reviews.js";

export const studioPages = pgTable(
  "studio_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    category: text("category").notNull().default("other"),
    selectionStatus: text("selection_status").notNull().default("awaiting_choice"),
    title: text("title").notNull(),
    summary: text("summary"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    reviewId: uuid("review_id").references(() => reviewItems.id, { onDelete: "set null" }),
    filePath: text("file_path"),
    externalUrl: text("external_url"),
    contentToken: text("content_token").notNull(),
    choices: jsonb("choices").$type<StudioChoiceOption[]>().notNull().default([]),
    selectedChoices: jsonb("selected_choices").$type<string[]>().notNull().default([]),
    choiceNotes: text("choice_notes"),
    chosenAt: timestamp("chosen_at", { withTimezone: true }),
    pinnedOrder: integer("pinned_order").notNull().default(0),
    lavishEnabled: boolean("lavish_enabled").notNull().default(false),
    lavishSessionUrl: text("lavish_session_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUq: uniqueIndex("studio_pages_company_slug_uq").on(table.companyId, table.slug),
    contentTokenIdx: uniqueIndex("studio_pages_content_token_idx").on(table.contentToken),
    companyCategoryIdx: index("studio_pages_company_category_idx").on(table.companyId, table.category, table.pinnedOrder),
  }),
);
