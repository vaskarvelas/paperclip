import { randomBytes } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, reviewItems, reviewMessages } from "@paperclipai/db";
import {
  OPEN_REVIEW_ITEM_STATUSES,
  REVIEW_ITEM_STATUSES,
  type CreateReview,
  type CreateReviewMessage,
  type ListReviewsQuery,
  type ReviewCounts,
  type ReviewItem,
  type ReviewItemDetail,
  type ReviewItemKind,
  type ReviewItemStatus,
  type ReviewListResponse,
  type ReviewMessage,
  type ReviewMessageAuthorType,
  type ReviewMessageSource,
  type ReviewPollResult,
  type UpdateReview,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";
import {
  createLavishClient,
  LavishRequestError,
  LavishUnavailableError,
  type LavishClient,
  type LavishPollResult,
  type LavishPrompt,
} from "./lavish-client.js";
import { publishLiveEvent } from "./live-events.js";

export type ReviewActor =
  | { type: "user"; userId: string | null }
  | { type: "agent"; agentId: string; runId?: string | null };

export interface ReviewServiceDeps {
  lavish?: LavishClient;
  wakeAgent?: (agentId: string, options: WakeupOptions) => Promise<unknown>;
}

type ReviewRow = typeof reviewItems.$inferSelect;
type MessageRow = typeof reviewMessages.$inferSelect;

/** Extensions served next to a review's HTML file (relative assets such as images and CSS). */
const SIBLING_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};
const MAX_SIBLING_BYTES = 100 * 1024 * 1024;
const MAX_WAKE_FEEDBACK_CHARS = 8_000;

export type ReviewContent =
  | { kind: "inline"; html: string }
  | { kind: "file"; path: string; contentType: string };

export function reviewContentUrl(row: Pick<ReviewRow, "contentToken" | "filePath" | "inlineHtml">): string | null {
  if (row.filePath) return `/api/review-content/${row.contentToken}/${encodeURIComponent(path.basename(row.filePath))}`;
  if (row.inlineHtml) return `/api/review-content/${row.contentToken}/index.html`;
  return null;
}

function emptyCounts(): ReviewCounts {
  return Object.fromEntries(REVIEW_ITEM_STATUSES.map((status) => [status, 0])) as ReviewCounts;
}

function formatLavishFeedback(prompts: LavishPrompt[]): string {
  const lines = prompts.map((prompt) => {
    const text = String(prompt.text ?? "").trim() || "(no text)";
    const target = String(prompt.selector ?? "").trim();
    const quoted = String(prompt.prompt ?? "").trim();
    const tag = String(prompt.tag ?? "").trim();
    const context = [
      tag && tag !== "general" ? `[${tag}]` : "",
      target ? `on \`${target}\`` : "",
      quoted && quoted !== text ? `re: "${quoted.slice(0, 300)}"` : "",
    ].filter(Boolean).join(" ");
    return context ? `- ${context}: ${text}` : `- ${text}`;
  });
  return lines.length === 1 ? lines[0]!.replace(/^- /, "") : lines.join("\n");
}

const ensuredReviewSchemas = new WeakMap<object, Promise<void>>();

function ensureReviewSchema(db: Db): Promise<void> {
  let promise = ensuredReviewSchemas.get(db);
  if (!promise) {
    promise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "review_items" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
          "issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
          "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
          "kind" text DEFAULT 'result' NOT NULL,
          "status" text DEFAULT 'pending_review' NOT NULL,
          "title" text NOT NULL,
          "summary" text,
          "file_path" text,
          "inline_html" text,
          "external_url" text,
          "content_token" text NOT NULL,
          "lavish_enabled" boolean DEFAULT false NOT NULL,
          "lavish_session_url" text,
          "lavish_ended_at" timestamp with time zone,
          "lavish_ended_by" text,
          "lavish_last_polled_at" timestamp with time zone,
          "lavish_last_error" text,
          "created_by_user_id" text,
          "resolved_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "review_messages" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
          "review_id" uuid NOT NULL REFERENCES "review_items"("id") ON DELETE cascade,
          "author_type" text NOT NULL,
          "author_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
          "author_user_id" text,
          "source" text DEFAULT 'paperclip' NOT NULL,
          "body" text NOT NULL,
          "metadata" jsonb,
          "lavish_delivered_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "review_items_company_status_idx" ON "review_items" ("company_id", "status", "updated_at")`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "review_items_content_token_idx" ON "review_items" ("content_token")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "review_items_issue_idx" ON "review_items" ("issue_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "review_messages_review_created_idx" ON "review_messages" ("review_id", "created_at")`);
    })();
    ensuredReviewSchemas.set(db, promise);
  }
  return promise;
}

export function reviewService(db: Db, deps: ReviewServiceDeps = {}) {
  const lavish = deps.lavish ?? createLavishClient();
  const wakeAgent = deps.wakeAgent ?? null;

  async function hydrate(rows: ReviewRow[]): Promise<ReviewItem[]> {
    if (rows.length === 0) return [];
    const agentIds = [...new Set(rows.map((row) => row.agentId))];
    const issueIds = [...new Set(rows.map((row) => row.issueId).filter((id): id is string => Boolean(id)))];
    const reviewIds = rows.map((row) => row.id);
    const [agentRows, issueRows, messageStats] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, icon: agents.icon }).from(agents).where(inArray(agents.id, agentIds)),
      issueIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; identifier: string | null; title: string }>)
        : db.select({ id: issues.id, identifier: issues.identifier, title: issues.title }).from(issues).where(inArray(issues.id, issueIds)),
      db
        .select({
          reviewId: reviewMessages.reviewId,
          total: count(),
          lastAt: sql<Date | string | null>`max(${reviewMessages.createdAt})`,
        })
        .from(reviewMessages)
        .where(inArray(reviewMessages.reviewId, reviewIds))
        .groupBy(reviewMessages.reviewId),
    ]);
    const agentById = new Map(agentRows.map((row) => [row.id, row]));
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const statsById = new Map(messageStats.map((row) => [row.reviewId, row]));
    return rows.map((row) => {
      const stats = statsById.get(row.id);
      const agent = agentById.get(row.agentId);
      const issue = row.issueId ? issueById.get(row.issueId) : undefined;
      return {
        id: row.id,
        companyId: row.companyId,
        issueId: row.issueId,
        agentId: row.agentId,
        kind: row.kind as ReviewItemKind,
        status: row.status as ReviewItemStatus,
        title: row.title,
        summary: row.summary,
        filePath: row.filePath,
        hasInlineHtml: Boolean(row.inlineHtml),
        externalUrl: row.externalUrl,
        contentUrl: reviewContentUrl(row),
        lavishEnabled: row.lavishEnabled,
        lavishSessionUrl: row.lavishSessionUrl,
        lavishEndedAt: row.lavishEndedAt?.toISOString() ?? null,
        lavishEndedBy: row.lavishEndedBy,
        lavishLastPolledAt: row.lavishLastPolledAt?.toISOString() ?? null,
        lavishLastError: row.lavishLastError,
        agent: agent ? { id: agent.id, name: agent.name, icon: agent.icon ?? null } : null,
        issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null,
        messageCount: Number(stats?.total ?? 0),
        lastMessageAt: stats?.lastAt ? new Date(stats.lastAt).toISOString() : null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  function toMessage(row: MessageRow): ReviewMessage {
    return {
      id: row.id,
      reviewId: row.reviewId,
      authorType: row.authorType as ReviewMessageAuthorType,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      source: row.source as ReviewMessageSource,
      body: row.body,
      metadata: row.metadata ?? null,
      lavishDeliveredAt: row.lavishDeliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function getRow(id: string): Promise<ReviewRow | null> {
    await ensureReviewSchema(db);
    const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
    return row ?? null;
  }

  async function getDetail(id: string): Promise<ReviewItemDetail | null> {
    const row = await getRow(id);
    if (!row) return null;
    const [[item], messages] = await Promise.all([
      hydrate([row]),
      db.select().from(reviewMessages).where(eq(reviewMessages.reviewId, id)).orderBy(asc(reviewMessages.createdAt)),
    ]);
    return { ...item!, messages: messages.map(toMessage) };
  }

  async function patchRow(id: string, patch: Partial<typeof reviewItems.$inferInsert>): Promise<ReviewRow> {
    const [row] = await db
      .update(reviewItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(reviewItems.id, id))
      .returning();
    if (!row) throw notFound("Review not found");
    return row;
  }

  async function insertMessage(
    review: ReviewRow,
    input: {
      authorType: ReviewMessageAuthorType;
      authorAgentId?: string | null;
      authorUserId?: string | null;
      source?: ReviewMessageSource;
      body: string;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<MessageRow> {
    const [row] = await db
      .insert(reviewMessages)
      .values({
        companyId: review.companyId,
        reviewId: review.id,
        authorType: input.authorType,
        authorAgentId: input.authorAgentId ?? null,
        authorUserId: input.authorUserId ?? null,
        source: input.source ?? "paperclip",
        body: input.body,
        metadata: input.metadata ?? null,
      })
      .returning();
    return row!;
  }

  function announce(review: Pick<ReviewRow, "companyId" | "id">) {
    publishLiveEvent({ companyId: review.companyId, type: "review.updated", payload: { reviewId: review.id } });
  }

  /**
   * Wake the responsible agent with the user's message. The message is already
   * persisted, so a failed wake is logged rather than surfaced: the agent can
   * still read it from the review thread.
   */
  async function wakeResponsibleAgent(
    review: ReviewRow,
    message: MessageRow,
    kind: "feedback" | "approved" | "closed",
    requestedBy: { type: "user" | "system"; id: string },
  ) {
    if (!wakeAgent) return;
    const [issue] = review.issueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, review.issueId))
      : [];
    // Run inside the issue only when the agent owns an active issue; otherwise
    // a plain agent wake avoids assignee/terminal-status wake guards.
    const issueContext = issue && issue.assigneeAgentId === review.agentId && !["done", "cancelled"].includes(issue.status)
      ? { issueId: issue.id, taskId: issue.id }
      : {};
    const headline = kind === "approved"
      ? `The board APPROVED your review "${review.title}". Continue with the next step of the work.`
      : kind === "closed"
        ? `The board CLOSED your review "${review.title}" without approval. Do not continue this line of work unless asked.`
        : `The board left feedback on your review "${review.title}". Apply it, then reply.`;
    const text = [
      headline,
      "",
      kind === "feedback" ? "Feedback:" : "Note:",
      message.body.slice(0, MAX_WAKE_FEEDBACK_CHARS),
      "",
      `Review id: ${review.id}${issue?.identifier ? ` (issue ${issue.identifier})` : ""}`,
      review.filePath ? `Artifact file: ${review.filePath} (edit it in place; the review page reloads it)` : null,
      `Read the full thread: GET /api/reviews/${review.id}`,
      kind === "feedback"
        ? `Reply when done: POST /api/reviews/${review.id}/messages {"body":"<what changed>","readyForReview":true}`
        : null,
    ].filter((line) => line !== null).join("\n");
    try {
      await wakeAgent(review.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: `review_${kind}`,
        idempotencyKey: `review-message:${message.id}`,
        requestedByActorType: requestedBy.type,
        requestedByActorId: requestedBy.id,
        payload: { reviewId: review.id, reviewMessageId: message.id, issueId: review.issueId },
        contextSnapshot: {
          ...issueContext,
          reviewId: review.id,
          reviewMessageId: message.id,
          wakeReason: `review_${kind}`,
          source: "review",
          paperclipAgentMessage: { text, source: "review", sessionId: review.id },
        },
      });
    } catch (err) {
      logger.warn({ err, reviewId: review.id, agentId: review.agentId }, "review wake failed");
    }
  }

  async function deliverPendingReplies(review: ReviewRow): Promise<number> {
    if (!review.lavishEnabled || !review.filePath || review.lavishEndedAt) return 0;
    const pending = await db
      .select()
      .from(reviewMessages)
      .where(and(
        eq(reviewMessages.reviewId, review.id),
        eq(reviewMessages.authorType, "agent"),
        isNull(reviewMessages.lavishDeliveredAt),
      ))
      .orderBy(asc(reviewMessages.createdAt));
    let delivered = 0;
    for (const message of pending) {
      await lavish.reply(review.filePath, message.body);
      await db.update(reviewMessages).set({ lavishDeliveredAt: new Date() }).where(eq(reviewMessages.id, message.id));
      delivered += 1;
    }
    return delivered;
  }

  async function endLavishSession(review: ReviewRow): Promise<Partial<typeof reviewItems.$inferInsert>> {
    if (!review.lavishEnabled || !review.filePath || review.lavishEndedAt) return {};
    try {
      await lavish.end(review.filePath);
    } catch (err) {
      logger.warn({ err, reviewId: review.id }, "ending lavish session failed");
    }
    return { lavishEndedAt: new Date(), lavishEndedBy: "paperclip" };
  }

  async function recordUserFeedback(
    review: ReviewRow,
    input: { body: string; source: ReviewMessageSource; userId: string | null; metadata?: Record<string, unknown> | null },
  ) {
    const message = await insertMessage(review, {
      authorType: "user",
      authorUserId: input.userId,
      source: input.source,
      body: input.body,
      metadata: input.metadata,
    });
    const updated = await patchRow(review.id, { status: "changes_requested", resolvedAt: null });
    await wakeResponsibleAgent(updated, message, "feedback", input.userId ? { type: "user", id: input.userId } : { type: "system", id: "review-poller" });
    return { message, review: updated };
  }

  async function applyPollResult(review: ReviewRow, result: LavishPollResult): Promise<number> {
    if (result.status === "feedback") {
      const prompts = result.prompts ?? [];
      const ended = result.session_ended === true;
      let current = review;
      if (prompts.length > 0) {
        ({ review: current } = await recordUserFeedback(review, {
          body: formatLavishFeedback(prompts),
          source: "lavish",
          userId: null,
          metadata: { prompts, sessionEnded: ended },
        }));
      }
      if (ended) await patchRow(current.id, { lavishEndedAt: new Date(), lavishEndedBy: result.ended_by ?? "user" });
      return prompts.length > 0 ? 1 : 0;
    }
    if (result.status === "ended") {
      const endedBy = result.ended_by ?? "unknown";
      await insertMessage(review, {
        authorType: "system",
        source: "lavish",
        body: `Lavish session ended by ${endedBy}.`,
      });
      await patchRow(review.id, { lavishEndedAt: new Date(), lavishEndedBy: endedBy });
    }
    return 0;
  }
  async function countByStatus(companyId: string): Promise<ReviewCounts> {
    await ensureReviewSchema(db);
    const rows = await db
      .select({ status: reviewItems.status, total: count() })
      .from(reviewItems)
      .where(eq(reviewItems.companyId, companyId))
      .groupBy(reviewItems.status);
    const counts = emptyCounts();
    for (const row of rows) {
      if (row.status in counts) counts[row.status as ReviewItemStatus] = Number(row.total);
    }
    return counts;
  }

  return {
    getRow,
    getById: getDetail,
    counts: countByStatus,

    async list(companyId: string, query: ListReviewsQuery): Promise<ReviewListResponse> {
      await ensureReviewSchema(db);
      const conditions = [eq(reviewItems.companyId, companyId)];
      if (query.status === "open") conditions.push(inArray(reviewItems.status, [...OPEN_REVIEW_ITEM_STATUSES]));
      else if (query.status !== "all") conditions.push(eq(reviewItems.status, query.status));
      if (query.agentId) conditions.push(eq(reviewItems.agentId, query.agentId));
      if (query.issueId) conditions.push(eq(reviewItems.issueId, query.issueId));
      const [rows, counts] = await Promise.all([
        db
          .select()
          .from(reviewItems)
          .where(and(...conditions))
          .orderBy(desc(reviewItems.updatedAt))
          .limit(query.limit),
        countByStatus(companyId),
      ]);
      return { reviews: await hydrate(rows), counts };
    },

    async create(
      companyId: string,
      input: CreateReview & { agentId: string },
      actor: ReviewActor,
    ): Promise<ReviewItemDetail> {
      await ensureReviewSchema(db);
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, companyId)));
      if (!agent) throw badRequest("agentId does not belong to this company");
      if (input.issueId) {
        const [issue] = await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId)));
        if (!issue) throw badRequest("issueId does not belong to this company");
      }
      if (input.filePath) await assertReadableHtmlFile(input.filePath);

      let lavishSessionUrl: string | null = null;
      let lavishLastError: string | null = null;
      if (input.lavish && input.filePath) {
        try {
          lavishSessionUrl = (await lavish.ensureSession(input.filePath)).url;
        } catch (err) {
          lavishLastError = err instanceof Error ? err.message : String(err);
        }
      }

      const [row] = await db
        .insert(reviewItems)
        .values({
          companyId,
          agentId: input.agentId,
          issueId: input.issueId ?? null,
          kind: input.kind,
          status: "pending_review",
          title: input.title,
          summary: input.summary ?? null,
          filePath: input.filePath ?? null,
          inlineHtml: input.html ?? null,
          externalUrl: input.url ?? null,
          contentToken: randomBytes(24).toString("base64url"),
          lavishEnabled: Boolean(input.lavish && input.filePath),
          lavishSessionUrl,
          lavishLastError,
          createdByUserId: actor.type === "user" ? actor.userId : null,
        })
        .returning();
      announce(row!);
      return (await getDetail(row!.id))!;
    },

    async update(id: string, patch: UpdateReview, actor: ReviewActor): Promise<ReviewItemDetail> {
      const review = await getRow(id);
      if (!review) throw notFound("Review not found");
      const { status, note, html, url, filePath, ...fields } = patch;
      if (filePath) await assertReadableHtmlFile(filePath);
      const changes: Partial<typeof reviewItems.$inferInsert> = { ...fields };
      if (filePath !== undefined || html !== undefined || url !== undefined) {
        changes.filePath = filePath ?? null;
        changes.inlineHtml = html ?? null;
        changes.externalUrl = url ?? null;
        if (!filePath) changes.lavishEnabled = false;
      }

      if (status && status !== review.status) {
        if (actor.type === "agent" && !["pending_review", "closed"].includes(status)) {
          throw forbidden("Agents may only mark a review pending_review or closed");
        }
        if (status === "changes_requested") {
          if (!note) throw badRequest("A note is required to request changes");
          await recordUserFeedback(review, {
            body: note,
            source: "paperclip",
            userId: actor.type === "user" ? actor.userId : null,
          });
          if (Object.keys(changes).length > 0) await patchRow(id, changes);
          announce(review);
          return (await getDetail(id))!;
        }
        changes.status = status;
        const resolving = status === "approved" || status === "closed";
        changes.resolvedAt = resolving ? new Date() : null;
        if (resolving) Object.assign(changes, await endLavishSession(review));
        const who = actor.type === "user" ? "the board" : "the agent";
        const message = await insertMessage(review, {
          authorType: actor.type === "user" ? "user" : "agent",
          authorUserId: actor.type === "user" ? actor.userId : null,
          authorAgentId: actor.type === "agent" ? actor.agentId : null,
          body: note ?? `Marked ${status.replace("_", " ")} by ${who}.`,
          metadata: { statusChange: { from: review.status, to: status } },
        });
        // Agent status notes are not replies for the Lavish conversation.
        if (actor.type === "agent") {
          await db.update(reviewMessages).set({ lavishDeliveredAt: new Date() }).where(eq(reviewMessages.id, message.id));
        }
        const updated = await patchRow(id, changes);
        if (actor.type === "user" && (status === "approved" || status === "closed")) {
          await wakeResponsibleAgent(updated, message, status, { type: "user", id: actor.userId ?? "board" });
        }
      } else if (Object.keys(changes).length > 0) {
        await patchRow(id, changes);
      }
      announce(review);
      return (await getDetail(id))!;
    },

    async addMessage(id: string, input: CreateReviewMessage, actor: ReviewActor): Promise<ReviewItemDetail> {
      const review = await getRow(id);
      if (!review) throw notFound("Review not found");
      if (actor.type === "user") {
        await recordUserFeedback(review, { body: input.body, source: "paperclip", userId: actor.userId });
      } else {
        await insertMessage(review, { authorType: "agent", authorAgentId: actor.agentId, body: input.body });
        const updated = input.readyForReview === false
          ? review
          : await patchRow(id, { status: "pending_review", resolvedAt: null });
        try {
          await deliverPendingReplies(updated);
        } catch (err) {
          // The poller retries undelivered replies on its next tick.
          logger.info({ err, reviewId: id }, "lavish reply delivery deferred");
        }
      }
      announce(review);
      return (await getDetail(id))!;
    },

    /** Resolve the sandboxed HTML (or a sibling asset) behind a content token. */
    async readContent(token: string, relativePath: string): Promise<ReviewContent | null> {
      await ensureReviewSchema(db);
      const [row] = await db
        .select({ filePath: reviewItems.filePath, inlineHtml: reviewItems.inlineHtml })
        .from(reviewItems)
        .where(eq(reviewItems.contentToken, token));
      if (!row) return null;
      if (row.inlineHtml) return relativePath === "index.html" ? { kind: "inline", html: row.inlineHtml } : null;
      if (!row.filePath) return null;
      return resolveSiblingFile(row.filePath, relativePath);
    },

    /**
     * One poller tick: deliver queued agent replies to Lavish, then collect any
     * user feedback with a zero-timeout poll. Never holds a connection open.
     */
    async pollLavish(companyId?: string): Promise<ReviewPollResult> {
      await ensureReviewSchema(db);
      const rows = await db
        .select()
        .from(reviewItems)
        .where(and(
          eq(reviewItems.lavishEnabled, true),
          isNull(reviewItems.lavishEndedAt),
          inArray(reviewItems.status, [...OPEN_REVIEW_ITEM_STATUSES]),
          companyId ? eq(reviewItems.companyId, companyId) : undefined,
        ))
        .orderBy(asc(reviewItems.lavishLastPolledAt))
        .limit(200);
      const result: ReviewPollResult = { polled: 0, feedbackBatches: 0, repliesDelivered: 0, errors: 0 };
      let serverStartAttempted = false;
      for (const row of rows) {
        if (!row.filePath) continue;
        const filePath = row.filePath;
        const cycle = async () => {
          result.repliesDelivered += await deliverPendingReplies(row);
          return lavish.poll(filePath);
        };
        let lastError: string | null = null;
        let sessionUrl = row.lavishSessionUrl;
        let changed = false;
        try {
          let pollResult: LavishPollResult;
          try {
            pollResult = await cycle();
          } catch (err) {
            const serverDown = err instanceof LavishUnavailableError && !serverStartAttempted;
            const sessionMissing = err instanceof LavishRequestError && err.status === 404;
            if (!serverDown && !sessionMissing) throw err;
            // The detached Lavish server idles out and its sessions can be
            // pruned; reopening the session restarts/recreates both.
            if (serverDown) serverStartAttempted = true;
            sessionUrl = (await lavish.ensureSession(filePath)).url ?? sessionUrl;
            pollResult = await cycle();
          }
          result.polled += 1;
          result.feedbackBatches += await applyPollResult(row, pollResult);
          changed = pollResult.status !== "waiting";
        } catch (err) {
          result.errors += 1;
          lastError = err instanceof Error ? err.message : String(err);
          logger.warn({ err, reviewId: row.id }, "lavish review poll failed");
        }
        await db
          .update(reviewItems)
          .set({ lavishLastPolledAt: new Date(), lavishLastError: lastError, lavishSessionUrl: sessionUrl })
          .where(eq(reviewItems.id, row.id));
        if (changed || lastError !== row.lavishLastError) announce(row);
      }
      return result;
    },
  };
}

async function assertReadableHtmlFile(filePath: string) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw badRequest(`filePath is not a readable file on the Paperclip host: ${filePath}`);
  }
}

/**
 * Serve only files inside the review HTML's own directory, with an extension
 * allowlist and no dot-segments, after resolving symlinks.
 */
export async function resolveSiblingFile(htmlPath: string, relativePath: string): Promise<ReviewContent | null> {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment.startsWith("."))) return null;
  let baseDir: string;
  let target: string;
  try {
    baseDir = path.dirname(await realpath(htmlPath));
    target = await realpath(path.resolve(baseDir, ...segments));
  } catch {
    return null;
  }
  if (!target.startsWith(baseDir + path.sep)) return null;
  const contentType = SIBLING_CONTENT_TYPES[path.extname(target).toLowerCase()];
  if (!contentType) return null;
  const info = await stat(target).catch(() => null);
  if (!info?.isFile() || info.size > MAX_SIBLING_BYTES) return null;
  return { kind: "file", path: target, contentType };
}

export async function readReviewHtml(content: ReviewContent): Promise<string> {
  return content.kind === "inline" ? content.html : readFile(content.path, "utf8");
}
