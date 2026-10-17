import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, type Db } from "@paperclipai/db";
import { LavishUnavailableError, type LavishClient, type LavishPollResult } from "../services/lavish-client.js";
import { resolveSiblingFile, reviewService } from "../services/reviews.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function fakeLavish(polls: LavishPollResult[] = []) {
  const queue = [...polls];
  const client = {
    ensureSession: vi.fn(async () => ({ url: "http://lavish.test/session/abc", status: "opened" })),
    poll: vi.fn(async (): Promise<LavishPollResult> => queue.shift() ?? { status: "waiting" }),
    reply: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  } satisfies LavishClient;
  return { client, queue };
}

describe("resolveSiblingFile", () => {
  let dir: string;
  let outside: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-review-content-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-review-outside-"));
    await writeFile(path.join(dir, "report.html"), "<h1>report</h1>");
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "assets", "chart.png"), "png");
    await writeFile(path.join(dir, "notes.sh"), "echo hi");
    await writeFile(path.join(dir, ".env"), "SECRET=1");
    await writeFile(path.join(outside, "secret.css"), "body{}");
    await symlink(path.join(outside, "secret.css"), path.join(dir, "linked.css"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("serves allowlisted files inside the review's own directory", async () => {
    const html = path.join(dir, "report.html");
    expect(await resolveSiblingFile(html, "report.html")).toMatchObject({ kind: "file", contentType: "text/html; charset=utf-8" });
    expect(await resolveSiblingFile(html, "assets/chart.png")).toMatchObject({ kind: "file", contentType: "image/png" });
  });

  it("refuses traversal, dotfiles, symlink escapes and non-allowlisted extensions", async () => {
    const html = path.join(dir, "report.html");
    expect(await resolveSiblingFile(html, "../" + path.basename(outside) + "/secret.css")).toBeNull();
    expect(await resolveSiblingFile(html, ".env")).toBeNull();
    expect(await resolveSiblingFile(html, "linked.css")).toBeNull();
    expect(await resolveSiblingFile(html, "notes.sh")).toBeNull();
    expect(await resolveSiblingFile(html, "missing.png")).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewService", () => {
  let temporary: EmbeddedPostgresTestDatabase;
  let db: Db;
  let artifactDir: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-reviews-");
    db = createDb(temporary.connectionString);
    artifactDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-review-artifacts-"));
  }, 30_000);
  afterAll(async () => {
    await temporary?.cleanup();
    await rm(artifactDir, { recursive: true, force: true });
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review co", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Designer" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Landing page", status: "in_progress", assigneeAgentId: agentId });
    const filePath = path.join(artifactDir, `${randomUUID()}.html`);
    await writeFile(filePath, "<h1>v1</h1>");
    return { companyId, agentId, issueId, filePath };
  }

  it("routes Lavish feedback to the responsible agent and stops polling once the user ends the session", async () => {
    const f = await fixture();
    const { client, queue } = fakeLavish();
    const wakeAgent = vi.fn(async () => ({}));
    const svc = reviewService(db, { lavish: client, wakeAgent });
    const review = await svc.create(
      f.companyId,
      { title: "Landing v1", kind: "sample", lavish: true, filePath: f.filePath, issueId: f.issueId, agentId: f.agentId },
      { type: "agent", agentId: f.agentId },
    );
    expect(review).toMatchObject({ status: "pending_review", lavishEnabled: true, lavishSessionUrl: "http://lavish.test/session/abc" });
    expect((await svc.counts(f.companyId)).pending_review).toBe(1);

    expect(await svc.pollLavish(f.companyId)).toMatchObject({ polled: 1, feedbackBatches: 0 });
    expect(wakeAgent).not.toHaveBeenCalled();

    queue.push({
      status: "feedback",
      prompts: [
        { text: "Make the hero darker", selector: "section.hero", tag: "general" },
        { text: "Typo in the footer", tag: "general" },
      ],
      session_ended: true,
      ended_by: "user",
    });
    expect(await svc.pollLavish(f.companyId)).toMatchObject({ polled: 1, feedbackBatches: 1 });

    const detail = (await svc.getById(review.id))!;
    expect(detail.status).toBe("changes_requested");
    expect(detail.lavishEndedBy).toBe("user");
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ authorType: "user", source: "lavish" });
    expect(detail.messages[0]!.body).toContain("on `section.hero`: Make the hero darker");
    expect(detail.messages[0]!.body).toContain("Typo in the footer");

    expect(wakeAgent).toHaveBeenCalledTimes(1);
    const [wokenAgentId, wake] = wakeAgent.mock.calls[0] as unknown as [string, { reason: string; contextSnapshot: Record<string, unknown> }];
    expect(wokenAgentId).toBe(f.agentId);
    expect(wake.reason).toBe("review_feedback");
    expect(wake.contextSnapshot).toMatchObject({ issueId: f.issueId, reviewId: review.id });
    expect(JSON.stringify(wake.contextSnapshot.paperclipAgentMessage)).toContain("Make the hero darker");

    client.poll.mockClear();
    await svc.pollLavish(f.companyId);
    expect(client.poll).not.toHaveBeenCalled();
  });

  it("queues agent replies while Lavish is down and delivers them after restarting the server", async () => {
    const f = await fixture();
    const { client } = fakeLavish();
    const svc = reviewService(db, { lavish: client, wakeAgent: async () => ({}) });
    const review = await svc.create(
      f.companyId,
      { title: "Copy draft", kind: "result", lavish: true, filePath: f.filePath, agentId: f.agentId },
      { type: "user", userId: "board-user" },
    );
    await svc.addMessage(review.id, { body: "Please shorten it" }, { type: "user", userId: "board-user" });

    client.reply.mockRejectedValueOnce(new LavishUnavailableError("down"));
    const afterReply = await svc.addMessage(review.id, { body: "Shortened to 80 words." }, { type: "agent", agentId: f.agentId });
    expect(afterReply.status).toBe("pending_review");
    const queued = afterReply.messages.find((message) => message.authorType === "agent")!;
    expect(queued.lavishDeliveredAt).toBeNull();

    client.poll.mockRejectedValueOnce(new LavishUnavailableError("down"));
    const tick = await svc.pollLavish(f.companyId);
    expect(client.ensureSession).toHaveBeenCalledTimes(2);
    expect(tick).toMatchObject({ polled: 1, errors: 0, repliesDelivered: 1 });
    expect(client.reply).toHaveBeenLastCalledWith(f.filePath, "Shortened to 80 words.");
    const delivered = (await svc.getById(review.id))!.messages.find((message) => message.id === queued.id)!;
    expect(delivered.lavishDeliveredAt).not.toBeNull();
  });

  it("lets only the board approve, ends the Lavish session and tells the agent to continue", async () => {
    const f = await fixture();
    const { client } = fakeLavish();
    const wakeAgent = vi.fn(async () => ({}));
    const svc = reviewService(db, { lavish: client, wakeAgent });
    const review = await svc.create(
      f.companyId,
      { title: "Plan", kind: "plan", lavish: true, filePath: f.filePath, agentId: f.agentId },
      { type: "agent", agentId: f.agentId },
    );

    await expect(svc.update(review.id, { status: "approved" }, { type: "agent", agentId: f.agentId })).rejects.toThrow(/Agents may only/);

    const approved = await svc.update(review.id, { status: "approved", note: "Ship it" }, { type: "user", userId: "board-user" });
    expect(approved).toMatchObject({ status: "approved", lavishEndedBy: "paperclip" });
    expect(approved.resolvedAt).not.toBeNull();
    expect(client.end).toHaveBeenCalledWith(f.filePath);
    expect(wakeAgent).toHaveBeenCalledWith(f.agentId, expect.objectContaining({ reason: "review_approved" }));
    expect((await svc.counts(f.companyId)).approved).toBe(1);
    expect((await svc.list(f.companyId, { status: "open", limit: 100 })).reviews.map((item) => item.id)).not.toContain(review.id);
  });

  it("serves inline HTML only at index.html", async () => {
    const f = await fixture();
    const svc = reviewService(db, { lavish: fakeLavish().client });
    const review = await svc.create(
      f.companyId,
      { title: "Question", kind: "question", lavish: false, html: "<p>Pick A or B</p>", agentId: f.agentId },
      { type: "agent", agentId: f.agentId },
    );
    const token = review.contentUrl!.split("/")[3]!;
    expect(await svc.readContent(token, "index.html")).toEqual({ kind: "inline", html: "<p>Pick A or B</p>" });
    expect(await svc.readContent(token, "other.html")).toBeNull();
    expect(await svc.readContent("not-a-token", "index.html")).toBeNull();
  });
});
