import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Thin client for a local lavish-axi review server.
 *
 * Feedback polling and agent replies use the server's JSON HTTP API with a
 * zero timeout, so Paperclip never holds a long poll open. The CLI is used
 * only to open/resume a session (which also starts the detached server).
 */

const lavishPromptSchema = z
  .object({
    uid: z.string().optional(),
    prompt: z.string().optional(),
    selector: z.string().optional(),
    tag: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();
export type LavishPrompt = z.infer<typeof lavishPromptSchema>;

/** `GET /api/poll` response: `waiting`, `feedback` (with prompts), or `ended`. */
export const lavishPollResultSchema = z
  .object({
    status: z.string(),
    prompts: z.array(lavishPromptSchema).optional(),
    session_ended: z.boolean().optional(),
    ended_by: z.string().nullable().optional(),
  })
  .passthrough();
export type LavishPollResult = z.infer<typeof lavishPollResultSchema>;

export interface LavishSessionInfo {
  url: string | null;
  status: string | null;
}

export interface LavishClient {
  ensureSession(filePath: string): Promise<LavishSessionInfo>;
  poll(filePath: string): Promise<LavishPollResult>;
  reply(filePath: string, text: string): Promise<void>;
  end(filePath: string): Promise<void>;
}

/** The review server is not reachable (not started, or stopped after idling). */
export class LavishUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LavishUnavailableError";
  }
}

export class LavishRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LavishRequestError";
  }
}

export interface LavishClientOptions {
  baseUrl?: string;
  bin?: string | null;
  requestTimeoutMs?: number;
  cliTimeoutMs?: number;
}

export function resolveLavishBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PAPERCLIP_LAVISH_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number(env.LAVISH_AXI_PORT) || 4387;
  return `http://127.0.0.1:${port}`;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Service managers often run Paperclip with a minimal PATH, so look in the
 * usual per-user install locations as well as PATH.
 */
export async function resolveLavishBin(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env.PAPERCLIP_LAVISH_BIN?.trim();
  if (explicit) return explicit;
  const home = os.homedir();
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, "lavish-axi")),
    path.join(home, ".local", "bin", "lavish-axi"),
    path.join(home, ".npm-global", "bin", "lavish-axi"),
    "/usr/local/bin/lavish-axi",
  ];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function lavishSessionKey(filePath: string): Promise<string> {
  const canonical = await realpath(filePath);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function parseLavishOpenOutput(stdout: string): LavishSessionInfo {
  const url = /^\s*url:\s*"?([^"\s]+)"?\s*$/m.exec(stdout)?.[1] ?? null;
  const status = /^\s*status:\s*"?([\w-]+)"?\s*$/m.exec(stdout)?.[1] ?? null;
  return { url, status };
}

const CONNECTION_FAILURE_CODES: Record<string, true> = {
  ECONNREFUSED: true,
  ECONNRESET: true,
  EHOSTUNREACH: true,
  UND_ERR_SOCKET: true,
};

/** fetch() wraps socket errors: the errno code lives on `error.cause`. */
function isConnectionFailure(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  for (const candidate of [cause, error]) {
    if (candidate && typeof candidate === "object" && "code" in candidate && typeof candidate.code === "string") {
      return CONNECTION_FAILURE_CODES[candidate.code] === true;
    }
  }
  return false;
}

export function createLavishClient(options: LavishClientOptions = {}): LavishClient {
  const baseUrl = (options.baseUrl ?? resolveLavishBaseUrl()).replace(/\/+$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const cliTimeoutMs = options.cliTimeoutMs ?? 45_000;
  let binPromise: Promise<string | null> | null = options.bin !== undefined ? Promise.resolve(options.bin) : null;

  async function request(pathname: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (isConnectionFailure(error)) {
        throw new LavishUnavailableError(`Lavish server is not reachable at ${baseUrl}`, { cause: error });
      }
      throw error;
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
      throw new LavishRequestError(error ?? `Lavish request failed (${response.status})`, response.status);
    }
    return body;
  }

  return {
    async ensureSession(filePath) {
      binPromise ??= resolveLavishBin();
      const bin = await binPromise;
      if (!bin) {
        throw new LavishUnavailableError(
          "lavish-axi CLI not found; install it (npm i -g lavish-axi) or set PAPERCLIP_LAVISH_BIN",
        );
      }
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          bin,
          [filePath, "--no-open"],
          {
            timeout: cliTimeoutMs,
            maxBuffer: 1_000_000,
            env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" },
          },
          (error, out, err) => {
            if (error) {
              reject(new Error(`lavish-axi open failed: ${String(err || out || error.message).trim().slice(0, 500)}`));
              return;
            }
            resolve(String(out));
          },
        );
      });
      return parseLavishOpenOutput(stdout);
    },

    async poll(filePath) {
      const query = new URLSearchParams({ file: filePath, timeoutMs: "0" });
      return lavishPollResultSchema.parse(await request(`/api/poll?${query.toString()}`));
    },

    async reply(filePath, text) {
      const key = await lavishSessionKey(filePath);
      await request(`/api/${key}/agent-reply`, { method: "POST", body: JSON.stringify({ text }) });
    },

    async end(filePath) {
      await request("/api/end", { method: "POST", body: JSON.stringify({ file: filePath }) });
    },
  };
}
