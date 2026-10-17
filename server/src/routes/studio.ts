import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  listStudioPagesQuerySchema,
  updateStudioChoiceSchema,
  upsertStudioPageSchema,
  type UpdateStudioChoice,
  type UpsertStudioPage,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { heartbeatService, logActivity } from "../services/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { ReviewActor } from "../services/reviews.js";
import { studioService } from "../services/studio.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

const STUDIO_CONTENT_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors 'self'";

function studioActor(req: Request): ReviewActor {
  const actor = getActorInfo(req);
  return actor.actorType === "agent"
    ? { type: "agent", agentId: actor.actorId, runId: actor.runId }
    : { type: "user", userId: req.actor.userId ?? null };
}

export function studioRoutes(db: Db, options: { pluginWorkerManager?: PluginWorkerManager } = {}) {
  const router = Router();
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const svc = studioService(db, { wakeAgent: (agentId, wakeOptions) => heartbeat.wakeup(agentId, wakeOptions) });

  async function loadAccessible<T extends { companyId: string }>(
    req: Request,
    res: Response,
    promise: Promise<T | null>,
  ): Promise<T | null> {
    const resource = await promise;
    if (!resource || !hasCompanyAccess(req, resource.companyId)) {
      res.status(404).json({ error: "Studio page not found" });
      return null;
    }
    assertCompanyAccess(req, resource.companyId);
    return resource;
  }

  async function logStudioActivity(
    req: Request,
    companyId: string,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "studio_page",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/studio", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, listStudioPagesQuerySchema.parse(req.query)));
  });

  router.post("/companies/:companyId/studio", validate(upsertStudioPageSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as UpsertStudioPage;
    const page = await svc.upsert(companyId, body, studioActor(req));
    await logStudioActivity(req, companyId, "studio_page.upserted", page.id, {
      slug: page.slug,
      category: page.category,
      title: page.title,
    });
    res.status(201).json(page);
  });

  router.get("/studio/:id", async (req, res) => {
    const page = await loadAccessible(req, res, svc.getById(req.params.id as string));
    if (!page) return;
    res.json(page);
  });

  router.patch("/studio/:id/choice", validate(updateStudioChoiceSchema), async (req, res) => {
    const existing = await loadAccessible(req, res, svc.getRow(req.params.id as string));
    if (!existing) return;
    const body = req.body as UpdateStudioChoice;
    const page = await svc.updateChoice(existing.id, body, studioActor(req));
    await logStudioActivity(req, existing.companyId, "studio_page.choice_updated", existing.id, {
      slug: page.slug,
      selectedChoices: page.selectedChoices,
      selectionStatus: page.selectionStatus,
    });
    res.json(page);
  });

  router.get("/studio-content/:token/{*assetPath}", async (req, res) => {
    const rawPath = req.params.assetPath;
    const assetPath = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath ?? "");
    const content = await svc.readContent(req.params.token as string, assetPath);
    res.setHeader("Content-Security-Policy", STUDIO_CONTENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (!content) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    if (content.kind === "inline" || content.contentType.startsWith("text/html")) {
      res.type("text/html; charset=utf-8").send(await svc.readHtml(content));
      return;
    }
    res.setHeader("Content-Type", content.contentType);
    res.sendFile(content.path, { dotfiles: "allow" });
  });

  return router;
}
