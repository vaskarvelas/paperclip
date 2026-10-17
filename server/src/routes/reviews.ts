import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createReviewMessageSchema,
  createReviewSchema,
  listReviewsQuerySchema,
  updateReviewSchema,
  type CreateReview,
  type CreateReviewMessage,
  type UpdateReview,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { heartbeatService, logActivity } from "../services/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { readReviewHtml, reviewService, type ReviewActor } from "../services/reviews.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Review content runs untrusted agent HTML. The CSP sandbox gives it an opaque
 * origin even when opened directly, so it can never read Paperclip cookies,
 * storage, or call the API as the board user.
 */
const REVIEW_CONTENT_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors 'self'";

function reviewActor(req: Request): ReviewActor {
  const actor = getActorInfo(req);
  return actor.actorType === "agent"
    ? { type: "agent", agentId: actor.actorId, runId: actor.runId }
    : { type: "user", userId: req.actor.userId ?? null };
}

export function reviewRoutes(db: Db, options: { pluginWorkerManager?: PluginWorkerManager } = {}) {
  const router = Router();
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const svc = reviewService(db, { wakeAgent: (agentId, wakeOptions) => heartbeat.wakeup(agentId, wakeOptions) });
  async function loadAccessible<T extends { companyId: string }>(
    req: Request,
    res: Response,
    promise: Promise<T | null>,
  ): Promise<T | null> {
    const resource = await promise;
    if (!resource || !hasCompanyAccess(req, resource.companyId)) {
      res.status(404).json({ error: "Review not found" });
      return null;
    }
    assertCompanyAccess(req, resource.companyId);
    return resource;
  }

  async function logReviewActivity(req: Request, companyId: string, action: string, reviewId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "review",
      entityId: reviewId,
      details,
    });
  }

  router.get("/companies/:companyId/reviews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, listReviewsQuerySchema.parse(req.query)));
  });

  router.get("/companies/:companyId/reviews/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.counts(companyId));
  });

  /** Run the Lavish feedback poll for this company now instead of waiting for the next tick. */
  router.post("/companies/:companyId/reviews/poll", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await svc.pollLavish(companyId));
  });

  router.post("/companies/:companyId/reviews", validate(createReviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as CreateReview;
    const actor = reviewActor(req);
    const agentId = body.agentId ?? (actor.type === "agent" ? actor.agentId : null);
    if (!agentId) throw badRequest("agentId is required when a board user creates a review");
    const review = await svc.create(companyId, { ...body, agentId }, actor);
    await logReviewActivity(req, companyId, "review.created", review.id, {
      title: review.title,
      kind: review.kind,
      lavish: review.lavishEnabled,
      issueId: review.issueId,
    });
    res.status(201).json(review);
  });

  router.get("/reviews/:id", async (req, res) => {
    const review = await loadAccessible(req, res, svc.getById(req.params.id as string));
    if (!review) return;
    res.json(review);
  });

  router.patch("/reviews/:id", validate(updateReviewSchema), async (req, res) => {
    const existing = await loadAccessible(req, res, svc.getRow(req.params.id as string));
    if (!existing) return;
    const body = req.body as UpdateReview;
    const review = await svc.update(existing.id, body, reviewActor(req));
    await logReviewActivity(req, existing.companyId, "review.updated", existing.id, {
      fields: Object.keys(body).filter((key) => key !== "html"),
      ...(body.status ? { fromStatus: existing.status, toStatus: review.status } : {}),
    });
    res.json(review);
  });

  router.post("/reviews/:id/messages", validate(createReviewMessageSchema), async (req, res) => {
    const existing = await loadAccessible(req, res, svc.getRow(req.params.id as string));
    if (!existing) return;
    const review = await svc.addMessage(existing.id, req.body as CreateReviewMessage, reviewActor(req));
    await logReviewActivity(req, existing.companyId, "review.message_created", existing.id, {
      status: review.status,
    });
    res.status(201).json(review);
  });

  /**
   * Token-addressed, unauthenticated content route: sandboxed iframes have an
   * opaque origin and cannot send session cookies, so the per-review random
   * token is the capability. Only the review HTML and allowlisted sibling
   * assets inside its own directory are reachable.
   */
  router.get("/review-content/:token/{*assetPath}", async (req, res) => {
    const rawPath = req.params.assetPath;
    const assetPath = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath ?? "");
    const content = await svc.readContent(req.params.token as string, assetPath);
    res.setHeader("Content-Security-Policy", REVIEW_CONTENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (!content) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    if (content.kind === "inline" || content.contentType.startsWith("text/html")) {
      res.type("text/html; charset=utf-8").send(await readReviewHtml(content));
      return;
    }
    // The path is already contained and allowlisted; agents commonly write
    // review pages under dot-directories such as `.lavish/`.
    res.setHeader("Content-Type", content.contentType);
    res.sendFile(content.path, { dotfiles: "allow" });
  });

  return router;
}
