/**
 * Minimal A2A (Agent-to-Agent) client built on Node's global `fetch`.
 *
 * Implements Agent Card discovery, JSON-RPC 2.0 `message/send`, `message/stream`
 * (Server-Sent Events), `tasks/get`, and `tasks/cancel` with no external
 * dependencies.
 *
 * Security defaults:
 * - Only `https:` origins are accepted, except `http://127.0.0.1`, `http://localhost`,
 *   and `http://[::1]` for local development and tests.
 * - Redirects are never followed (`redirect: "error"`), so credentials cannot be
 *   replayed to a different origin.
 * - Response bodies are byte-capped (64 KiB for Agent Cards, 4 MiB for RPC/SSE).
 * - Error messages never include outbound header values.
 */

export const AGENT_CARD_PATH = "/.well-known/agent.json";
export const AGENT_DIRECTORY_PATH = "/a2a";
export const MAX_AGENT_CARD_BYTES = 64 * 1024;
export const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_SSE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const FILES_PATH = "/files";
export const DEFAULT_TIMEOUT_MS = 60_000;

export const REPLY_WITHHELD = "reply_withheld";

/** Task states that end a conversation turn (no further events expected). */
export const TERMINAL_STATES = Object.freeze(
  new Set(["completed", "failed", "canceled", "rejected", "input-required", "auth-required", REPLY_WITHHELD]),
);

const LOCAL_HOSTS = Object.freeze(new Set(["127.0.0.1", "localhost", "[::1]", "::1"]));

/**
 * Error raised for transport, protocol, or JSON-RPC failures.
 */
export class A2AError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number | string; status?: number; data?: unknown; reason?: string; cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message, info.cause !== undefined ? { cause: info.cause } : undefined);
    this.name = "A2AError";
    this.code = info.code;
    this.status = info.status;
    this.data = info.data;
    this.reason = info.reason;
  }
}

/**
 * Validates that a base URL is HTTPS (or loopback HTTP) and returns the normalized origin + path.
 *
 * @param {string | URL} baseUrl
 * @returns {URL}
 */
export function assertAllowedBaseUrl(baseUrl) {
  if (baseUrl === undefined || baseUrl === null || baseUrl === "") {
    throw new A2AError("A2A base URL is required (set PI_A2A_URL or pass url)");
  }
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch (cause) {
    throw new A2AError(`Invalid A2A base URL: ${String(baseUrl)}`, { cause });
  }
  if (url.username || url.password) {
    throw new A2AError("A2A base URL must not embed credentials");
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) {
    return url;
  }
  throw new A2AError(
    `A2A base URL must use https:// (http:// is only allowed for 127.0.0.1, localhost, or [::1]); got ${url.protocol}//${url.host}`,
  );
}

/**
 * Validates an agent path segment.
 *
 * @param {unknown} agent
 * @returns {string | undefined}
 */
function normalizeAgent(agent) {
  if (agent === undefined || agent === null || agent === "") {
    return undefined;
  }
  const value = String(agent).trim();
  if (!AGENT_NAME_PATTERN.test(value)) {
    throw new A2AError(
      "Agent name must be 1-63 characters of lowercase letters, digits, or '-' and must start with a letter or digit (e.g. observability, pgm, main)",
    );
  }
  return value;
}

/** Valid agent names, e.g. `observability`, `traffic-insights`, `main`. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Validates a single URL path segment (task id or file name) so it cannot traverse
 * directories or smuggle extra segments, encoded separators, or query strings.
 *
 * @param {unknown} value
 * @param {RegExp} pattern
 * @param {string} label
 * @returns {string}
 */
function assertSegment(value, pattern, label) {
  if (typeof value !== "string" || value === "") {
    throw new A2AError(`${label} is required`);
  }
  if (!pattern.test(value) || value.includes("..")) {
    throw new A2AError(
      `Invalid ${label}: must be a single path segment of letters, digits, '.', '_', '-' (no slashes, '..', or encoded characters)`,
    );
  }
  return value;
}

/**
 * Throws unless `baseUrl` has the same origin as `pinnedOrigin` (when given). Used so
 * credentials resolved for one gateway are never sent to another.
 *
 * @param {string | URL} baseUrl
 * @param {string | URL | undefined} pinnedOrigin
 */
function assertPinnedOrigin(baseUrl, pinnedOrigin) {
  if (pinnedOrigin === undefined || pinnedOrigin === null || pinnedOrigin === "") return;
  const requested = assertAllowedBaseUrl(baseUrl).origin;
  let pinned;
  try {
    pinned = new URL(String(pinnedOrigin)).origin;
  } catch {
    throw new A2AError("Invalid pinned origin");
  }
  if (requested !== pinned) {
    throw new A2AError(`Refusing to send credentials to cross-origin URL ${requested} (pinned origin: ${pinned}).`);
  }
}

/**
 * Builds an absolute URL below the base URL for an optional agent.
 *
 * @param {string | URL} baseUrl
 * @param {string | undefined} agent
 * @param {string} path  Path beginning with "/" (relative to the agent root).
 * @returns {string}
 */
export function buildAgentUrl(baseUrl, agent, path = "") {
  const base = assertAllowedBaseUrl(baseUrl);
  const normalizedAgent = normalizeAgent(agent);
  const basePath = base.pathname.replace(/\/+$/, "");
  const agentPath = normalizedAgent ? `${AGENT_DIRECTORY_PATH}/${encodeURIComponent(normalizedAgent)}` : "";
  const target = new URL(base.toString());
  target.pathname = `${basePath}${agentPath}${path}` || "/";
  target.search = "";
  target.hash = "";
  return target.toString();
}

/**
 * Returns the JSON-RPC endpoint for an agent (the agent root).
 *
 * @param {string | URL} baseUrl
 * @param {string | undefined} agent
 */
export function buildRpcUrl(baseUrl, agent) {
  return buildAgentUrl(baseUrl, agent, "");
}

/**
 * Merges caller headers with defaults, dropping undefined values. Header names are lower-cased.
 *
 * @param {Record<string, string> | undefined} headers
 * @param {Record<string, string>} defaults
 * @returns {Record<string, string>}
 */
function mergeHeaders(headers, defaults) {
  /** @type {Record<string, string>} */
  const merged = {};
  for (const [name, value] of Object.entries(defaults)) {
    merged[name.toLowerCase()] = value;
  }
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      const lower = String(name).trim().toLowerCase();
      if (!lower) continue;
      if (/[\r\n\0]/.test(String(value))) {
        throw new A2AError(`Invalid control characters in header "${lower}" (value redacted)`);
      }
      merged[lower] = String(value);
    }
  }
  return merged;
}

/**
 * Combines an optional caller signal with a timeout.
 *
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal; cleanup: () => void }}
 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new A2AError(`A2A request timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Reads a response body as UTF-8 text, aborting once `maxBytes` is exceeded.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readBodyCapped(response, maxBytes) {
  return (await readBytesCapped(response, maxBytes)).toString("utf8");
}

/**
 * Reads a response body as bytes, aborting once `maxBytes` is exceeded.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readBytesCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new A2AError(`Response body of ${declared} bytes exceeds limit of ${maxBytes} bytes`, {
      status: response.status,
    });
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new A2AError(`Response body exceeds limit of ${maxBytes} bytes`, { status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {});
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

/**
 * Performs a fetch with redirect:"error", a timeout, and a byte-capped body read.
 *
 * @param {string} url
 * @param {{
 *   method?: string;
 *   headers?: Record<string, string>;
 *   body?: string | Uint8Array;
 *   signal?: AbortSignal;
 *   maxBytes: number;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<{ status: number; headers: Headers; text: string; bytes: Buffer }>}
 */
async function fetchCapped(url, options) {
  const { signal, cleanup } = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: "error",
        signal,
      });
    } catch (cause) {
      if (signal.aborted && signal.reason instanceof A2AError) throw signal.reason;
      throw new A2AError(`A2A request to ${redactUrl(url)} failed: ${describeCause(cause)}`, { cause });
    }
    const bytes = await readBytesCapped(response, options.maxBytes);
    return { status: response.status, headers: response.headers, text: bytes.toString("utf8"), bytes };
  } finally {
    cleanup();
  }
}

/**
 * @param {unknown} cause
 */
function describeCause(cause) {
  if (cause && typeof cause === "object") {
    const err = /** @type {{ message?: string; cause?: { code?: string; message?: string } }} */ (cause);
    const inner = err.cause?.code ?? err.cause?.message;
    return inner ? `${err.message ?? "error"} (${inner})` : (err.message ?? "error");
  }
  return String(cause);
}

/**
 * Strips query/hash so URLs in error messages never carry tokens.
 *
 * @param {string} url
 */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid url]";
  }
}

/**
 * @param {string} text
 * @param {number} status
 * @returns {unknown}
 */
function parseJsonBody(text, status) {
  if (!text.trim()) {
    throw new A2AError(`Empty response body (HTTP ${status})`, { status });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new A2AError(`Response is not valid JSON (HTTP ${status}): ${snippet(text)}`, { status, cause });
  }
}

/**
 * @param {string} text
 */
function snippet(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

/**
 * Generates a JSON-RPC id / message id.
 */
export function newId() {
  return globalThis.crypto.randomUUID();
}

/**
 * Returns true when a JSON-RPC error object (or HTTP status) means the agent withheld its reply.
 *
 * @param {{ status?: number; error?: { data?: unknown } | null }} input
 */
export function isReplyWithheld(input) {
  if (input.status === 502) return true;
  const data = input.error?.data;
  return Boolean(data && typeof data === "object" && /** @type {{ reason?: unknown }} */ (data).reason === REPLY_WITHHELD);
}

/**
 * Builds an A2AError from a JSON-RPC error object.
 *
 * @param {{ code?: number; message?: string; data?: unknown }} error
 * @param {number} [status]
 */
function rpcError(error, status) {
  const reason =
    error.data && typeof error.data === "object" && typeof (/** @type {any} */ (error.data).reason) === "string"
      ? /** @type {any} */ (error.data).reason
      : undefined;
  return new A2AError(`A2A JSON-RPC error ${error.code ?? "?"}: ${error.message ?? "unknown error"}`, {
    code: error.code,
    data: error.data,
    status,
    reason,
  });
}

/**
 * Sends a JSON-RPC 2.0 request and returns the `result`.
 *
 * HTTP 502 and JSON-RPC errors whose `data.reason === "reply_withheld"` are surfaced as
 * `A2AError` with `reason === "reply_withheld"` so callers can treat them as a soft state.
 *
 * @param {{
 *   baseUrl: string | URL;
 *   agent?: string;
 *   method: string;
 *   params: unknown;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<unknown>}
 */
export async function rpcCall(options) {
  assertPinnedOrigin(options?.baseUrl, options?.pinnedOrigin);
  const url = buildRpcUrl(options.baseUrl, options.agent);
  const id = newId();
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: options.method, params: options.params });
  const headers = mergeHeaders(options.headers, {
    "content-type": "application/json",
    accept: "application/json",
  });
  const { status, text } = await fetchCapped(url, {
    method: "POST",
    headers,
    body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_RPC_BODY_BYTES,
    fetchImpl: options.fetchImpl,
  });

  if (status === 502) {
    throw new A2AError("Agent withheld its reply (HTTP 502)", { status, reason: REPLY_WITHHELD });
  }

  let parsed;
  try {
    parsed = parseJsonBody(text, status);
  } catch (err) {
    if (status >= 400) {
      throw new A2AError(`A2A request failed with HTTP ${status}: ${snippet(text) || "(no body)"}`, { status, cause: err });
    }
    throw err;
  }

  const envelope = /** @type {{ jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }} */ (
    parsed
  );
  if (envelope && typeof envelope === "object" && envelope.error) {
    throw rpcError(envelope.error, status);
  }
  if (status >= 400) {
    throw new A2AError(`A2A request failed with HTTP ${status}: ${snippet(text)}`, { status });
  }
  if (!envelope || typeof envelope !== "object" || !("result" in envelope)) {
    throw new A2AError(`Malformed JSON-RPC response (HTTP ${status}): ${snippet(text)}`, { status });
  }
  if (envelope.id !== undefined && envelope.id !== null && envelope.id !== id) {
    throw new A2AError("JSON-RPC response id does not match request id", { status });
  }
  return envelope.result;
}

/**
 * Parses an SSE byte stream into `{ event, data, id }` frames.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ maxBytes?: number }} [options]
 * @returns {AsyncGenerator<{ event: string; data: string; id?: string }>}
 */
export async function* parseSseStream(stream, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_SSE_BYTES;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let total = 0;
  let event = "message";
  /** @type {string[]} */
  let dataLines = [];
  /** @type {string | undefined} */
  let lastId;

  const flush = function* () {
    if (dataLines.length === 0) {
      event = "message";
      return;
    }
    const frame = { event, data: dataLines.join("\n"), id: lastId };
    event = "message";
    dataLines = [];
    yield frame;
  };

  const handleLine = function* (/** @type {string} */ line) {
    if (line === "") {
      yield* flush();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value || "message";
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) lastId = value;
        break;
      default:
        break; // retry and unknown fields are ignored
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new A2AError(`SSE stream exceeds limit of ${maxBytes} bytes`);
      }
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
        yield* handleLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield* handleLine(buffer);
    yield* flush();
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }
}

/**
 * Extracts concatenated text from A2A `parts`.
 *
 * @param {unknown} parts
 * @returns {string}
 */
export function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = /** @type {{ kind?: string; type?: string; text?: unknown }} */ (part);
    const kind = p.kind ?? p.type;
    if ((kind === "text" || kind === undefined) && typeof p.text === "string") {
      texts.push(p.text);
    }
  }
  return texts.join("");
}

/**
 * Normalizes a Task or Message result into `{ taskId, contextId, state, text, raw }`.
 *
 * @param {unknown} result
 * @returns {{ taskId: string | undefined; contextId: string | undefined; state: string; text: string; raw: unknown }}
 */
export function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    return { taskId: undefined, contextId: undefined, state: "unknown", text: "", raw: result };
  }
  const r = /** @type {any} */ (result);
  if (r.kind === "message" || (r.role && Array.isArray(r.parts) && !r.status)) {
    return {
      taskId: r.taskId,
      contextId: r.contextId,
      state: "completed",
      text: textFromParts(r.parts),
      raw: result,
    };
  }
  const state = typeof r.status?.state === "string" ? r.status.state : "unknown";
  const chunks = [];
  if (Array.isArray(r.artifacts)) {
    for (const artifact of r.artifacts) chunks.push(textFromParts(artifact?.parts));
  }
  const statusText = textFromParts(r.status?.message?.parts);
  if (statusText) chunks.push(statusText);
  if (chunks.join("") === "" && Array.isArray(r.history)) {
    for (let i = r.history.length - 1; i >= 0; i -= 1) {
      const msg = r.history[i];
      if (msg?.role === "agent") {
        chunks.push(textFromParts(msg.parts));
        break;
      }
    }
  }
  return {
    taskId: r.id ?? r.taskId,
    contextId: r.contextId,
    state,
    text: chunks.filter(Boolean).join("\n"),
    raw: result,
  };
}

/**
 * Fetches and validates an Agent Card.
 *
 * @param {string} url
 * @param {{ headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchAgentCard(url, options) {
  const { status, text } = await fetchCapped(url, {
    headers: mergeHeaders(options.headers, { accept: "application/json" }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_AGENT_CARD_BYTES,
    fetchImpl: options.fetchImpl,
  });
  if (status === 404) {
    throw new A2AError(`Agent Card not found at ${redactUrl(url)} (HTTP 404)`, { status });
  }
  if (status >= 400) {
    throw new A2AError(`Agent Card request to ${redactUrl(url)} failed with HTTP ${status}`, { status });
  }
  const card = parseJsonBody(text, status);
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new A2AError(`Agent Card at ${redactUrl(url)} is not a JSON object`, { status });
  }
  return /** @type {Record<string, unknown>} */ (card);
}

/**
 * Normalizes a directory listing (`GET /a2a`) into agent names.
 *
 * @param {unknown} directory
 * @returns {Array<{ name: string; description?: string; url?: string }>}
 */
export function normalizeDirectory(directory) {
  const list = Array.isArray(directory)
    ? directory
    : directory && typeof directory === "object" && Array.isArray(/** @type {any} */ (directory).agents)
      ? /** @type {any} */ (directory).agents
      : [];
  /** @type {Array<{ name: string; description?: string; url?: string }>} */
  const agents = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      agents.push({ name: entry });
    } else if (entry && typeof entry === "object") {
      const e = /** @type {any} */ (entry);
      const name = e.name ?? e.id ?? e.agent;
      if (typeof name === "string" && name) {
        agents.push({
          name,
          description: typeof e.description === "string" ? e.description : undefined,
          url: typeof e.url === "string" ? e.url : undefined,
        });
      }
    }
  }
  return agents;
}

/**
 * Summarizes an Agent Card for display.
 *
 * @param {Record<string, unknown>} card
 * @param {string | undefined} agent
 * @param {string} cardUrl
 */
function summarizeCard(card, agent, cardUrl) {
  const skills = Array.isArray(card.skills)
    ? card.skills
        .filter((skill) => skill && typeof skill === "object")
        .map((skill) => {
          const s = /** @type {any} */ (skill);
          return { id: s.id, name: s.name, description: s.description };
        })
    : [];
  const capabilities = card.capabilities && typeof card.capabilities === "object" ? card.capabilities : {};
  return {
    agent,
    name: typeof card.name === "string" ? card.name : agent ?? "(unnamed)",
    description: typeof card.description === "string" ? card.description : undefined,
    url: typeof card.url === "string" ? card.url : undefined,
    version: typeof card.version === "string" ? card.version : undefined,
    streaming: Boolean(/** @type {any} */ (capabilities).streaming),
    skills,
    cardUrl,
    card,
  };
}

/**
 * Discovers A2A agents.
 *
 * - With `agent`: fetches `GET /a2a/{agent}/.well-known/agent.json`.
 * - Without `agent`: fetches `GET /.well-known/agent.json` and the `GET /a2a` directory
 *   (each optional; at least one must succeed) and resolves each directory entry's card.
 *
 * @param {{
 *   baseUrl: string | URL;
 *   agent?: string;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<{ baseUrl: string; agents: Array<ReturnType<typeof summarizeCard>>; directory: Array<{ name: string }>; errors: string[] }>}
 */
export async function discoverAgents(options) {
  assertPinnedOrigin(options?.baseUrl, options?.pinnedOrigin);
  const base = assertAllowedBaseUrl(options.baseUrl);
  const agent = normalizeAgent(options.agent);
  const common = {
    headers: options.headers,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  };

  if (agent) {
    const cardUrl = buildAgentUrl(base, agent, AGENT_CARD_PATH);
    const card = await fetchAgentCard(cardUrl, common);
    return { baseUrl: base.toString(), agents: [summarizeCard(card, agent, cardUrl)], directory: [{ name: agent }], errors: [] };
  }

  /** @type {string[]} */
  const errors = [];
  const rootCardUrl = buildAgentUrl(base, undefined, AGENT_CARD_PATH);
  const directoryUrl = buildAgentUrl(base, undefined, AGENT_DIRECTORY_PATH);

  const [rootCardResult, directoryResult] = await Promise.allSettled([
    fetchAgentCard(rootCardUrl, common),
    fetchCapped(directoryUrl, {
      headers: mergeHeaders(options.headers, { accept: "application/json" }),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: MAX_AGENT_CARD_BYTES,
      fetchImpl: options.fetchImpl,
    }),
  ]);

  /** @type {Array<ReturnType<typeof summarizeCard>>} */
  const agents = [];
  if (rootCardResult.status === "fulfilled") {
    agents.push(summarizeCard(rootCardResult.value, undefined, rootCardUrl));
  } else {
    errors.push(`root card: ${rootCardResult.reason?.message ?? String(rootCardResult.reason)}`);
  }

  /** @type {Array<{ name: string; description?: string; url?: string }>} */
  let directory = [];
  if (directoryResult.status === "fulfilled") {
    const { status, text } = directoryResult.value;
    if (status >= 200 && status < 300) {
      try {
        directory = normalizeDirectory(parseJsonBody(text, status));
      } catch (err) {
        errors.push(`directory: ${/** @type {Error} */ (err).message}`);
      }
    } else {
      errors.push(`directory: HTTP ${status}`);
    }
  } else {
    errors.push(`directory: ${directoryResult.reason?.message ?? String(directoryResult.reason)}`);
  }

  /** @type {Array<{ entry: { name: string; description?: string; url?: string }; name: string; cardUrl: URL }>} */
  const validDirectory = [];
  for (const entry of directory) {
    try {
      const name = normalizeAgent(entry.name);
      if (!name) {
        errors.push("directory entry: agent name is required");
        continue;
      }
      const cardUrl = buildAgentUrl(base, name, AGENT_CARD_PATH);
      validDirectory.push({ entry, name, cardUrl });
    } catch (err) {
      errors.push(`${entry.name}: ${/** @type {Error} */ (err).message}`);
    }
  }

  const cardResults = await Promise.allSettled(
    validDirectory.map(async ({ name, cardUrl }) => {
      const card = await fetchAgentCard(cardUrl, common);
      return summarizeCard(card, name, cardUrl);
    }),
  );
  cardResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      agents.push(result.value);
    } else {
      const { entry, name, cardUrl } = validDirectory[index];
      errors.push(`${name}: ${result.reason?.message ?? String(result.reason)}`);
      agents.push({
        agent: name,
        name: entry.name,
        description: entry.description,
        url: entry.url,
        version: undefined,
        streaming: false,
        skills: [],
        cardUrl,
        card: {},
      });
    }
  });

  if (agents.length === 0) {
    throw new A2AError(`No A2A agents discovered at ${redactUrl(base.toString())}: ${errors.join("; ")}`);
  }
  return { baseUrl: base.toString(), agents, directory, errors };
}

/**
 * Fetches a single Agent Card: `/a2a/{agent}/.well-known/agent.json`, or the root card
 * `/.well-known/agent.json` when `agent` is omitted.
 *
 * @param {{
 *   baseUrl: string | URL;
 *   agent?: string;
 *   pinnedOrigin?: string | URL;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} options
 */
export async function getAgentCard(options) {
  assertPinnedOrigin(options.baseUrl, options.pinnedOrigin);
  const agent = normalizeAgent(options.agent);
  const cardUrl = buildAgentUrl(options.baseUrl, agent, AGENT_CARD_PATH);
  const card = await fetchAgentCard(cardUrl, options);
  return summarizeCard(card, agent, cardUrl);
}

/**
 * Builds the `message/send` / `message/stream` params object.
 *
 * @param {{ message: string; messageId?: string; taskId?: string; contextId?: string; metadata?: Record<string, unknown> }} input
 */
export function buildMessageParams(input) {
  if (typeof input.message !== "string" || !input.message.trim()) {
    throw new A2AError("message must be a non-empty string");
  }
  /** @type {Record<string, unknown>} */
  const message = {
    kind: "message",
    role: "user",
    messageId: input.messageId ?? newId(),
    parts: [{ kind: "text", text: input.message }],
  };
  if (input.taskId) message.taskId = String(input.taskId);
  if (input.contextId) message.contextId = String(input.contextId);
  if (input.metadata) message.metadata = input.metadata;
  return { message };
}

/**
 * Sends a message with `message/send` (default) or `message/stream` (SSE).
 *
 * Returns `{ taskId, contextId, state, text, raw }`. When the agent withholds its reply
 * (HTTP 502 or JSON-RPC error with `data.reason === "reply_withheld"`), the returned
 * `state` is `"reply_withheld"` and `error` carries the message; no exception is thrown.
 *
 * @param {{
 *   baseUrl: string | URL;
 *   agent?: string;
 *   message: string;
 *   messageId?: string;
 *   taskId?: string;
 *   contextId?: string;
 *   stream?: boolean;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   onEvent?: (event: { kind: string; state?: string; text?: string; final?: boolean; raw: unknown }) => void;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<{ taskId: string | undefined; contextId: string | undefined; state: string; text: string; raw: unknown; error?: string; events?: unknown[] }>}
 */
export async function sendMessage(options) {
  assertPinnedOrigin(options?.baseUrl, options?.pinnedOrigin);
  const params = buildMessageParams(options);
  if (options.stream) {
    return streamMessage(options, params);
  }
  try {
    const result = await rpcCall({
      baseUrl: options.baseUrl,
      agent: options.agent,
      method: "message/send",
      params,
      headers: options.headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    return normalizeResult(result);
  } catch (err) {
    if (err instanceof A2AError && err.reason === REPLY_WITHHELD) {
      return {
        taskId: options.taskId,
        contextId: options.contextId,
        state: REPLY_WITHHELD,
        text: "",
        raw: err.data ?? null,
        error: err.message,
      };
    }
    throw err;
  }
}

/**
 * @param {Parameters<typeof sendMessage>[0]} options
 * @param {ReturnType<typeof buildMessageParams>} params
 */
async function streamMessage(options, params) {
  const url = buildRpcUrl(options.baseUrl, options.agent);
  const id = newId();
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: "message/stream", params });
  const headers = mergeHeaders(options.headers, {
    "content-type": "application/json",
    accept: "text/event-stream",
  });
  const { signal, cleanup } = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;

  /** @type {unknown[]} */
  const events = [];
  let taskId = options.taskId;
  let contextId = options.contextId;
  let state = "submitted";
  /** @type {Map<string, string>} */
  const artifactText = new Map();
  /** @type {string[]} */
  const messageText = [];
  let statusText = "";

  const collectText = () => {
    const chunks = [...artifactText.values(), ...messageText];
    if (statusText) chunks.push(statusText);
    return chunks.filter(Boolean).join("\n");
  };

  const withheld = (/** @type {string} */ message, /** @type {unknown} */ raw) => ({
    taskId,
    contextId,
    state: REPLY_WITHHELD,
    text: collectText(),
    raw,
    error: message,
    events,
  });

  try {
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal });
    } catch (cause) {
      if (signal.aborted && signal.reason instanceof A2AError) throw signal.reason;
      throw new A2AError(`A2A request to ${redactUrl(url)} failed: ${describeCause(cause)}`, { cause });
    }

    if (response.status === 502) {
      await response.body?.cancel().catch(() => {});
      return withheld("Agent withheld its reply (HTTP 502)", null);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      // Server answered with a plain JSON-RPC response (error or non-streaming result).
      const text = await readBodyCapped(response, MAX_RPC_BODY_BYTES);
      let parsed;
      try {
        parsed = parseJsonBody(text, response.status);
      } catch (err) {
        throw new A2AError(`message/stream failed with HTTP ${response.status}: ${snippet(text) || "(no body)"}`, {
          status: response.status,
          cause: err,
        });
      }
      const envelope = /** @type {any} */ (parsed);
      if (envelope?.error) {
        const err = rpcError(envelope.error, response.status);
        if (err.reason === REPLY_WITHHELD) return withheld(err.message, err.data ?? null);
        throw err;
      }
      if (response.status >= 400) {
        throw new A2AError(`message/stream failed with HTTP ${response.status}: ${snippet(text)}`, { status: response.status });
      }
      const normalized = normalizeResult(envelope?.result);
      return { ...normalized, events: [envelope?.result] };
    }

    if (!response.body) {
      throw new A2AError("message/stream response has no body", { status: response.status });
    }

    for await (const frame of parseSseStream(response.body, { maxBytes: MAX_SSE_BYTES })) {
      if (!frame.data.trim()) continue;
      let envelope;
      try {
        envelope = JSON.parse(frame.data);
      } catch {
        continue; // ignore malformed keep-alive or non-JSON frames
      }
      events.push(envelope);
      if (envelope?.error) {
        const err = rpcError(envelope.error, response.status);
        if (err.reason === REPLY_WITHHELD) return withheld(err.message, err.data ?? null);
        throw err;
      }
      const result = envelope?.result ?? envelope;
      if (!result || typeof result !== "object") continue;
      const kind = result.kind ?? (result.status ? "status-update" : result.artifact ? "artifact-update" : undefined);

      if (result.taskId ?? result.id) taskId = result.taskId ?? result.id;
      if (result.contextId) contextId = result.contextId;

      if (kind === "status-update" || kind === "task") {
        const newState = typeof result.status?.state === "string" ? result.status.state : state;
        state = newState;
        const text = textFromParts(result.status?.message?.parts);
        if (text) statusText = text;
        if (kind === "task" && Array.isArray(result.artifacts)) {
          for (const artifact of result.artifacts) {
            artifactText.set(artifact?.artifactId ?? newId(), textFromParts(artifact?.parts));
          }
        }
        options.onEvent?.({ kind, state: newState, text, final: Boolean(result.final), raw: result });
        if (result.final === true || (kind === "task" && TERMINAL_STATES.has(newState))) break;
      } else if (kind === "artifact-update") {
        const artifact = result.artifact ?? {};
        const key = artifact.artifactId ?? "default";
        const text = textFromParts(artifact.parts);
        artifactText.set(key, result.append ? (artifactText.get(key) ?? "") + text : text);
        state = state === "submitted" ? "working" : state;
        options.onEvent?.({ kind, text, final: Boolean(result.lastChunk), raw: result });
      } else if (kind === "message") {
        const text = textFromParts(result.parts);
        if (text) messageText.push(text);
        state = "completed";
        options.onEvent?.({ kind, state, text, final: true, raw: result });
        break;
      }
    }

    return { taskId, contextId, state, text: collectText(), raw: events[events.length - 1] ?? null, events };
  } finally {
    cleanup();
  }
}

/**
 * Accepts either `fn(options)` (with `options.baseUrl`) or `fn(baseUrl, options)`.
 *
 * @param {any} baseUrlOrOptions
 * @param {any} [maybeOptions]
 * @returns {any}
 */
function withBaseUrl(baseUrlOrOptions, maybeOptions) {
  if (typeof baseUrlOrOptions === "string" || baseUrlOrOptions instanceof URL) {
    return { ...(maybeOptions ?? {}), baseUrl: baseUrlOrOptions };
  }
  return baseUrlOrOptions ?? {};
}

/**
 * Fetches a task with `tasks/get`. Callable as `getTask(options)` or `getTask(baseUrl, options)`.
 *
 * @param {string | URL | {
 *   baseUrl: string | URL;
 *   agent?: string;
 *   taskId: string;
 *   historyLength?: number;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} options
 */
export async function getTask(baseUrlOrOptions, maybeOptions) {
  const options = withBaseUrl(baseUrlOrOptions, maybeOptions);
  assertPinnedOrigin(options.baseUrl, options.pinnedOrigin);
  if (!options.taskId) throw new A2AError("taskId is required");
  /** @type {Record<string, unknown>} */
  const params = { id: String(options.taskId) };
  if (Number.isInteger(options.historyLength)) params.historyLength = options.historyLength;
  const result = await rpcCall({
    baseUrl: options.baseUrl,
    agent: options.agent,
    method: "tasks/get",
    params,
    headers: options.headers,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return normalizeResult(result);
}

/**
 * Cancels a task with `tasks/cancel`.
 *
 * @param {{
 *   baseUrl: string | URL;
 *   agent?: string;
 *   taskId: string;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} options
 */
export async function cancelTask(baseUrlOrOptions, maybeOptions) {
  const options = withBaseUrl(baseUrlOrOptions, maybeOptions);
  assertPinnedOrigin(options.baseUrl, options.pinnedOrigin);
  if (!options.taskId) throw new A2AError("taskId is required");
  const result = await rpcCall({
    baseUrl: options.baseUrl,
    agent: options.agent,
    method: "tasks/cancel",
    params: { id: String(options.taskId) },
    headers: options.headers,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return normalizeResult(result);
}

/**
 * Builds `<base>/files/{taskId}/{name}` after validating both segments.
 *
 * @param {string | URL} baseUrl
 * @param {string} taskId
 * @param {string} name
 */
export function buildFileUrl(baseUrl, taskId, name) {
  const id = assertSegment(taskId, TASK_ID_PATTERN, "taskId");
  const file = assertSegment(name, FILE_NAME_PATTERN, "file name");
  return buildAgentUrl(baseUrl, undefined, `${FILES_PATH}/${encodeURIComponent(id)}/${encodeURIComponent(file)}`);
}

/**
 * Uploads a file into a task's staging area: `POST /files/{taskId}/{name}`.
 *
 * Callable as `sendFile(baseUrl, options)` or `sendFile({ baseUrl, ...options })`.
 * `content` may be a string (UTF-8), `Buffer`, or `Uint8Array` (max 8 MiB).
 * When `pinnedOrigin` is given, the call is refused unless `baseUrl` has the same origin,
 * so credentials from `headers` cannot leak to another host.
 *
 * @param {string | URL | Record<string, any>} baseUrlOrOptions
 * @param {{
 *   taskId: string;
 *   name: string;
 *   content: string | Uint8Array;
 *   contentType?: string;
 *   pinnedOrigin?: string | URL;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} [maybeOptions]
 * @returns {Promise<{ taskId: string; name: string; size: number; status: number; response: unknown; url: string }>}
 */
export async function sendFile(baseUrlOrOptions, maybeOptions) {
  const options = withBaseUrl(baseUrlOrOptions, maybeOptions);
  assertPinnedOrigin(options.baseUrl, options.pinnedOrigin);
  const url = buildFileUrl(options.baseUrl, options.taskId, options.name);
  const content = options.content;
  if (typeof content !== "string" && !(content instanceof Uint8Array)) {
    throw new A2AError("content must be a string or Uint8Array");
  }
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (body.byteLength > MAX_FILE_BYTES) {
    throw new A2AError(`File of ${body.byteLength} bytes exceeds limit of ${MAX_FILE_BYTES} bytes`);
  }
  const contentType = options.contentType ?? "application/octet-stream";
  const { status, text } = await fetchCapped(url, {
    method: "POST",
    headers: mergeHeaders(options.headers, { "content-type": contentType, accept: "application/json" }),
    body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_RPC_BODY_BYTES,
    fetchImpl: options.fetchImpl,
  });
  if (status < 200 || status >= 300) {
    throw new A2AError(`File upload to ${redactUrl(url)} failed with HTTP ${status}: ${snippet(text) || "(no body)"}`, {
      status,
    });
  }
  let response = null;
  if (text.trim()) {
    try {
      response = JSON.parse(text);
    } catch {
      response = text;
    }
  }
  return { taskId: options.taskId, name: options.name, size: body.byteLength, status, response, url: redactUrl(url) };
}

/**
 * Downloads a staged task file: `GET /files/{taskId}/{name}` (max 8 MiB).
 *
 * Callable as `getFile(baseUrl, options)` or `getFile({ baseUrl, ...options })`.
 *
 * @param {string | URL | Record<string, any>} baseUrlOrOptions
 * @param {{
 *   taskId: string;
 *   name: string;
 *   pinnedOrigin?: string | URL;
 *   headers?: Record<string, string>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 * }} [maybeOptions]
 * @returns {Promise<{ taskId: string; name: string; size: number; contentType: string; content: Buffer; text: string; url: string }>}
 */
export async function getFile(baseUrlOrOptions, maybeOptions) {
  const options = withBaseUrl(baseUrlOrOptions, maybeOptions);
  assertPinnedOrigin(options.baseUrl, options.pinnedOrigin);
  const url = buildFileUrl(options.baseUrl, options.taskId, options.name);
  const { status, headers, text, bytes } = await fetchCapped(url, {
    method: "GET",
    headers: mergeHeaders(options.headers, { accept: "*/*" }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_FILE_BYTES,
    fetchImpl: options.fetchImpl,
  });
  if (status === 404) {
    throw new A2AError(`File not found at ${redactUrl(url)} (HTTP 404)`, { status });
  }
  if (status < 200 || status >= 300) {
    throw new A2AError(`File download from ${redactUrl(url)} failed with HTTP ${status}: ${snippet(text) || "(no body)"}`, {
      status,
    });
  }
  return {
    taskId: options.taskId,
    name: options.name,
    size: bytes.byteLength,
    contentType: headers.get("content-type") ?? "application/octet-stream",
    content: bytes,
    text,
    url: redactUrl(url),
  };
}
