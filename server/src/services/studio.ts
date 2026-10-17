import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, reviewItems, studioPages } from "@paperclipai/db";
import {
  STUDIO_PAGE_CATEGORIES,
  type ListStudioPagesQuery,
  type StudioCategoryCounts,
  type StudioChoiceOption,
  type StudioPageCategory,
  type StudioPageItem,
  type StudioPageListResponse,
  type StudioSelectionStatus,
  type UpdateStudioChoice,
  type UpsertStudioPage,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";
import { createLavishClient, type LavishClient } from "./lavish-client.js";
import { publishLiveEvent } from "./live-events.js";
import {
  resolveSiblingFile,
  type ReviewActor,
  type ReviewContent,
} from "./reviews.js";

export interface StudioServiceDeps {
  lavish?: LavishClient;
  wakeAgent?: (agentId: string, options: WakeupOptions) => Promise<unknown>;
  studioRootDir?: string;
}

type StudioRow = typeof studioPages.$inferSelect;

const COPYABLE_EXTENSIONS: Record<string, true> = {
  ".html": true,
  ".htm": true,
  ".css": true,
  ".js": true,
  ".mjs": true,
  ".json": true,
  ".svg": true,
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".gif": true,
  ".webp": true,
  ".avif": true,
  ".ico": true,
  ".mp4": true,
  ".webm": true,
  ".mp3": true,
  ".wav": true,
  ".woff": true,
  ".woff2": true,
  ".ttf": true,
  ".otf": true,
  ".txt": true,
  ".md": true,
  ".csv": true,
};

export function resolveStudioRootDir(override?: string): string {
  if (override) return override;
  if (process.env.PAPERCLIP_STUDIO_DIR) return process.env.PAPERCLIP_STUDIO_DIR;
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return path.join(os.homedir(), ".paperclip", "instances", instanceId, "studio");
}

export function studioContentUrl(row: Pick<StudioRow, "contentToken" | "filePath">): string | null {
  if (!row.filePath) return null;
  return `/api/studio-content/${row.contentToken}/${encodeURIComponent(path.basename(row.filePath))}`;
}

const ensuredStudioSchemas = new WeakMap<object, Promise<void>>();

function ensureStudioSchema(db: Db): Promise<void> {
  let promise = ensuredStudioSchemas.get(db);
  if (!promise) {
    promise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "studio_pages" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
          "slug" text NOT NULL,
          "category" text DEFAULT 'other' NOT NULL,
          "selection_status" text DEFAULT 'awaiting_choice' NOT NULL,
          "title" text NOT NULL,
          "summary" text,
          "agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
          "issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
          "review_id" uuid REFERENCES "review_items"("id") ON DELETE set null,
          "file_path" text,
          "external_url" text,
          "content_token" text NOT NULL,
          "choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
          "selected_choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
          "choice_notes" text,
          "chosen_at" timestamp with time zone,
          "pinned_order" integer DEFAULT 0 NOT NULL,
          "lavish_enabled" boolean DEFAULT false NOT NULL,
          "lavish_session_url" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "studio_pages_company_slug_uq" ON "studio_pages" ("company_id", "slug")`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "studio_pages_content_token_idx" ON "studio_pages" ("content_token")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "studio_pages_company_category_idx" ON "studio_pages" ("company_id", "category", "pinned_order")`);
    })();
    ensuredStudioSchemas.set(db, promise);
  }
  return promise;
}

async function copySiblingAssets(srcDir: string, destDir: string, depth = 0): Promise<void> {
  if (depth > 2) return;
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copySiblingAssets(srcPath, destPath, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!COPYABLE_EXTENSIONS[ext]) continue;
      if (path.resolve(srcPath) === path.resolve(destPath)) continue;
      await copyFile(srcPath, destPath).catch(() => undefined);
    }
  }
}

async function syncFileIntoStudioDir(studioRoot: string, slug: string, sourceFilePath: string): Promise<string> {
  const info = await stat(sourceFilePath).catch(() => null);
  if (!info?.isFile()) {
    throw badRequest(`filePath is not a readable file on the Paperclip host: ${sourceFilePath}`);
  }
  const pageDir = path.join(studioRoot, slug);
  await mkdir(pageDir, { recursive: true });
  const targetHtml = path.join(pageDir, "index.html");
  const srcDir = path.dirname(path.resolve(sourceFilePath));
  if (path.resolve(sourceFilePath) !== path.resolve(targetHtml)) {
    await copyFile(sourceFilePath, targetHtml);
  }
  if (srcDir !== path.resolve(pageDir)) {
    const entries = await readdir(srcDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const srcPath = path.join(srcDir, entry.name);
      if (path.resolve(srcPath) === path.resolve(sourceFilePath)) continue;
      const destPath = path.join(pageDir, entry.name);
      if (entry.isDirectory()) {
        await copySiblingAssets(srcPath, destPath, 1);
      } else if (entry.isFile() && COPYABLE_EXTENSIONS[path.extname(entry.name).toLowerCase()]) {
        await copyFile(srcPath, destPath).catch(() => undefined);
      }
    }
  }
  return targetHtml;
}

export function studioService(db: Db, deps: StudioServiceDeps = {}) {
  const lavish = deps.lavish ?? createLavishClient();
  const wakeAgent = deps.wakeAgent ?? null;
  const studioRootDir = resolveStudioRootDir(deps.studioRootDir);

  async function hydrate(rows: StudioRow[]): Promise<StudioPageItem[]> {
    if (rows.length === 0) return [];
    const agentIds = [...new Set(rows.map((row) => row.agentId).filter((id): id is string => Boolean(id)))];
    const issueIds = [...new Set(rows.map((row) => row.issueId).filter((id): id is string => Boolean(id)))];
    const [agentRows, issueRows] = await Promise.all([
      agentIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; name: string; icon: string | null }>)
        : db.select({ id: agents.id, name: agents.name, icon: agents.icon }).from(agents).where(inArray(agents.id, agentIds)),
      issueIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; identifier: string | null; title: string }>)
        : db.select({ id: issues.id, identifier: issues.identifier, title: issues.title }).from(issues).where(inArray(issues.id, issueIds)),
    ]);
    const agentById = new Map(agentRows.map((row) => [row.id, row]));
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    return rows.map((row) => {
      const agent = row.agentId ? agentById.get(row.agentId) : undefined;
      const issue = row.issueId ? issueById.get(row.issueId) : undefined;
      return {
        id: row.id,
        companyId: row.companyId,
        slug: row.slug,
        category: (STUDIO_PAGE_CATEGORIES.includes(row.category as StudioPageCategory)
          ? row.category
          : "other") as StudioPageCategory,
        selectionStatus: row.selectionStatus as StudioSelectionStatus,
        title: row.title,
        summary: row.summary,
        agentId: row.agentId,
        issueId: row.issueId,
        reviewId: row.reviewId,
        filePath: row.filePath,
        externalUrl: row.externalUrl,
        contentUrl: studioContentUrl(row),
        choices: Array.isArray(row.choices) ? (row.choices as StudioChoiceOption[]) : [],
        selectedChoices: Array.isArray(row.selectedChoices) ? (row.selectedChoices as string[]) : [],
        choiceNotes: row.choiceNotes,
        chosenAt: row.chosenAt?.toISOString() ?? null,
        pinnedOrder: row.pinnedOrder,
        lavishEnabled: row.lavishEnabled,
        lavishSessionUrl: row.lavishSessionUrl,
        agent: agent ? { id: agent.id, name: agent.name, icon: agent.icon ?? null } : null,
        issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  function announce(row: Pick<StudioRow, "companyId" | "id" | "slug">) {
    publishLiveEvent({
      companyId: row.companyId,
      type: "studio.updated",
      payload: { studioPageId: row.id, slug: row.slug },
    });
  }

  async function writeChoicesManifest(companyId: string) {
    try {
      await mkdir(studioRootDir, { recursive: true });
      const rows = await db
        .select()
        .from(studioPages)
        .where(eq(studioPages.companyId, companyId))
        .orderBy(asc(studioPages.pinnedOrder), desc(studioPages.updatedAt));
      const summary: Record<string, unknown> = {};
      for (const row of rows) {
        const entry = {
          id: row.id,
          slug: row.slug,
          title: row.title,
          category: row.category,
          selectionStatus: row.selectionStatus,
          selectedChoices: row.selectedChoices ?? [],
          choiceNotes: row.choiceNotes ?? null,
          chosenAt: row.chosenAt?.toISOString() ?? null,
          filePath: row.filePath ?? null,
          updatedAt: row.updatedAt.toISOString(),
        };
        summary[row.slug] = entry;
        const slugDir = path.join(studioRootDir, row.slug);
        await mkdir(slugDir, { recursive: true });
        await writeFile(path.join(slugDir, "choice.json"), JSON.stringify(entry, null, 2) + "\n", "utf8");
      }
      await writeFile(
        path.join(studioRootDir, "choices.json"),
        JSON.stringify({ updatedAt: new Date().toISOString(), pages: summary }, null, 2) + "\n",
        "utf8",
      );
    } catch (err) {
      logger.warn({ err, companyId }, "failed writing studio choices.json manifest");
    }
  }

  async function wakeResponsibleAgentForChoice(row: StudioRow, requestedByUserId: string | null) {
    if (!wakeAgent || !row.agentId) return;
    const [issue] = row.issueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, row.issueId))
      : [];
    const issueContext = issue && issue.assigneeAgentId === row.agentId && !["done", "cancelled"].includes(issue.status)
      ? { issueId: issue.id, taskId: issue.id }
      : {};
    const selectedList = (row.selectedChoices ?? []).length > 0
      ? (row.selectedChoices ?? []).map((item) => `- ${item}`).join("\n")
      : "- (none selected)";
    const text = [
      `The board recorded a persistent Studio choice on "${row.title}" (slug: ${row.slug}, category: ${row.category}).`,
      "",
      `Selection status: ${row.selectionStatus}`,
      "Selected choice(s):",
      selectedList,
      row.choiceNotes ? `\nBoard notes:\n${row.choiceNotes}` : null,
      "",
      `Studio page id: ${row.id}${issue?.identifier ? ` (issue ${issue.identifier})` : ""}`,
      row.filePath ? `Studio HTML path: ${row.filePath}` : null,
      `Choice manifest: ${path.join(studioRootDir, row.slug, "choice.json")}`,
      `All Studio choices: ${path.join(studioRootDir, "choices.json")}`,
    ].filter((line) => line !== null).join("\n");
    try {
      await wakeAgent(row.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "studio_choice",
        idempotencyKey: `studio-choice:${row.id}:${row.updatedAt.toISOString()}`,
        requestedByActorType: "user",
        requestedByActorId: requestedByUserId ?? "board",
        payload: {
          studioPageId: row.id,
          slug: row.slug,
          selectedChoices: row.selectedChoices,
          choiceNotes: row.choiceNotes,
          issueId: row.issueId,
        },
        contextSnapshot: {
          ...issueContext,
          studioPageId: row.id,
          studioSlug: row.slug,
          wakeReason: "studio_choice",
          source: "studio",
          paperclipAgentMessage: { text, source: "studio", sessionId: row.id },
        },
      });
    } catch (err) {
      logger.warn({ err, studioPageId: row.id, agentId: row.agentId }, "studio choice wake failed");
    }
  }

  async function getRow(id: string): Promise<StudioRow | null> {
    await ensureStudioSchema(db);
    const [row] = await db.select().from(studioPages).where(eq(studioPages.id, id));
    return row ?? null;
  }

  async function getById(id: string): Promise<StudioPageItem | null> {
    const row = await getRow(id);
    if (!row) return null;
    const [item] = await hydrate([row]);
    return item ?? null;
  }

  return {
    getRow,
    getById,

    async list(companyId: string, query: ListStudioPagesQuery): Promise<StudioPageListResponse> {
      await ensureStudioSchema(db);
      const allRows = await db
        .select()
        .from(studioPages)
        .where(eq(studioPages.companyId, companyId))
        .orderBy(asc(studioPages.pinnedOrder), desc(studioPages.updatedAt));
      const counts = Object.fromEntries(STUDIO_PAGE_CATEGORIES.map((category) => [category, 0])) as StudioCategoryCounts;
      let awaitingChoiceCount = 0;
      for (const row of allRows) {
        const cat = (STUDIO_PAGE_CATEGORIES.includes(row.category as StudioPageCategory)
          ? row.category
          : "other") as StudioPageCategory;
        counts[cat] += 1;
        if (row.selectionStatus === "awaiting_choice") awaitingChoiceCount += 1;
      }
      const filteredRows = query.category === "all"
        ? allRows
        : allRows.filter((row) => row.category === query.category);
      return {
        pages: await hydrate(filteredRows),
        counts,
        awaitingChoiceCount,
        studioRootDir,
      };
    },

    async upsert(companyId: string, input: UpsertStudioPage, actor: ReviewActor): Promise<StudioPageItem> {
      await ensureStudioSchema(db);
      const agentId = input.agentId ?? (actor.type === "agent" ? actor.agentId : null);
      if (agentId) {
        const [agent] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
        if (!agent) throw badRequest("agentId does not belong to this company");
      }
      if (input.issueId) {
        const [issue] = await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId)));
        if (!issue) throw badRequest("issueId does not belong to this company");
      }
      if (input.reviewId) {
        const [review] = await db
          .select({ id: reviewItems.id })
          .from(reviewItems)
          .where(and(eq(reviewItems.id, input.reviewId), eq(reviewItems.companyId, companyId)));
        if (!review) throw badRequest("reviewId does not belong to this company");
      }

      let storedFilePath = input.filePath ?? null;
      if (storedFilePath) {
        if (input.copyToStudioDir !== false) {
          storedFilePath = await syncFileIntoStudioDir(studioRootDir, input.slug, storedFilePath);
        } else {
          const info = await stat(storedFilePath).catch(() => null);
          if (!info?.isFile()) {
            throw badRequest(`filePath is not a readable file on the Paperclip host: ${storedFilePath}`);
          }
        }
      }

      let lavishSessionUrl: string | null = null;
      if (input.lavish && storedFilePath) {
        try {
          lavishSessionUrl = (await lavish.ensureSession(storedFilePath)).url;
        } catch (err) {
          logger.warn({ err, slug: input.slug }, "opening lavish session for studio page failed");
        }
      }

      const [existing] = await db
        .select()
        .from(studioPages)
        .where(and(eq(studioPages.companyId, companyId), eq(studioPages.slug, input.slug)));

      let saved: StudioRow;
      if (existing) {
        const [updated] = await db
          .update(studioPages)
          .set({
            category: input.category,
            selectionStatus: input.selectionStatus ?? existing.selectionStatus,
            title: input.title,
            summary: input.summary !== undefined ? input.summary : existing.summary,
            agentId: agentId ?? existing.agentId,
            issueId: input.issueId !== undefined ? input.issueId : existing.issueId,
            reviewId: input.reviewId !== undefined ? input.reviewId : existing.reviewId,
            filePath: storedFilePath ?? existing.filePath,
            externalUrl: input.externalUrl !== undefined ? input.externalUrl : existing.externalUrl,
            choices: input.choices ?? existing.choices,
            selectedChoices: input.selectedChoices ?? existing.selectedChoices,
            choiceNotes: input.choiceNotes !== undefined ? input.choiceNotes : existing.choiceNotes,
            pinnedOrder: input.pinnedOrder ?? existing.pinnedOrder,
            lavishEnabled: input.lavish ? true : existing.lavishEnabled,
            lavishSessionUrl: lavishSessionUrl ?? existing.lavishSessionUrl,
            updatedAt: new Date(),
          })
          .where(eq(studioPages.id, existing.id))
          .returning();
        saved = updated!;
      } else {
        const [inserted] = await db
          .insert(studioPages)
          .values({
            companyId,
            slug: input.slug,
            category: input.category,
            selectionStatus: input.selectionStatus ?? "awaiting_choice",
            title: input.title,
            summary: input.summary ?? null,
            agentId,
            issueId: input.issueId ?? null,
            reviewId: input.reviewId ?? null,
            filePath: storedFilePath,
            externalUrl: input.externalUrl ?? null,
            contentToken: randomBytes(24).toString("base64url"),
            choices: input.choices ?? [],
            selectedChoices: input.selectedChoices ?? [],
            choiceNotes: input.choiceNotes ?? null,
            chosenAt: input.selectedChoices && input.selectedChoices.length > 0 ? new Date() : null,
            pinnedOrder: input.pinnedOrder ?? 0,
            lavishEnabled: Boolean(input.lavish && storedFilePath),
            lavishSessionUrl,
          })
          .returning();
        saved = inserted!;
      }

      await writeChoicesManifest(companyId);
      announce(saved);
      return (await getById(saved.id))!;
    },

    async updateChoice(id: string, input: UpdateStudioChoice, actor: ReviewActor): Promise<StudioPageItem> {
      const existing = await getRow(id);
      if (!existing) throw notFound("Studio page not found");
      const hasChoice = input.selectedChoices.length > 0 || Boolean(input.choiceNotes?.trim());
      const nextStatus: StudioSelectionStatus = input.selectionStatus
        ?? (hasChoice ? "choice_made" : "awaiting_choice");
      const [updated] = await db
        .update(studioPages)
        .set({
          selectedChoices: input.selectedChoices,
          choiceNotes: input.choiceNotes?.trim() ? input.choiceNotes.trim() : null,
          selectionStatus: nextStatus,
          chosenAt: hasChoice ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(studioPages.id, id))
        .returning();
      const saved = updated!;
      await writeChoicesManifest(saved.companyId);
      if (input.notifyAgent && actor.type === "user") {
        await wakeResponsibleAgentForChoice(saved, actor.userId);
      }
      announce(saved);
      return (await getById(saved.id))!;
    },

    async readContent(token: string, relativePath: string): Promise<ReviewContent | null> {
      await ensureStudioSchema(db);
      const [row] = await db
        .select({ filePath: studioPages.filePath })
        .from(studioPages)
        .where(eq(studioPages.contentToken, token));
      if (!row?.filePath) return null;
      return resolveSiblingFile(row.filePath, relativePath);
    },

    async readHtml(content: ReviewContent): Promise<string> {
      const raw = content.kind === "inline" ? content.html : await readFile(content.path, "utf8");
      const bridge = '<script>(function(){window.paperclipStudio={select:function(choice){try{window.parent.postMessage({type:"paperclip:studio-select",choice:String(choice||"")},"*");}catch(e){}}};})();</script>';
      if (raw.includes("</head>")) return raw.replace("</head>", `${bridge}</head>`);
      if (raw.includes("<body")) return raw.replace("<body", `${bridge}<body`);
      return `${bridge}${raw}`;
    },
  };
}
