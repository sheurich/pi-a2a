import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  A2AError,
  AGENT_CARD_PATH,
  AGENT_CARD_V1_PATH,
  MAX_AGENT_CARD_BYTES,
  assertAllowedBaseUrl,
  buildAgentUrl,
  buildMessageParams,
  cancelTask,
  discoverAgents,
  getTask,
  getAgentCard,
  getFile,
  sendFile,
  buildFileUrl,
  isReplyWithheld,
  normalizeProtocol,
  normalizeResult,
  normalizeTaskState,
  parseSseStream,
  sendMessage,
} from "../src/client.mjs";
import {
  ALLOWED_HEADER_NAMES,
  parseHeadersHelperOutput,
  resolveHeaders,
  runHeadersHelper,
  splitCommandTokens,
  validateAndNormalizeHeaders,
} from "../src/headers-helper.mjs";
import registerPiA2aExtension, {
  MAX_CONFIG_BYTES,
  loadGatewayConfig,
  parseSlashArgs,
  readConfig,
  validateGatewayConfig,
} from "../src/extension.mjs";

// ---------------------------------------------------------------------------
// Mock A2A gateway
// ---------------------------------------------------------------------------

const cards = {
  root: { name: "Gateway", description: "Root agent", url: "/", version: "1.0.0", capabilities: { streaming: true }, skills: [] },
  echo: {
    name: "Echo",
    description: "Echoes text back",
    version: "2.1.0",
    capabilities: { streaming: true },
    skills: [{ id: "echo", name: "Echo", description: "Repeat input" }],
  },
  clerk: {
    name: "Clerk",
    description: "Asks clarifying questions",
    version: "0.9.0",
    capabilities: { streaming: false },
    skills: [{ id: "intake", name: "Intake" }],
  },
};

/** @type {Map<string, any>} */
const tasks = new Map();
/** @type {Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }>} */
const requests = [];
/** @type {Map<string, { body: Buffer; type: string }>} */
const files = new Map();
/** @type {Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body?: Buffer }>} */
const fileRequests = [];

let counter = 0;
const nextId = (prefix) => `${prefix}-${++counter}`;

function text(t) {
  return [{ kind: "text", text: t }];
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function rpcResult(res, id, result, status = 200) {
  json(res, status, { jsonrpc: "2.0", id, result });
}

function rpcError(res, id, code, message, data, status = 200) {
  json(res, status, { jsonrpc: "2.0", id, error: { code, message, data } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sseWrite(res, payload, { event } = {}) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  const fileMatch = /^\/files\/([^/]+)\/([^/]+)$/.exec(path);
  if (fileMatch && (req.method === "POST" || req.method === "GET")) {
    const key = `${fileMatch[1]}/${fileMatch[2]}`;
    if (req.method === "POST") {
      const buf = Buffer.concat(await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(chunks));
        req.on("error", reject);
      }));
      fileRequests.push({ method: "POST", path, headers: req.headers, body: buf });
      files.set(key, { body: buf, type: req.headers["content-type"] ?? "application/octet-stream" });
      return json(res, 201, { ok: true, size: buf.length });
    }
    fileRequests.push({ method: "GET", path, headers: req.headers });
    const file = files.get(key);
    if (!file) {
      res.writeHead(404);
      return res.end("no such file");
    }
    res.writeHead(200, { "content-type": file.type, "content-length": file.body.length });
    return res.end(file.body);
  }
  if (req.method === "GET") {
    if (path === "/.well-known/agent.json") return json(res, 200, cards.root);
    if (path === "/a2a") return json(res, 200, { agents: ["echo", { name: "clerk", description: "dir entry" }] });
    if (path === "/a2a/echo/.well-known/agent.json") return json(res, 200, cards.echo);
    if (path === "/a2a/clerk/.well-known/agent.json") return json(res, 200, cards.clerk);
    if (path === "/a2a/researcher/.well-known/agent.json") {
      return json(res, 200, { name: "Researcher", description: "Research", version: "1.2.0", capabilities: { streaming: true }, skills: [{ id: "r", name: "Research" }] });
    }
    if (path === "/a2a/big/.well-known/agent.json") {
      return json(res, 200, { name: "Big", padding: "x".repeat(MAX_AGENT_CARD_BYTES + 1024) });
    }
    if (path === "/a2a/redirect/.well-known/agent.json") {
      res.writeHead(302, { location: "/a2a/echo/.well-known/agent.json" });
      return res.end();
    }
    res.writeHead(404);
    return res.end("not found");
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end();
  }

  const raw = await readBody(req);
  const rpc = JSON.parse(raw);
  requests.push({ path, headers: req.headers, body: rpc });
  const { id, method, params } = rpc;
  const agent = path.replace(/^\/a2a\//, "");

  if (agent === "withheld") {
    const msg = params?.message?.parts?.[0]?.text ?? "";
    if (msg.includes("rpc-error")) {
      return rpcError(res, id, -32000, "Reply withheld by policy", { reason: "reply_withheld", category: "policy" });
    }
    res.writeHead(502, { "content-type": "text/plain" });
    return res.end("Bad Gateway");
  }

  if (method === "message/send") {
    const incoming = params.message;
    const userText = incoming.parts.map((p) => p.text ?? "").join("");
    if (agent === "echo" || agent === "planner" || agent === "researcher" || agent === "reviewer") {
      const taskId = incoming.taskId ?? nextId("task");
      const task = {
        kind: "task",
        id: taskId,
        contextId: incoming.contextId ?? nextId("ctx"),
        status: { state: "completed" },
        artifacts: [{ artifactId: "a1", parts: text(`echo: ${userText}`) }],
      };
      tasks.set(taskId, task);
      return rpcResult(res, id, task);
    }
    if (agent === "clerk") {
      if (incoming.taskId) {
        const existing = tasks.get(incoming.taskId);
        if (!existing) return rpcError(res, id, -32001, "Task not found");
        if (existing.status.state !== "input-required") return rpcError(res, id, -32002, "Task not continuable");
        existing.status = { state: "completed", message: { role: "agent", parts: text(`Filed under ${userText}.`) } };
        existing.history.push(incoming);
        return rpcResult(res, id, existing);
      }
      const task = {
        kind: "task",
        id: nextId("task"),
        contextId: incoming.contextId ?? nextId("ctx"),
        status: { state: "input-required", message: { role: "agent", parts: text("Which category should I file this under?") } },
        history: [incoming],
      };
      tasks.set(task.id, task);
      return rpcResult(res, id, task);
    }
    if (agent === "slow") {
      const task = { kind: "task", id: nextId("task"), contextId: nextId("ctx"), status: { state: "working" } };
      tasks.set(task.id, task);
      return rpcResult(res, id, task);
    }
    return rpcError(res, id, -32601, "Unknown agent");
  }

  if (method === "message/stream") {
    const incoming = params.message;
    const userText = incoming.parts.map((p) => p.text ?? "").join("");
    const taskId = nextId("task");
    const contextId = nextId("ctx");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": keep-alive\n\n");
    sseWrite(res, { jsonrpc: "2.0", id, result: { kind: "status-update", taskId, contextId, status: { state: "working" }, final: false } });
    sseWrite(res, {
      jsonrpc: "2.0",
      id,
      result: { kind: "artifact-update", taskId, contextId, artifact: { artifactId: "a1", parts: text("stream: ") }, append: false },
    });
    sseWrite(res, {
      jsonrpc: "2.0",
      id,
      result: { kind: "artifact-update", taskId, contextId, artifact: { artifactId: "a1", parts: text(userText) }, append: true, lastChunk: true },
    });
    if (agent === "stream-withheld") {
      sseWrite(res, { jsonrpc: "2.0", id, error: { code: -32000, message: "Withheld mid-stream", data: { reason: "reply_withheld" } } });
      return res.end();
    }
    sseWrite(res, { jsonrpc: "2.0", id, result: { kind: "status-update", taskId, contextId, status: { state: "completed" }, final: true } });
    tasks.set(taskId, { kind: "task", id: taskId, contextId, status: { state: "completed" }, artifacts: [{ artifactId: "a1", parts: text(`stream: ${userText}`) }] });
    return res.end();
  }

  if (method === "tasks/get") {
    const task = tasks.get(params.id);
    if (!task) return rpcError(res, id, -32001, "Task not found");
    return rpcResult(res, id, task);
  }

  if (method === "tasks/cancel") {
    const task = tasks.get(params.id);
    if (!task) return rpcError(res, id, -32001, "Task not found");
    task.status = { state: "canceled" };
    return rpcResult(res, id, task);
  }

  return rpcError(res, id, -32601, "Method not found");
}

/** @type {http.Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {string} */
let tmpDir;
/** @type {string} */
let goodHelper;
/** @type {string} */
let badHelper;

before(async () => {
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  baseUrl = `http://127.0.0.1:${address.port}`;

  tmpDir = mkdtempSync(join(tmpdir(), "pi-a2a-test-"));
  goodHelper = join(tmpDir, "good-helper.mjs");
  writeFileSync(
    goodHelper,
    `process.stdout.write(JSON.stringify({ Authorization: "Bearer test-token-abc", "X-Goog-IAP-JWT-Assertion": "jwt-xyz" }));\n`,
  );
  badHelper = join(tmpDir, "bad-helper.mjs");
  writeFileSync(badHelper, `process.stdout.write(JSON.stringify({ authorization: "Bearer ok", cookie: "session=SECRETVALUE" }));\n`);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal fake Pi ExtensionAPI capturing registered tools. */
function fakePi() {
  /** @type {Map<string, any>} */
  const tools = new Map();
  return {
    tools,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Agent Card discovery
// ---------------------------------------------------------------------------

describe("Agent Card discovery", () => {
  it("fetches a single agent card via /a2a/{agent}/.well-known/agent.json", async () => {
    const result = await discoverAgents({ baseUrl, agent: "echo" });
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0].agent, "echo");
    assert.equal(result.agents[0].name, "Echo");
    assert.equal(result.agents[0].streaming, true);
    assert.deepEqual(result.agents[0].skills, [{ id: "echo", name: "Echo", description: "Repeat input" }]);
    assert.equal(result.agents[0].cardUrl, `${baseUrl}/a2a/echo/.well-known/agent.json`);
  });

  it("fetches the root card and /a2a directory when agent is omitted", async () => {
    const result = await discoverAgents({ baseUrl });
    const names = result.agents.map((a) => a.agent ?? "(root)").sort();
    assert.deepEqual(names, ["(root)", "clerk", "echo"]);
    assert.deepEqual(result.directory.map((d) => d.name), ["echo", "clerk"]);
    assert.deepEqual(result.errors, []);
  });

  it("enforces HTTPS except for loopback hosts", () => {
    assert.doesNotThrow(() => assertAllowedBaseUrl("https://agents.example.com"));
    assert.doesNotThrow(() => assertAllowedBaseUrl("http://127.0.0.1:8080"));
    assert.doesNotThrow(() => assertAllowedBaseUrl("http://localhost:8080/base"));
    assert.throws(() => assertAllowedBaseUrl("http://agents.example.com"), A2AError);
    assert.throws(() => assertAllowedBaseUrl("ftp://agents.example.com"), A2AError);
    assert.throws(() => assertAllowedBaseUrl("https://user:agent-test@example.invalid"), /credentials/);
    assert.throws(() => assertAllowedBaseUrl(""), /required/);
  });

  it("builds agent URLs under a base path and rejects unsafe agent names", () => {
    assert.equal(buildAgentUrl("https://h.example/api/", "echo", "/.well-known/agent.json"), "https://h.example/api/a2a/echo/.well-known/agent.json");
    assert.equal(buildAgentUrl("https://h.example", undefined, "/a2a"), "https://h.example/a2a");
    assert.throws(() => buildAgentUrl(baseUrl, "../etc", "/x"), A2AError);
    assert.throws(() => buildAgentUrl(baseUrl, "a/b", "/x"), A2AError);
  });

  it("refuses redirects", async () => {
    await assert.rejects(discoverAgents({ baseUrl, agent: "redirect" }), A2AError);
  });

  it("caps Agent Card bodies at 64 KiB", async () => {
    await assert.rejects(discoverAgents({ baseUrl, agent: "big" }), /exceeds limit of 65536 bytes/);
  });

  it("reports a missing card as 404", async () => {
    await assert.rejects(discoverAgents({ baseUrl, agent: "nope" }), /HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// 2. message/send
// ---------------------------------------------------------------------------

describe("message/send", () => {
  it("sends a JSON-RPC 2.0 request and normalizes the completed task", async () => {
    requests.length = 0;
    const result = await sendMessage({ baseUrl, agent: "echo", message: "hello", messageId: "m-1", contextId: "ctx-fixed" });
    assert.equal(result.state, "completed");
    assert.equal(result.text, "echo: hello");
    assert.match(result.taskId, /^task-/);
    assert.equal(result.contextId, "ctx-fixed");
    assert.equal(result.raw.kind, "task");

    const sent = requests.at(-1);
    assert.equal(sent.path, "/a2a/echo");
    assert.equal(sent.body.jsonrpc, "2.0");
    assert.equal(sent.body.method, "message/send");
    assert.equal(sent.body.params.message.messageId, "m-1");
    assert.equal(sent.body.params.message.role, "user");
    assert.deepEqual(sent.body.params.message.parts, [{ kind: "text", text: "hello" }]);
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.headers.accept, "application/json");
  });

  it("rejects an empty message and surfaces JSON-RPC errors", async () => {
    await assert.rejects(sendMessage({ baseUrl, agent: "echo", message: "   " }), /non-empty/);
    await assert.rejects(sendMessage({ baseUrl, agent: "unknown-agent", message: "x" }), (err) => {
      assert.ok(err instanceof A2AError);
      assert.equal(err.code, -32601);
      return true;
    });
  });

  it("normalizes direct Message results", () => {
    const normalized = normalizeResult({ kind: "message", role: "agent", parts: text("hi"), taskId: "t", contextId: "c" });
    assert.deepEqual({ ...normalized, raw: undefined }, { taskId: "t", contextId: "c", state: "completed", text: "hi", raw: undefined });
  });
});

// ---------------------------------------------------------------------------
// 3. message/stream (SSE)
// ---------------------------------------------------------------------------

describe("message/stream SSE", () => {
  it("parses SSE frames including CRLF, comments, and multi-line data", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ": comment\r\n",
      "event: status\r\ndata: {\"a\":\r\n",
      "data: 1}\r\n\r\n",
      "id: 7\ndata: second\n\n",
      "data: tail-no-newline",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of parseSseStream(stream)) frames.push(frame);
    assert.deepEqual(frames, [
      { event: "status", data: '{"a":\n1}', id: undefined },
      { event: "message", data: "second", id: "7" },
      { event: "message", data: "tail-no-newline", id: "7" },
    ]);
  });

  it("enforces the SSE byte cap", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2048));
        controller.close();
      },
    });
    await assert.rejects(
      (async () => {
        for await (const _ of parseSseStream(stream, { maxBytes: 1024 })) {
          // drain
        }
      })(),
      /SSE stream exceeds limit/,
    );
  });

  it("streams status-update and artifact-update events to completion", async () => {
    requests.length = 0;
    const events = [];
    const result = await sendMessage({ baseUrl, agent: "echo", message: "world", stream: true, onEvent: (e) => events.push(e) });
    assert.equal(requests.at(-1).body.method, "message/stream");
    assert.equal(requests.at(-1).headers.accept, "text/event-stream");
    assert.equal(result.state, "completed");
    assert.equal(result.text, "stream: world");
    assert.match(result.taskId, /^task-/);
    assert.match(result.contextId, /^ctx-/);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["status-update", "artifact-update", "artifact-update", "status-update"],
    );
    assert.equal(events.at(-1).final, true);
    assert.equal(result.events.length, 4);
  });
});

// ---------------------------------------------------------------------------
// 4. input-required + a2a_reply continuation (via extension tools)
// ---------------------------------------------------------------------------

describe("input-required + a2a_reply continuation", () => {
  it("registers all eleven tools, reading defaults from process.env", () => {
    const saved = {
      url: process.env.PI_A2A_URL,
      helper: process.env.PI_A2A_HEADERS_HELPER,
      config: process.env.PI_A2A_CONFIG,
      gateway: process.env.PI_A2A_GATEWAY,
    };
    process.env.PI_A2A_URL = baseUrl;
    delete process.env.PI_A2A_HEADERS_HELPER;
    delete process.env.PI_A2A_CONFIG;
    delete process.env.PI_A2A_GATEWAY;
    try {
      const pi = fakePi();
      registerPiA2aExtension(pi);
      const names = [...pi.tools.keys()].sort();
      for (const original of ["a2a_agents", "a2a_cancel", "a2a_reply", "a2a_send", "a2a_status"]) {
        assert.ok(names.includes(original), `missing original tool ${original}`);
      }
      assert.deepEqual(names, [
        "a2a_agents",
        "a2a_cancel",
        "a2a_cancel_task",
        "a2a_card",
        "a2a_gateways",
        "a2a_get_file",
        "a2a_get_task",
        "a2a_reply",
        "a2a_send",
        "a2a_send_file",
        "a2a_status",
      ]);
      for (const tool of pi.tools.values()) {
        assert.equal(typeof tool.execute, "function");
        assert.equal(tool.parameters.type, "object");
        assert.ok(tool.description.length > 10);
        // Header values must never be accepted from the model.
        assert.equal(tool.parameters.properties.headers, undefined);
        assert.equal(tool.parameters.properties.headers_helper, undefined);
      }
      assert.equal(readConfig().baseUrl, baseUrl);
      assert.equal(readConfig().headersHelper, undefined);
    } finally {
      if (saved.url === undefined) delete process.env.PI_A2A_URL;
      else process.env.PI_A2A_URL = saved.url;
      if (saved.helper !== undefined) process.env.PI_A2A_HEADERS_HELPER = saved.helper;
      if (saved.config !== undefined) process.env.PI_A2A_CONFIG = saved.config;
      if (saved.gateway !== undefined) process.env.PI_A2A_GATEWAY = saved.gateway;
    }
  });

  it("a2a_send returns input-required, a2a_reply continues the task to completion", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl, PI_A2A_AGENT: "clerk" } });

    const first = await pi.tools.get("a2a_send").execute("call-1", { message: "Please file this receipt" }, undefined, undefined, {});
    assert.notEqual(first.isError, true);
    assert.equal(first.details.state, "input-required");
    assert.match(first.content[0].text, /input-required/);
    assert.match(first.content[0].text, /Which category/);
    assert.match(first.content[0].text, /a2a_reply/);
    const taskId = first.details.taskId;
    assert.ok(taskId);

    const status = await pi.tools.get("a2a_status").execute("call-2", { task_id: taskId }, undefined, undefined, {});
    assert.equal(status.details.state, "input-required");

    const reply = await pi.tools.get("a2a_reply").execute("call-3", { task_id: taskId, message: "Travel" }, undefined, undefined, {});
    assert.notEqual(reply.isError, true);
    assert.equal(reply.details.state, "completed");
    assert.equal(reply.details.taskId, taskId);
    assert.match(reply.content[0].text, /Filed under Travel\./);

    const sent = requests.at(-1);
    assert.equal(sent.body.method, "message/send");
    assert.equal(sent.body.params.message.taskId, taskId);
  });

  it("returns isError results without throwing when configuration is missing", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: {} });
    const result = await pi.tools.get("a2a_send").execute("call-x", { message: "hi" }, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PI_A2A_URL/);

    const insecure = await pi.tools.get("a2a_agents").execute("call-y", { url: "http://agents.example.com" }, undefined, undefined, {});
    assert.equal(insecure.isError, true);
    assert.match(insecure.content[0].text, /https/);
  });
});

// ---------------------------------------------------------------------------
// 5. tasks/get + tasks/cancel
// ---------------------------------------------------------------------------

describe("tasks/get + tasks/cancel", () => {
  it("fetches a working task then cancels it", async () => {
    const started = await sendMessage({ baseUrl, agent: "slow", message: "long job" });
    assert.equal(started.state, "working");

    const fetched = await getTask({ baseUrl, agent: "slow", taskId: started.taskId });
    assert.equal(fetched.state, "working");
    assert.equal(fetched.taskId, started.taskId);
    assert.equal(requests.at(-1).body.method, "tasks/get");
    assert.deepEqual(requests.at(-1).body.params, { id: started.taskId });

    const canceled = await cancelTask({ baseUrl, agent: "slow", taskId: started.taskId });
    assert.equal(canceled.state, "canceled");
    assert.equal(requests.at(-1).body.method, "tasks/cancel");

    const again = await getTask({ baseUrl, agent: "slow", taskId: started.taskId });
    assert.equal(again.state, "canceled");
  });

  it("surfaces unknown task ids as A2AError and validates input", async () => {
    await assert.rejects(getTask({ baseUrl, agent: "slow", taskId: "missing" }), /Task not found/);
    await assert.rejects(cancelTask({ baseUrl, agent: "slow", taskId: "" }), /taskId is required/);
  });

  it("a2a_cancel tool reports the canceled state", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl } });
    const started = await sendMessage({ baseUrl, agent: "slow", message: "job" });
    const result = await pi.tools.get("a2a_cancel").execute("c", { task_id: started.taskId, agent: "slow" }, undefined, undefined, {});
    assert.notEqual(result.isError, true);
    assert.equal(result.details.state, "canceled");
  });
});

// ---------------------------------------------------------------------------
// 6. reply_withheld handling
// ---------------------------------------------------------------------------

describe("reply_withheld error handling", () => {
  it("treats HTTP 502 as reply_withheld for message/send", async () => {
    const result = await sendMessage({ baseUrl, agent: "withheld", message: "anything" });
    assert.equal(result.state, "reply_withheld");
    assert.equal(result.text, "");
    assert.match(result.error, /502/);
  });

  it("treats a JSON-RPC error with data.reason === reply_withheld as reply_withheld", async () => {
    const result = await sendMessage({ baseUrl, agent: "withheld", message: "trigger rpc-error" });
    assert.equal(result.state, "reply_withheld");
    assert.match(result.error, /Reply withheld by policy/);
    assert.deepEqual(result.raw, { reason: "reply_withheld", category: "policy" });
  });

  it("handles reply_withheld mid-stream and keeps partial text", async () => {
    const result = await sendMessage({ baseUrl, agent: "stream-withheld", message: "partial", stream: true });
    assert.equal(result.state, "reply_withheld");
    assert.equal(result.text, "stream: partial");
    assert.match(result.error, /Withheld mid-stream/);
  });

  it("handles HTTP 502 on message/stream", async () => {
    const result = await sendMessage({ baseUrl, agent: "withheld", message: "x", stream: true });
    assert.equal(result.state, "reply_withheld");
  });

  it("isReplyWithheld helper covers both signals", () => {
    assert.equal(isReplyWithheld({ status: 502 }), true);
    assert.equal(isReplyWithheld({ status: 200, error: { data: { reason: "reply_withheld" } } }), true);
    assert.equal(isReplyWithheld({ status: 200, error: { data: { reason: "other" } } }), false);
    assert.equal(isReplyWithheld({ status: 500 }), false);
  });

  it("a2a_send tool explains the withheld state to the model", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl } });
    const result = await pi.tools.get("a2a_send").execute("w", { message: "x", agent: "withheld" }, undefined, undefined, {});
    assert.notEqual(result.isError, true);
    assert.equal(result.details.state, "reply_withheld");
    assert.match(result.content[0].text, /withheld/);
  });
});

// ---------------------------------------------------------------------------
// 7. headersHelper allowlist / redaction
// ---------------------------------------------------------------------------

describe("headersHelper allowlist and redaction", () => {
  it("only allows authorization and x-goog-iap-jwt-assertion", () => {
    assert.deepEqual([...ALLOWED_HEADER_NAMES].sort(), ["authorization", "x-goog-iap-jwt-assertion"]);
    assert.deepEqual(validateAndNormalizeHeaders({ Authorization: " Bearer abc " }), { authorization: "Bearer abc" });
    assert.throws(() => validateAndNormalizeHeaders({ cookie: "session=TOPSECRET" }), (err) => {
      assert.match(err.message, /Disallowed header name "cookie"/);
      assert.doesNotMatch(err.message, /TOPSECRET/);
      return true;
    });
    assert.throws(() => validateAndNormalizeHeaders({ authorization: "Bearer bad\r\nx: y" }), (err) => {
      assert.match(err.message, /control characters/);
      assert.doesNotMatch(err.message, /Bearer bad/);
      return true;
    });
    assert.throws(() => validateAndNormalizeHeaders({ authorization: 42 }), /non-string/);
    assert.throws(() => validateAndNormalizeHeaders(["authorization"]), /JSON object/);
  });

  it("parses JSON and Header: value output without leaking values", () => {
    assert.deepEqual(parseHeadersHelperOutput('{"Authorization":"Bearer j"}'), { authorization: "Bearer j" });
    assert.deepEqual(parseHeadersHelperOutput("Authorization: Bearer l\nX-Goog-IAP-JWT-Assertion: jwt\n"), {
      authorization: "Bearer l",
      "x-goog-iap-jwt-assertion": "jwt",
    });
    assert.deepEqual(parseHeadersHelperOutput("   "), {});
    assert.throws(() => parseHeadersHelperOutput("{not json SECRET"), (err) => {
      assert.doesNotMatch(err.message, /SECRET/);
      return true;
    });
    assert.throws(() => parseHeadersHelperOutput("no-colon-line SECRET"), (err) => {
      assert.doesNotMatch(err.message, /SECRET/);
      return true;
    });
  });

  it("splits command tokens without a shell", () => {
    assert.deepEqual(splitCommandTokens(`"/path with space/tool" --flag 'single quoted' plain`), [
      "/path with space/tool",
      "--flag",
      "single quoted",
      "plain",
    ]);
    assert.throws(() => splitCommandTokens(`"unclosed`), /unclosed quote/);
    assert.throws(() => splitCommandTokens(""), /must not be empty/);
  });

  it("runs a helper via execFile and applies the allowlist", async () => {
    const headers = await runHeadersHelper([process.execPath, goodHelper]);
    assert.deepEqual(headers, { authorization: "Bearer test-token-abc", "x-goog-iap-jwt-assertion": "jwt-xyz" });

    await assert.rejects(runHeadersHelper(`"${process.execPath}" "${badHelper}"`), (err) => {
      assert.match(err.message, /Disallowed header name "cookie"/);
      assert.doesNotMatch(err.message, /SECRETVALUE/);
      return true;
    });

    await assert.rejects(runHeadersHelper([process.execPath, "-e", "process.exit(3)"]), /execution failed \(code: 3/);
    await assert.rejects(
      runHeadersHelper([process.execPath, "-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 }),
      /timed out/,
    );
    await assert.rejects(
      runHeadersHelper([process.execPath, "-e", `process.stdout.write('{"authorization":"' + "x".repeat(2000) + '"}')`], {
        maxBufferBytes: 512,
      }),
      /exceeded maximum size/,
    );
  });

  it("merges static headers with helper output", async () => {
    const merged = await resolveHeaders({ headersHelper: [process.execPath, goodHelper], headers: { Authorization: "Bearer override" } });
    assert.deepEqual(merged, { authorization: "Bearer override", "x-goog-iap-jwt-assertion": "jwt-xyz" });
  });

  it("extension sends helper headers to the gateway via PI_A2A_HEADERS_HELPER", async () => {
    requests.length = 0;
    const pi = fakePi();
    registerPiA2aExtension(pi, {
      env: { PI_A2A_URL: baseUrl, PI_A2A_HEADERS_HELPER: `"${process.execPath}" "${goodHelper}"` },
    });
    const result = await pi.tools.get("a2a_send").execute("h", { message: "auth test", agent: "echo" }, undefined, undefined, {});
    assert.notEqual(result.isError, true);
    const sent = requests.at(-1);
    assert.equal(sent.headers.authorization, "Bearer test-token-abc");
    assert.equal(sent.headers["x-goog-iap-jwt-assertion"], "jwt-xyz");

    const failing = fakePi();
    registerPiA2aExtension(failing, {
      env: { PI_A2A_URL: baseUrl, PI_A2A_HEADERS_HELPER: `"${process.execPath}" "${badHelper}"` },
    });
    const blocked = await failing.tools.get("a2a_send").execute("h2", { message: "x", agent: "echo" }, undefined, undefined, {});
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Disallowed header name "cookie"/);
    assert.doesNotMatch(blocked.content[0].text, /SECRETVALUE/);
  });

  it("refuses to send headersHelper credentials to a model-supplied cross-origin URL", async () => {
    const reqCountBefore = requests.length;
    const pi = fakePi();
    registerPiA2aExtension(pi, {
      env: { PI_A2A_URL: baseUrl, PI_A2A_HEADERS_HELPER: `"${process.execPath}" "${goodHelper}"` },
    });
    const res = await pi.tools.get("a2a_send").execute(
      "tc-origin",
      { url: "https://attacker.example/a2a", message: "exfiltrate", agent: "echo" },
      undefined,
      undefined,
      {},
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cross-origin URL/);
    assert.doesNotMatch(res.content[0].text, /test-token-abc/);
    assert.equal(requests.length, reqCountBefore);

    const noBase = fakePi();
    registerPiA2aExtension(noBase, {
      env: { PI_A2A_HEADERS_HELPER: `"${process.execPath}" "${goodHelper}"` },
    });
    const res2 = await noBase.tools.get("a2a_send").execute(
      "tc-no-base",
      { url: "https://attacker.example/a2a", message: "exfiltrate" },
      undefined,
      undefined,
      {},
    );
    assert.equal(res2.isError, true);
    assert.match(res2.content[0].text, /PI_A2A_URL is not configured/);
  });
});

describe("multi-agent routing (agent option)", () => {
  it("routes to /a2a/<agent> for named agents", async () => {
    for (const agent of ["planner", "researcher", "reviewer"]) {
      requests.length = 0;
      const result = await sendMessage({ baseUrl, agent, message: "hi" });
      assert.equal(result.state, "completed");
      assert.equal(requests.at(-1).path, `/a2a/${agent}`);
    }
  });

  it("rejects agent names outside [a-z0-9][a-z0-9-]{0,62}", async () => {
    for (const bad of ["../x", "a/b", "Upper", "-lead", "a".repeat(64), "a b", "a%2fb", "a.b"]) {
      assert.throws(() => buildAgentUrl(baseUrl, bad, "/x"), A2AError, bad);
    }
    assert.doesNotThrow(() => buildAgentUrl(baseUrl, "code-reviewer", "/x"));
    assert.doesNotThrow(() => buildAgentUrl(baseUrl, "a".repeat(63), "/x"));
  });

  it("a2a_card fetches /a2a/<agent>/.well-known/agent.json", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl } });
    const res = await pi.tools.get("a2a_card").execute("c", { agent: "researcher" }, undefined, undefined, {});
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /Researcher/);
    const card = await getAgentCard({ baseUrl, agent: "echo" });
    assert.equal(card.cardUrl, `${baseUrl}/a2a/echo/.well-known/agent.json`);
  });

  it("/a2a command routes @agent messages and cards", async () => {
    const commands = new Map();
    const pi = { registerTool() {}, registerCommand: (n, c) => commands.set(n, c) };
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl } });
    const notes = [];
    const ctx = { ui: { notify: (m, l) => notes.push([m, l]) } };
    requests.length = 0;
    await commands.get("a2a").handler("@echo ping", ctx);
    assert.equal(requests.at(-1).path, "/a2a/echo");
    assert.match(notes.at(-1)[0], /echo: ping/);
    await commands.get("a2a").handler("card @researcher", ctx);
    assert.match(notes.at(-1)[0], /Researcher/);
    await commands.get("a2a").handler("@../evil hi", ctx);
    assert.equal(notes.at(-1)[1], "error");
  });
});

describe("tasks tools and file staging", () => {
  it("getTask/cancelTask accept (baseUrl, options) and route by agent", async () => {
    const started = await sendMessage({ baseUrl, agent: "slow", message: "job" });
    requests.length = 0;
    const got = await getTask(baseUrl, { taskId: started.taskId, agent: "slow" });
    assert.equal(got.state, "working");
    assert.equal(requests.at(-1).path, "/a2a/slow");
    assert.equal(requests.at(-1).body.method, "tasks/get");
    const canceled = await cancelTask(baseUrl, { taskId: started.taskId, agent: "slow" });
    assert.equal(canceled.state, "canceled");
    assert.equal(requests.at(-1).body.method, "tasks/cancel");
  });

  it("a2a_get_task and a2a_cancel_task tools work", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl } });
    const started = await sendMessage({ baseUrl, agent: "slow", message: "job" });
    const got = await pi.tools.get("a2a_get_task").execute("g", { task_id: started.taskId, agent: "slow" }, undefined, undefined, {});
    assert.equal(got.details.state, "working");
    const c = await pi.tools.get("a2a_cancel_task").execute("c", { task_id: started.taskId, agent: "slow" }, undefined, undefined, {});
    assert.equal(c.details.state, "canceled");
  });

  it("sendFile then getFile round-trips bytes via /files/{task}/{name}", async () => {
    fileRequests.length = 0;
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    const up = await sendFile(baseUrl, { taskId: "task-9", name: "data.bin", content: bytes, headers: { authorization: "Bearer t" } });
    assert.equal(up.size, 5);
    assert.equal(fileRequests[0].method, "POST");
    assert.equal(fileRequests[0].path, "/files/task-9/data.bin");
    assert.equal(fileRequests[0].headers.authorization, "Bearer t");
    const down = await getFile(baseUrl, { taskId: "task-9", name: "data.bin" });
    assert.deepEqual([...down.content], [...bytes]);
    assert.equal(fileRequests[1].method, "GET");
    await assert.rejects(getFile(baseUrl, { taskId: "task-9", name: "missing.txt" }), /HTTP 404/);
  });

  it("a2a_send_file / a2a_get_file tools round-trip text", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_URL: baseUrl } });
    const up = await pi.tools.get("a2a_send_file").execute("u", { task_id: "task-10", name: "note.txt", content: "héllo" }, undefined, undefined, {});
    assert.notEqual(up.isError, true);
    const down = await pi.tools.get("a2a_get_file").execute("d", { task_id: "task-10", name: "note.txt" }, undefined, undefined, {});
    assert.notEqual(down.isError, true);
    assert.match(down.content[0].text, /héllo/);
  });

  it("rejects path traversal in task ids and file names before any request", async () => {
    fileRequests.length = 0;
    const bad = ["../x", "a/b", "..", ".", "%2e%2e", "a%2fb", "a\\b", "x?y=1", "x#f", "a..b", "", ".hidden", "a\0b"];
    for (const name of bad) {
      await assert.rejects(sendFile(baseUrl, { taskId: "task-1", name, content: "x" }), A2AError, `name ${JSON.stringify(name)}`);
      await assert.rejects(getFile(baseUrl, { taskId: "task-1", name }), A2AError, `name ${JSON.stringify(name)}`);
      await assert.rejects(getFile(baseUrl, { taskId: name, name: "ok.txt" }), A2AError, `taskId ${JSON.stringify(name)}`);
    }
    assert.throws(() => buildFileUrl(baseUrl, "t1", "../../etc/passwd"), A2AError);
    assert.equal(fileRequests.length, 0);
  });

  it("enforces a file size cap on upload", async () => {
    await assert.rejects(
      sendFile(baseUrl, { taskId: "t1", name: "big.bin", content: new Uint8Array(8 * 1024 * 1024 + 1) }),
      /exceeds limit/,
    );
  });

  it("file tools refuse cross-origin urls when a headersHelper is configured", async () => {
    fileRequests.length = 0;
    const pi = fakePi();
    registerPiA2aExtension(pi, {
      env: { PI_A2A_URL: baseUrl, PI_A2A_HEADERS_HELPER: `"${process.execPath}" "${goodHelper}"` },
    });
    for (const [tool, params] of [
      ["a2a_send_file", { task_id: "t1", name: "a.txt", content: "x" }],
      ["a2a_get_file", { task_id: "t1", name: "a.txt" }],
      ["a2a_get_task", { task_id: "t1" }],
      ["a2a_cancel_task", { task_id: "t1" }],
      ["a2a_card", {}],
    ]) {
      const res = await pi.tools.get(tool).execute("x", { ...params, url: "https://attacker.example" }, undefined, undefined, {});
      assert.equal(res.isError, true, tool);
      assert.match(res.content[0].text, /cross-origin URL/, tool);
      assert.doesNotMatch(res.content[0].text, /test-token-abc/);
    }
    assert.equal(fileRequests.length, 0);
  });

  it("client-level pinnedOrigin blocks credentials to a different origin", async () => {
    await assert.rejects(
      sendFile("https://attacker.example", { taskId: "t1", name: "a.txt", content: "x", headers: { authorization: "Bearer s" }, pinnedOrigin: baseUrl }),
      /cross-origin/,
    );
    await assert.rejects(
      getFile({ baseUrl: "https://attacker.example", taskId: "t1", name: "a.txt", pinnedOrigin: baseUrl }),
      /cross-origin/,
    );
    await assert.rejects(getTask("https://attacker.example", { taskId: "t1", pinnedOrigin: baseUrl }), /cross-origin/);
    await assert.rejects(cancelTask("https://attacker.example", { taskId: "t1", pinnedOrigin: baseUrl }), /cross-origin/);
  });

  it("file helper sends credentials to the pinned origin only", async () => {
    fileRequests.length = 0;
    const pi = fakePi();
    registerPiA2aExtension(pi, {
      env: { PI_A2A_URL: baseUrl, PI_A2A_HEADERS_HELPER: `"${process.execPath}" "${goodHelper}"` },
    });
    const res = await pi.tools.get("a2a_send_file").execute("x", { task_id: "t2", name: "a.txt", content: "x" }, undefined, undefined, {});
    assert.notEqual(res.isError, true);
    assert.equal(fileRequests[0].headers.authorization, "Bearer test-token-abc");
  });
});

it("sendMessage and discoverAgents enforce pinnedOrigin and a2a_get_file encodes non-UTF8 bytes as base64", async () => {
  await assert.rejects(
    () =>
      sendMessage({
        baseUrl: "https://attacker.example",
        pinnedOrigin: "https://agents.example.com",
        headers: { authorization: "Bearer TEST" },
        message: "hi",
        fetchImpl: async () => {
          throw new Error("fetch must not be called");
        },
      }),
    /Refusing to send credentials to cross-origin URL/,
  );

  await assert.rejects(
    () =>
      discoverAgents({
        baseUrl: "https://attacker.example",
        pinnedOrigin: "https://agents.example.com",
        fetchImpl: async () => {
          throw new Error("fetch must not be called");
        },
      }),
    /Refusing to send credentials to cross-origin URL/,
  );

  const tools = new Map();
  registerPiA2aExtension(
    {
      registerTool(def) {
        tools.set(def.name, def);
      },
    },
    {
      env: { PI_A2A_URL: "https://agents.example.com" },
      fetchImpl: async () =>
        new Response(Uint8Array.from([0xff]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    },
  );
  const res = await tools.get("a2a_get_file").execute("c1", { task_id: "t1", name: "raw.bin" });
  assert.equal(res.details.encoding, "base64");
  assert.match(res.content[0].text, /\/w==/);
});


it("discoverAgents isolates invalid directory entries without failing valid agents", async () => {
  const res = await discoverAgents({
    baseUrl: "https://agents.example.com",
    fetchImpl: async (input) => {
      const u = String(input);
      if (u.endsWith("/.well-known/agent.json") && !u.includes("/a2a/")) {
        return new Response(JSON.stringify({ name: "Root", url: "/a2a" }), { status: 200 });
      }
      if (u.endsWith("/a2a")) {
        return new Response(JSON.stringify({ agents: [{ name: "Legacy_Agent" }, { name: "planner" }] }), { status: 200 });
      }
      if (u.endsWith("/a2a/planner/.well-known/agent.json")) {
        return new Response(JSON.stringify({ name: "Planner", url: "/a2a/planner" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  assert.equal(res.agents.length, 2);
  assert.ok(res.errors.some((e) => e.includes("Legacy_Agent")));
});

it("a2a_send_file rejects malformed base64 and a2a_get_file preserves UTF-8 BOM", async () => {
  const bomBytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  const tools = new Map();
  registerPiA2aExtension(
    {
      registerTool(def) {
        tools.set(def.name, def);
      },
    },
    {
      env: { PI_A2A_URL: "https://agents.example.com" },
      fetchImpl: async () =>
        new Response(bomBytes, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    },
  );
  const badUpload = await tools.get("a2a_send_file").execute("c1", {
    task_id: "t1",
    name: "bad.bin",
    content: "aGVsbG8=THIS_IS_NOT_THE_END",
    encoding: "base64",
  });
  assert.equal(badUpload.isError, true);

  const bomRes = await tools.get("a2a_get_file").execute("c2", {
    task_id: "t1",
    name: "bom.txt",
  });
  assert.equal(bomRes.details.encoding, "utf8");
  const bodyText = bomRes.content[0].text.split("\n\n")[1];
  assert.deepEqual(Buffer.from(bodyText, "utf8"), Buffer.from(bomBytes));

  const large8Mb = Buffer.alloc(8 * 1024 * 1024, 255).toString("base64");
  const okLarge = await tools.get("a2a_send_file").execute("c3", {
    task_id: "t1",
    name: "large.bin",
    content: large8Mb,
    encoding: "base64",
  });
  assert.equal(okLarge.isError, undefined);
});

it("package.json pi.extensions manifest resolves to an extension factory function", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.ok(pkg.pi && typeof pkg.pi === "object" && !Array.isArray(pkg.pi));
  assert.equal(pkg.pi.extension, undefined);
  assert.ok(Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length > 0);

  for (const entry of pkg.pi.extensions) {
    assert.equal(typeof entry, "string");
    const resolvedPath = resolve(packageRoot, entry);
    assert.equal(existsSync(resolvedPath), true, `missing pi.extensions entry: ${entry}`);
    const mod = await import(pathToFileURL(resolvedPath).href);
    assert.equal(typeof mod.default, "function");
    const pi = fakePi();
    mod.default(pi, { env: { PI_A2A_URL: baseUrl } });
    assert.ok(pi.tools.size > 0);
  }
});

// ---------------------------------------------------------------------------
// 10. Named gateways
// ---------------------------------------------------------------------------

describe("named gateways", () => {
  /** @type {http.Server} */
  let secondServer;
  let secondBaseUrl = "";
  /** @type {Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>} */
  const secondRequests = [];
  let tmpDir = "";
  let alphaHelperPath = "";
  let betaHelperPath = "";
  let legacyHelperMarker = "";
  let legacyHelperPath = "";

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-a2a-gateways-"));
    alphaHelperPath = join(tmpDir, "alpha-helper.mjs");
    betaHelperPath = join(tmpDir, "beta-helper.mjs");
    legacyHelperPath = join(tmpDir, "legacy-helper.mjs");
    legacyHelperMarker = join(tmpDir, "legacy-ran.txt");

    writeFileSync(
      alphaHelperPath,
      'process.stdout.write(JSON.stringify({ authorization: "Bearer alpha-secret-token" }));\n',
      { mode: 0o600 },
    );
    writeFileSync(
      betaHelperPath,
      'process.stdout.write(JSON.stringify({ authorization: "Bearer beta-secret-token" }));\n',
      { mode: 0o600 },
    );
    writeFileSync(
      legacyHelperPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(legacyHelperMarker)}, "ran");\nprocess.stdout.write(JSON.stringify({ authorization: "Bearer legacy-secret-token" }));\n`,
      { mode: 0o600 },
    );

    secondServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      secondRequests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers });
      if (req.method === "GET" && url.pathname.endsWith("/.well-known/agent.json")) {
        return json(res, 200, {
          name: "SecondGateway",
          description: "Isolated second gateway",
          version: "3.0.0",
          capabilities: { streaming: false },
          skills: [{ id: "remote", name: "Remote" }],
        });
      }
      if (req.method === "GET" && url.pathname === "/a2a") {
        return json(res, 200, { agents: ["worker"] });
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (body.method === "message/send") {
          const msg = body.params?.message?.parts?.[0]?.text ?? "";
          return rpcResult(res, body.id, {
            id: "second-task-1",
            contextId: "second-ctx-1",
            status: {
              state: "completed",
              message: { role: "agent", parts: text(`second:${msg}`) },
            },
          });
        }
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolveListen) => {
      secondServer.listen(0, "127.0.0.1", () => {
        const addr = secondServer.address();
        if (addr && typeof addr === "object") {
          secondBaseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolveListen(undefined);
      });
    });
  });

  after(async () => {
    if (secondServer) {
      await new Promise((r) => secondServer.close(r));
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeCfg(name, obj, mode = 0o600) {
    const file = join(tmpDir, name);
    writeFileSync(file, JSON.stringify(obj), { mode });
    chmodSync(file, mode);
    return file;
  }

  it("isolates credentials, URLs, and default agents across multiple named gateways", async () => {
    const cfgPath = writeCfg("multi.json", {
      defaultGateway: "alpha",
      gateways: {
        alpha: {
          url: baseUrl,
          headersHelper: [process.execPath, alphaHelperPath],
          agent: "clerk",
          description: "Primary clerk gateway",
        },
        beta: {
          url: secondBaseUrl,
          headersHelper: [process.execPath, betaHelperPath],
          agent: "worker",
          description: "Secondary worker gateway",
        },
        open: {
          url: secondBaseUrl,
          description: "Unauthenticated loopback gateway",
        },
      },
    });

    const pi = fakePi();
    registerPiA2aExtension(pi, {
      env: {
        PI_A2A_CONFIG: cfgPath,
        PI_A2A_HEADERS_HELPER: `${process.execPath} ${legacyHelperPath}`,
        PI_A2A_AGENT: "echo",
      },
    });

    // 1. Default named gateway ("alpha") hits baseUrl with alpha token and clerk agent -> input-required
    const alphaReqStart = requests.length;
    const first = await pi.tools.get("a2a_send").execute("gw-1", { message: "Need help" });
    assert.notEqual(first.isError, true);
    assert.equal(first.details.gateway, "alpha");
    assert.equal(first.details.state, "input-required");
    assert.match(first.content[0].text, /gateway: alpha/);
    assert.match(first.content[0].text, /gateway="alpha"/);
    assert.equal(requests[alphaReqStart].headers.authorization, "Bearer alpha-secret-token");
    assert.equal(requests[alphaReqStart].path, "/a2a/clerk");

    // 2. Explicit gateway ("beta") hits secondBaseUrl with beta token and worker agent
    const betaReqStart = secondRequests.length;
    const second = await pi.tools.get("a2a_send").execute("gw-2", { gateway: "beta", message: "ping" });
    assert.notEqual(second.isError, true);
    assert.equal(second.details.gateway, "beta");
    assert.match(second.content[0].text, /second:ping/);
    assert.equal(secondRequests[betaReqStart].headers.authorization, "Bearer beta-secret-token");
    assert.equal(secondRequests[betaReqStart].path, "/a2a/worker");

    // 3. Named gateway without headersHelper sends NO authorization header and never runs legacy helper or inherits PI_A2A_AGENT
    const openReqStart = secondRequests.length;
    const third = await pi.tools.get("a2a_send").execute("gw-3", { gateway: "open", message: "public" });
    assert.notEqual(third.isError, true);
    assert.equal(third.details.gateway, "open");
    assert.equal(secondRequests[openReqStart].headers.authorization, undefined);
    assert.equal(secondRequests[openReqStart].path, "/");
    assert.equal(existsSync(legacyHelperMarker), false, "legacy helper must not execute for named gateway");

    // 4. File staging tools carry gateway attribution
    const staged = await pi.tools.get("a2a_send_file").execute("gw-4", {
      gateway: "alpha",
      task_id: "task-gw-file",
      name: "note.txt",
      content: "hello",
    });
    assert.notEqual(staged.isError, true);
    assert.equal(staged.details.gateway, "alpha");
    assert.match(staged.content[0].text, /\(gateway: alpha\)/);

    const downloaded = await pi.tools.get("a2a_get_file").execute("gw-5", {
      gateway: "alpha",
      task_id: "task-gw-file",
      name: "note.txt",
    });
    assert.notEqual(downloaded.isError, true);
    assert.equal(downloaded.details.gateway, "alpha");
    assert.match(downloaded.content[0].text, /gateway: alpha/);
  });

  it("preserves precedence: explicit env/options beat file defaultGateway", async () => {
    const cfgPath = writeCfg("prec.json", {
      defaultGateway: "beta",
      gateways: {
        alpha: { url: baseUrl, agent: "echo" },
        beta: { url: secondBaseUrl },
      },
    });

    // Legacy PI_A2A_URL beats file defaultGateway (unchanged legacy behavior)
    const piLegacyWins = fakePi();
    registerPiA2aExtension(piLegacyWins, {
      env: { PI_A2A_CONFIG: cfgPath, PI_A2A_URL: baseUrl, PI_A2A_AGENT: "echo" },
    });
    const legacyCall = await piLegacyWins.tools.get("a2a_send").execute("p-1", { message: "hello" });
    assert.notEqual(legacyCall.isError, true);
    assert.equal(legacyCall.details.gateway, undefined);
    assert.doesNotMatch(legacyCall.content[0].text, /gateway:/);
    assert.match(legacyCall.content[0].text, /echo: hello/);

    // Explicit params.gateway still reaches beta even when PI_A2A_URL is set
    const explicitBeta = await piLegacyWins.tools.get("a2a_send").execute("p-2", { gateway: "beta", message: "hi" });
    assert.notEqual(explicitBeta.isError, true);
    assert.equal(explicitBeta.details.gateway, "beta");
    assert.match(explicitBeta.content[0].text, /second:hi/);

    // PI_A2A_GATEWAY beats PI_A2A_URL and ignores PI_A2A_AGENT
    const piEnvGwWins = fakePi();
    registerPiA2aExtension(piEnvGwWins, {
      env: { PI_A2A_CONFIG: cfgPath, PI_A2A_URL: baseUrl, PI_A2A_AGENT: "clerk", PI_A2A_GATEWAY: "beta" },
    });
    const envGwStart = secondRequests.length;
    const envGwCall = await piEnvGwWins.tools.get("a2a_send").execute("p-3", { message: "via-env-gw" });
    assert.notEqual(envGwCall.isError, true);
    assert.equal(envGwCall.details.gateway, "beta");
    assert.equal(secondRequests[envGwStart].path, "/");

    // options.baseUrl beats PI_A2A_GATEWAY
    const piOptUrlWins = fakePi();
    registerPiA2aExtension(piOptUrlWins, {
      baseUrl,
      agent: "echo",
      env: { PI_A2A_CONFIG: cfgPath, PI_A2A_GATEWAY: "beta" },
    });
    const optUrlCall = await piOptUrlWins.tools.get("a2a_send").execute("p-4", { message: "opt-url" });
    assert.notEqual(optUrlCall.isError, true);
    assert.equal(optUrlCall.details.gateway, undefined);
    assert.match(optUrlCall.content[0].text, /echo: opt-url/);

    // Invalid PI_A2A_GATEWAY fails default call, but explicit params.gateway still succeeds
    const piBadEnvGw = fakePi();
    registerPiA2aExtension(piBadEnvGw, {
      env: { PI_A2A_CONFIG: cfgPath, PI_A2A_GATEWAY: "nonexistent" },
    });
    const badDefault = await piBadEnvGw.tools.get("a2a_send").execute("p-5", { message: "fail" });
    assert.equal(badDefault.isError, true);
    assert.match(badDefault.content[0].text, /Unknown A2A gateway "nonexistent"/);
    const okExplicit = await piBadEnvGw.tools.get("a2a_send").execute("p-6", { gateway: "beta", message: "ok" });
    assert.notEqual(okExplicit.isError, true);
    assert.equal(okExplicit.details.gateway, "beta");
  });

  it("refuses cross-origin AND same-origin different-path url overrides on named gateways", async () => {
    const pi = fakePi();
    registerPiA2aExtension(pi, {
      gateways: {
        sumac: {
          url: `${baseUrl}/sumac`,
          headersHelper: [process.execPath, alphaHelperPath],
        },
        coder: {
          url: `${baseUrl}/coder`,
        },
      },
      gateway: "sumac",
      env: {},
    });

    const crossOrigin = await pi.tools.get("a2a_card").execute("u-1", {
      gateway: "sumac",
      url: secondBaseUrl,
    });
    assert.equal(crossOrigin.isError, true);
    assert.match(crossOrigin.content[0].text, /Refusing to override named gateway "sumac"/);

    const sameOriginDiffPath = await pi.tools.get("a2a_card").execute("u-2", {
      gateway: "sumac",
      url: `${baseUrl}/coder`,
    });
    assert.equal(sameOriginDiffPath.isError, true);
    assert.match(sameOriginDiffPath.content[0].text, /Refusing to override named gateway "sumac"/);

    const implicitDiffPath = await pi.tools.get("a2a_card").execute("u-3", {
      url: `${baseUrl}/coder`,
    });
    assert.equal(implicitDiffPath.isError, true);
    assert.match(implicitDiffPath.content[0].text, /Refusing to override named gateway "sumac"/);
  });

  it("a2a_gateways lists configured gateways accurately without revealing helper commands or secrets", async () => {
    const cfgPath = writeCfg("inventory.json", {
      defaultGateway: "beta",
      gateways: {
        alpha: {
          url: baseUrl,
          headersHelper: [process.execPath, alphaHelperPath, "--secret-flag-never-shown"],
          agent: "echo",
          description: "Alpha gateway",
        },
        beta: {
          url: secondBaseUrl,
          description: "Beta gateway",
        },
      },
    });

    const pi = fakePi();
    registerPiA2aExtension(pi, {
      env: {
        PI_A2A_CONFIG: cfgPath,
        PI_A2A_URL: `${baseUrl}/?leaked=query`,
      },
    });

    const res = await pi.tools.get("a2a_gateways").execute("inv-1", {});
    assert.notEqual(res.isError, true);
    const out = res.content[0].text;
    assert.match(out, /alpha: .*agent: echo, auth: configured.*Alpha gateway/);
    assert.match(out, /beta: .*auth: none.*Beta gateway/);
    assert.match(out, /Legacy single-gateway \(PI_A2A_URL\) \(default\):/);
    assert.doesNotMatch(out, /beta \(default\)/);
    assert.doesNotMatch(out, /alpha-helper/);
    assert.doesNotMatch(out, /secret-flag-never-shown/);
    assert.doesNotMatch(out, /leaked=query/);
    assert.equal(res.details.activeDefault.kind, "legacy");
    assert.equal(JSON.stringify(res.details).includes("secret-flag-never-shown"), false);
  });

  it("enforces config file trust checks, strict schema, and secret-safe errors", async () => {
    // 1. Missing or relative explicit PI_A2A_CONFIG fails closed without crashing registration
    const piMissing = fakePi();
    registerPiA2aExtension(piMissing, { env: { PI_A2A_CONFIG: join(tmpDir, "does-not-exist.json") } });
    const missingRes = await piMissing.tools.get("a2a_gateways").execute("c-1", {});
    assert.equal(missingRes.isError, true);
    assert.match(missingRes.content[0].text, /ENOENT/);
    assert.throws(() => loadGatewayConfig({ PI_A2A_CONFIG: "./a2a.json" }), /must be an absolute path/);

    // 2. Default path loading from PI_CODING_AGENT_DIR, symlink to regular file, and PI_A2A_CONFIG precedence
    const agentDir = join(tmpDir, "agent-dir");
    mkdirSync(agentDir, { mode: 0o700 });
    const realTarget = writeCfg("real-target.json", {
      defaultGateway: "beta",
      gateways: { beta: { url: secondBaseUrl } },
    });
    symlinkSync(realTarget, join(agentDir, "a2a.json"));
    const loadedSymlink = loadGatewayConfig({ PI_CODING_AGENT_DIR: agentDir });
    assert.equal(loadedSymlink.source, "default-file");
    assert.equal(loadedSymlink.defaultGateway, "beta");

    const explicitOverride = writeCfg("explicit-override.json", {
      defaultGateway: "alpha",
      gateways: { alpha: { url: baseUrl } },
    });
    const loadedExplicit = loadGatewayConfig({
      PI_CODING_AGENT_DIR: agentDir,
      PI_A2A_CONFIG: explicitOverride,
    });
    assert.equal(loadedExplicit.source, "env");
    assert.equal(loadedExplicit.defaultGateway, "alpha");

    // 3. Dangling symlink at default path acts as ENOENT
    const danglingDir = join(tmpDir, "dangling-dir");
    mkdirSync(danglingDir, { mode: 0o700 });
    symlinkSync(join(tmpDir, "missing-target.json"), join(danglingDir, "a2a.json"));
    const loadedDangling = loadGatewayConfig({ PI_CODING_AGENT_DIR: danglingDir });
    assert.equal(loadedDangling.source, "none");

    // 4. Group-writable, world-writable, and FIFO paths rejected on POSIX without blocking
    if (process.platform !== "win32") {
      const groupWritable = writeCfg("group-writable.json", { gateways: { a: { url: baseUrl } } }, 0o660);
      assert.throws(() => loadGatewayConfig({ PI_A2A_CONFIG: groupWritable }), /group- or world-writable/);

      const worldWritable = writeCfg("world-writable.json", { gateways: { a: { url: baseUrl } } }, 0o646);
      assert.throws(() => loadGatewayConfig({ PI_A2A_CONFIG: worldWritable }), /group- or world-writable/);

      const fifoPath = join(tmpDir, "config.fifo");
      execFileSync("mkfifo", [fifoPath]);
      assert.throws(() => loadGatewayConfig({ PI_A2A_CONFIG: fifoPath }), /regular file/);
    }

    // 5. Oversize config rejected
    const bigFile = join(tmpDir, "oversize.json");
    writeFileSync(bigFile, " ".repeat(MAX_CONFIG_BYTES + 10), { mode: 0o600 });
    assert.throws(() => loadGatewayConfig({ PI_A2A_CONFIG: bigFile }), /exceeds maximum size/);

    // 6. Directory path rejected
    assert.throws(() => loadGatewayConfig({ PI_A2A_CONFIG: agentDir }), /regular file/);

    // 7. Invalid JSON never echoes pasted secret text
    const badJsonFile = join(tmpDir, "bad.json");
    writeFileSync(badJsonFile, '{ "token": "TOP_SECRET_PASTED_VALUE" invalid', { mode: 0o600 });
    assert.throws(
      () => loadGatewayConfig({ PI_A2A_CONFIG: badJsonFile }),
      (err) => err instanceof A2AError && /Invalid JSON/.test(err.message) && !err.message.includes("TOP_SECRET_PASTED_VALUE"),
    );

    // 8. Secret / unknown keys, query/hash URLs, relative helper paths, control chars, prototype names
    assert.throws(
      () => validateGatewayConfig({ gateways: { a: { url: baseUrl, headers: { authorization: "Bearer x" } } } }),
      /Unknown key "headers"/,
    );
    assert.throws(
      () => validateGatewayConfig({ gateways: { a: { url: `${baseUrl}/?token=secret` } } }),
      (err) => err instanceof A2AError && /query parameters or a fragment/.test(err.message) && !err.message.includes("secret"),
    );
    assert.throws(
      () => validateGatewayConfig({ gateways: { a: { url: baseUrl, headersHelper: "./local-helper.sh" } } }),
      /relative paths are not allowed/,
    );
    assert.throws(
      () => validateGatewayConfig({ gateways: { a: { url: baseUrl, headersHelper: ["../evil", "arg"] } } }),
      /relative paths are not allowed/,
    );
    assert.throws(
      () => validateGatewayConfig({ gateways: { a: { url: baseUrl, description: "line1\nfake: header" } } }),
      /control characters or newlines/,
    );
    assert.throws(
      () => validateGatewayConfig(JSON.parse('{"gateways":{"__proto__":{"url":"https://a.example"}}}'), "test"),
      /Invalid gateway name/,
    );

    // Valid Object.prototype-colliding names like "constructor" work safely in null-prototype registry
    const protoSafe = validateGatewayConfig({
      defaultGateway: "constructor",
      gateways: {
        constructor: { url: baseUrl, headersHelper: "bare-cmd-on-path" },
      },
    });
    assert.equal(protoSafe.defaultGateway, "constructor");
    assert.equal(protoSafe.gateways.constructor.url, baseUrl);
  });

  it("/a2a slash command supports gateways listing, -g/--gateway flags, and preserves free-text messages", async () => {
    assert.deepEqual(parseSlashArgs("gateways"), { kind: "gateways" });
    assert.deepEqual(parseSlashArgs("gateways are down"), {
      kind: "send",
      gateway: undefined,
      agent: undefined,
      message: "gateways are down",
    });
    assert.deepEqual(parseSlashArgs("-g beta @worker check status"), {
      kind: "send",
      gateway: "beta",
      agent: "worker",
      message: "check status",
    });
    assert.deepEqual(parseSlashArgs("card --gateway beta @worker"), {
      kind: "card",
      gateway: "beta",
      agent: "worker",
    });
    assert.equal(parseSlashArgs("-g").kind, "error");
    assert.equal(parseSlashArgs("-g BAD_NAME hello").kind, "error");

    const commands = new Map();
    const pi = { registerTool() {}, registerCommand: (n, c) => commands.set(n, c) };
    registerPiA2aExtension(pi, {
      gateways: {
        alpha: { url: baseUrl, agent: "echo" },
        beta: { url: secondBaseUrl, agent: "worker" },
      },
      gateway: "alpha",
      env: {},
    });
    const notices = [];
    const ctx = { ui: { notify: (msg, level) => notices.push({ msg, level }) } };

    await commands.get("a2a").handler("gateways", ctx);
    assert.equal(notices.at(-1).level, "info");
    assert.match(notices.at(-1).msg, /alpha \(default\)/);
    assert.match(notices.at(-1).msg, /beta:/);

    await commands.get("a2a").handler("-g beta ping", ctx);
    assert.equal(notices.at(-1).level, "info");
    assert.match(notices.at(-1).msg, /gateway: beta/);
    assert.match(notices.at(-1).msg, /second:ping/);

    await commands.get("a2a").handler("card --gateway beta @worker", ctx);
    assert.equal(notices.at(-1).level, "info");
    assert.match(notices.at(-1).msg, /gateway: beta/);
    assert.match(notices.at(-1).msg, /SecondGateway/);
  });

  it("runs named-gateway headersHelper with cwd pinned to the config directory, not process.cwd()", async () => {
    const cfgDir = join(tmpDir, "helper-cwd-dir");
    mkdirSync(cfgDir, { mode: 0o700 });
    const cwdLogPath = join(cfgDir, "observed-cwd.txt");
    const cwdProbe = join(cfgDir, "cwd-probe.mjs");
    writeFileSync(
      cwdProbe,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(cwdLogPath)}, process.cwd());\nprocess.stdout.write(JSON.stringify({ authorization: "Bearer cwd-ok" }));\n`,
      { mode: 0o600 },
    );
    const cfgFile = join(cfgDir, "a2a.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        defaultGateway: "beta",
        gateways: {
          beta: {
            url: secondBaseUrl,
            headersHelper: [process.execPath, "./cwd-probe.mjs"],
          },
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(cfgFile, 0o600);

    const pi = fakePi();
    registerPiA2aExtension(pi, { env: { PI_A2A_CONFIG: cfgFile } });
    const res = await pi.tools.get("a2a_send").execute("cwd-1", { message: "check-cwd" });
    assert.notEqual(res.isError, true);
    assert.equal(realpathSync(readFileSync(cwdLogPath, "utf8")), realpathSync(cfgDir));
  });
});

// ---------------------------------------------------------------------------
// A2A v1.0 protocol support (official spec, sumac-mcp, and Swival shapes)
// ---------------------------------------------------------------------------

describe("A2A v1.0 protocol support", () => {
  /** @type {http.Server} */
  let v1Server;
  let v1BaseUrl = "";
  /** @type {Array<{ method: string; path: string; rpcMethod?: string; body?: any }>} */
  const v1Requests = [];
  /** @type {Map<string, any>} */
  const v1Tasks = new Map();
  let v1Seq = 0;

  before(async () => {
    v1Server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET") {
        v1Requests.push({ method: "GET", path });
        if (path === "/.well-known/agent-card.json") {
          return json(res, 200, {
            name: "V1Gateway",
            description: "Pure A2A v1.0 server",
            version: "2.0.0",
            capabilities: { streaming: true },
            supportedInterfaces: [
              { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: `${v1BaseUrl}/` },
            ],
            skills: [{ id: "code", name: "Code", description: "Run code tasks" }],
          });
        }
        if (path === "/a2a/swival/.well-known/agent-card.json") {
          return json(res, 200, {
            name: "swival (vertexai/gemini)",
            version: "0.1.0",
            url: `${v1BaseUrl}/a2a/swival`,
            capabilities: { streaming: true },
            supportedInterfaces: [
              { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: `${v1BaseUrl}/a2a/swival` },
            ],
            skills: [],
          });
        }
        // Explicitly 404 on v0.3 card paths and /a2a directory
        res.writeHead(404);
        return res.end("not found");
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }

      const raw = await readBody(req);
      const body = JSON.parse(raw);
      v1Requests.push({ method: "POST", path, rpcMethod: body.method, body });

      if (req.headers.authorization === "Bearer unauthorized-check") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Unauthorized" } }));
      }

      if (body.params?.message?.parts?.[0]?.text === "trigger-invalid-params-auto") {
        return rpcError(res, body.id, -32602, "Invalid params");
      }

      // Reject v0.3 methods strictly with -32601
      if (
        body.method === "message/send" ||
        body.method === "message/stream" ||
        body.method === "tasks/get" ||
        body.method === "tasks/cancel"
      ) {
        return rpcError(res, body.id, -32601, `Unknown method: ${body.method}`);
      }

      const isSwival = path === "/a2a/swival";

      if (body.method === "SendMessage") {
        const msg = body.params?.message;
        const firstPart = msg?.parts?.[0];
        const prompt = firstPart?.text ?? "";
        if (prompt === "trigger-invalid-params") {
          return rpcError(res, body.id, -32602, "Invalid params");
        }
        if (prompt === "trigger-withheld") {
          return rpcError(res, body.id, -32000, "Policy blocked", { reason: "reply_withheld" });
        }
        if (prompt === "direct-message") {
          return rpcResult(res, body.id, {
            message: { role: "ROLE_AGENT", parts: [{ text: "direct-v1-reply" }], contextId: "ctx-direct" },
          });
        }
        if (prompt === "need-more-info") {
          const id = `v1-task-${++v1Seq}`;
          const task = {
            id,
            contextId: msg.contextId ?? `v1-ctx-${v1Seq}`,
            status: {
              state: "TASK_STATE_INPUT_REQUIRED",
              message: { role: "ROLE_AGENT", parts: [{ text: "Which environment?" }] },
            },
            artifacts: [],
          };
          v1Tasks.set(id, task);
          return rpcResult(res, body.id, { task });
        }
        if (msg.taskId && v1Tasks.has(msg.taskId)) {
          const task = v1Tasks.get(msg.taskId);
          task.status = { state: "TASK_STATE_COMPLETED" };
          task.artifacts = [{ artifactId: "reply", name: "answer", parts: [{ text: `continued:${prompt}` }] }];
          return rpcResult(res, body.id, { task });
        }
        if (prompt === "start-working") {
          const id = `v1-work-${++v1Seq}`;
          const task = {
            id,
            contextId: "v1-ctx-work",
            status: { state: "TASK_STATE_WORKING" },
            artifacts: [],
            history: [{ role: "ROLE_AGENT", parts: [{ text: "still crunching" }] }],
          };
          v1Tasks.set(id, task);
          return rpcResult(res, body.id, task);
        }
        if (isSwival) {
          // Swival puts the identical answer text in BOTH artifacts and status.message
          const id = `swival-task-${++v1Seq}`;
          const answer = `swival-answer:${prompt}`;
          const task = {
            id,
            contextId: msg.contextId ?? `swival-ctx-${v1Seq}`,
            status: {
              state: "completed",
              message: { role: "agent", parts: [{ type: "text", text: answer }] },
            },
            artifacts: [{ parts: [{ type: "text", text: answer }] }],
          };
          v1Tasks.set(id, task);
          return rpcResult(res, body.id, task);
        }

        const id = `v1-done-${++v1Seq}`;
        const task = {
          id,
          contextId: msg.contextId ?? `v1-ctx-${v1Seq}`,
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ artifactId: "a1", parts: [{ text: `v1:${msg.role}:${prompt}` }] }],
        };
        v1Tasks.set(id, task);
        return rpcResult(res, body.id, { task });
      }

      if (body.method === "SendStreamingMessage") {
        const msg = body.params?.message;
        const prompt = msg?.parts?.[0]?.text ?? "";
        const id = `v1-stream-${++v1Seq}`;
        const ctx = msg.contextId ?? `v1-sctx-${v1Seq}`;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });

        if (prompt === "task-history-only") {
          sseWrite(res, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              task: {
                id,
                contextId: ctx,
                status: { state: "TASK_STATE_COMPLETED" },
                history: [{ messageId: "m-h1", role: "ROLE_AGENT", parts: [{ text: "history-only-answer" }] }],
              },
            },
          });
          return res.end();
        }
        if (prompt === "task-messages-only") {
          sseWrite(res, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              task: {
                id,
                contextId: ctx,
                status: { state: "TASK_STATE_COMPLETED" },
                messages: [{ role: "agent", parts: [{ type: "text", text: "messages-only-answer" }] }],
              },
            },
          });
          return res.end();
        }

        if (isSwival) {
          // Swival emits bare SSE events (no JSON-RPC wrapper, no final flag)
          sseWrite(
            res,
            { taskId: id, contextId: ctx, status: { state: "working" } },
            { event: "TaskStatusUpdateEvent" },
          );
          sseWrite(
            res,
            { taskId: id, contextId: ctx, status: { state: "working" }, metadata: { type: "heartbeat", idle: 15.0 } },
            { event: "TaskStatusUpdateEvent" },
          );
          sseWrite(
            res,
            { taskId: id, contextId: ctx, artifact: { parts: [{ type: "text", text: "draft" }] } },
            { event: "TaskArtifactUpdateEvent" },
          );
          sseWrite(
            res,
            { taskId: id, contextId: ctx, artifact: { parts: [{ type: "text", text: `swival-stream:${prompt}` }] } },
            { event: "TaskArtifactUpdateEvent" },
          );
          sseWrite(
            res,
            { taskId: id, contextId: ctx, status: { state: "completed" } },
            { event: "TaskStatusUpdateEvent" },
          );
          return res.end();
        }

        // Official A2A v1.0 / sumac-mcp union-wrapped JSON-RPC SSE frames
        sseWrite(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            statusUpdate: {
              taskId: id,
              contextId: ctx,
              status: { state: "TASK_STATE_WORKING" },
              final: false,
            },
          },
        });
        sseWrite(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            artifactUpdate: {
              taskId: id,
              contextId: ctx,
              artifact: { artifactId: "reply", name: "answer", parts: [{ text: "hello " }] },
              append: false,
              lastChunk: false,
            },
          },
        });
        sseWrite(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            artifactUpdate: {
              taskId: id,
              contextId: ctx,
              artifact: { artifactId: "reply", name: "answer", parts: [{ text: prompt }] },
              append: true,
              lastChunk: true,
            },
          },
        });
        sseWrite(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            statusUpdate: {
              taskId: id,
              contextId: ctx,
              status: { state: "TASK_STATE_COMPLETED" },
              final: true,
            },
          },
        });
        return res.end();
      }

      if (body.method === "GetTask") {
        const task = v1Tasks.get(body.params?.id);
        if (!task) return rpcError(res, body.id, -32001, "Task not found");
        return rpcResult(res, body.id, task);
      }

      if (body.method === "CancelTask") {
        const task = v1Tasks.get(body.params?.id);
        if (!task) return rpcError(res, body.id, -32001, "Task not found");
        task.status = { state: "TASK_STATE_CANCELED" };
        return rpcResult(res, body.id, task);
      }

      return rpcError(res, body.id, -32601, `Unknown method: ${body.method}`);
    });

    await new Promise((resolve) => v1Server.listen(0, "127.0.0.1", resolve));
    const addr = /** @type {import("node:net").AddressInfo} */ (v1Server.address());
    v1BaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => v1Server.close(resolve));
  });

  it("normalizes v1.0 task states, union wrappers, ROLE_AGENT history, and Swival duplicate status text", () => {
    assert.equal(normalizeTaskState("TASK_STATE_SUBMITTED"), "submitted");
    assert.equal(normalizeTaskState("TASK_STATE_WORKING"), "working");
    assert.equal(normalizeTaskState("TASK_STATE_INPUT_REQUIRED"), "input-required");
    assert.equal(normalizeTaskState("TASK_STATE_COMPLETED"), "completed");
    assert.equal(normalizeTaskState("TASK_STATE_CANCELED"), "canceled");
    assert.equal(normalizeTaskState("TASK_STATE_FAILED"), "failed");
    assert.equal(normalizeTaskState("TASK_STATE_REJECTED"), "rejected");
    assert.equal(normalizeTaskState("TASK_STATE_AUTH_REQUIRED"), "auth-required");
    assert.equal(normalizeTaskState("TASK_STATE_UNSPECIFIED"), "unknown");
    assert.equal(normalizeTaskState("completed"), "completed");

    assert.deepEqual(
      buildMessageParams({ message: "hi", messageId: "m1", protocol: "1.0" }),
      { message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "hi" }] } },
    );
    assert.deepEqual(
      buildMessageParams({ message: "hi", messageId: "m2", protocol: "0.3" }),
      { message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "text", text: "hi" }] } },
    );

    const wrappedMsg = normalizeResult({
      message: { role: "ROLE_AGENT", parts: [{ text: "hello" }], taskId: "t1", contextId: "c1" },
    });
    assert.equal(wrappedMsg.state, "completed");
    assert.equal(wrappedMsg.text, "hello");
    assert.equal(wrappedMsg.taskId, "t1");

    const historyFallback = normalizeResult({
      task: {
        id: "t2",
        contextId: "c2",
        status: { state: "TASK_STATE_COMPLETED" },
        history: [
          { role: "ROLE_USER", parts: [{ text: "q" }] },
          { role: "ROLE_AGENT", parts: [{ text: "a" }] },
        ],
      },
    });
    assert.equal(historyFallback.state, "completed");
    assert.equal(historyFallback.text, "a");

    // Identical artifact + status.message text is deduplicated (Swival format)
    const dedup = normalizeResult({
      id: "t3",
      status: { state: "completed", message: { role: "agent", parts: [{ type: "text", text: "same" }] } },
      artifacts: [{ parts: [{ type: "text", text: "same" }] }],
    });
    assert.equal(dedup.text, "same");

    // Distinct artifact + status.message text are both preserved
    const distinct = normalizeResult({
      id: "t4",
      status: { state: "completed", message: { role: "agent", parts: [{ text: "summary" }] } },
      artifacts: [{ parts: [{ text: "artifact body" }] }],
    });
    assert.equal(distinct.text, "artifact body\nsummary");
  });

  it("speaks pure A2A v1.0 directly with protocol: '1.0' (zero v0.3 probes)", async () => {
    v1Requests.length = 0;

    const card = await getAgentCard({ baseUrl: v1BaseUrl, protocol: "1.0" });
    assert.equal(card.name, "V1Gateway");
    assert.equal(card.protocolVersion, "1.0");
    assert.equal(card.url, `${v1BaseUrl}/`);
    assert.equal(card.cardUrl, `${v1BaseUrl}${AGENT_CARD_V1_PATH}`);
    assert.equal(v1Requests.length, 1);
    assert.equal(v1Requests[0].path, AGENT_CARD_V1_PATH);

    v1Requests.length = 0;
    const sent = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "ping" });
    assert.equal(sent.state, "completed");
    assert.equal(sent.text, "v1:ROLE_USER:ping");
    assert.equal(v1Requests.length, 1);
    assert.equal(v1Requests[0].rpcMethod, "SendMessage");
    assert.equal(v1Requests[0].body.params.message.kind, undefined);
    assert.equal(v1Requests[0].body.params.message.role, "ROLE_USER");
    assert.deepEqual(v1Requests[0].body.params.message.parts, [{ text: "ping" }]);

    // Direct wrapped message result
    const direct = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "direct-message" });
    assert.equal(direct.state, "completed");
    assert.equal(direct.text, "direct-v1-reply");

    // Union-wrapped v1.0 SSE stream
    v1Requests.length = 0;
    /** @type {any[]} */
    const seen = [];
    const streamed = await sendMessage({
      baseUrl: v1BaseUrl,
      protocol: "1.0",
      message: "v1-world",
      stream: true,
      onEvent: (e) => seen.push(e),
    });
    assert.equal(streamed.state, "completed");
    assert.equal(streamed.text, "hello v1-world");
    assert.equal(v1Requests.length, 1);
    assert.equal(v1Requests[0].rpcMethod, "SendStreamingMessage");
    assert.ok(seen.some((e) => e.kind === "status-update" && e.state === "working"));
    assert.ok(seen.some((e) => e.kind === "status-update" && e.state === "completed" && e.final === true));

    // GetTask + CancelTask
    const working = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "start-working" });
    assert.equal(working.state, "working");
    assert.equal(working.text, "still crunching");

    v1Requests.length = 0;
    const fetched = await getTask({ baseUrl: v1BaseUrl, protocol: "1.0", taskId: working.taskId });
    assert.equal(fetched.state, "working");
    assert.equal(v1Requests.length, 1);
    assert.equal(v1Requests[0].rpcMethod, "GetTask");

    v1Requests.length = 0;
    const canceled = await cancelTask({ baseUrl: v1BaseUrl, protocol: "1.0", taskId: working.taskId });
    assert.equal(canceled.state, "canceled");
    assert.equal(v1Requests.length, 1);
    assert.equal(v1Requests[0].rpcMethod, "CancelTask");
  });

  it("handles Swival-style v1.0 responses, bare SSE events, and root-only discovery", async () => {
    const discovery = await discoverAgents({ baseUrl: v1BaseUrl, protocol: "1.0" });
    assert.equal(discovery.agents.length, 1);
    assert.equal(discovery.agents[0].name, "V1Gateway");

    const syncRes = await sendMessage({ baseUrl: v1BaseUrl, agent: "swival", protocol: "1.0", message: "check" });
    assert.equal(syncRes.state, "completed");
    assert.equal(syncRes.text, "swival-answer:check");

    const streamRes = await sendMessage({
      baseUrl: v1BaseUrl,
      agent: "swival",
      protocol: "1.0",
      message: "build",
      stream: true,
    });
    assert.equal(streamRes.state, "completed");
    assert.equal(streamRes.text, "swival-stream:build");
  });

  it("auto-negotiates v1.0 on 404 / -32601 without retrying non-method errors, while protocol '0.3' stays strict", async () => {
    // Auto falls back on 404 for Agent Card
    v1Requests.length = 0;
    const autoCard = await getAgentCard({ baseUrl: v1BaseUrl });
    assert.equal(autoCard.name, "V1Gateway");
    assert.deepEqual(
      v1Requests.map((r) => r.path),
      [AGENT_CARD_PATH, AGENT_CARD_V1_PATH],
    );

    // Auto falls back on -32601 for sendMessage, streaming, getTask, and cancelTask
    v1Requests.length = 0;
    const autoSent = await sendMessage({ baseUrl: v1BaseUrl, message: "auto-ping" });
    assert.equal(autoSent.text, "v1:ROLE_USER:auto-ping");
    assert.deepEqual(
      v1Requests.map((r) => r.rpcMethod),
      ["message/send", "SendMessage"],
    );

    v1Requests.length = 0;
    const autoStream = await sendMessage({ baseUrl: v1BaseUrl, message: "auto-stream", stream: true });
    assert.equal(autoStream.state, "completed");
    assert.equal(autoStream.text, "hello auto-stream");
    assert.deepEqual(
      v1Requests.map((r) => r.rpcMethod),
      ["message/stream", "SendStreamingMessage"],
    );

    // Auto falls back on -32601 for getTask and cancelTask too
    const autoWorking = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "start-working" });
    v1Requests.length = 0;
    const autoFetched = await getTask({ baseUrl: v1BaseUrl, taskId: autoWorking.taskId });
    assert.equal(autoFetched.state, "working");
    assert.deepEqual(
      v1Requests.map((r) => r.rpcMethod),
      ["tasks/get", "GetTask"],
    );

    v1Requests.length = 0;
    const autoCanceled = await cancelTask({ baseUrl: v1BaseUrl, taskId: autoWorking.taskId });
    assert.equal(autoCanceled.state, "canceled");
    assert.deepEqual(
      v1Requests.map((r) => r.rpcMethod),
      ["tasks/cancel", "CancelTask"],
    );

    // Auto does NOT retry non--32601 errors (e.g., 401 unauthorized or -32602 invalid params)
    v1Requests.length = 0;
    await assert.rejects(
      () => sendMessage({ baseUrl: v1BaseUrl, headers: { authorization: "Bearer unauthorized-check" }, message: "x" }),
      (err) => err instanceof A2AError && err.status === 401,
    );
    assert.equal(v1Requests.length, 1);

    v1Requests.length = 0;
    await assert.rejects(
      () => sendMessage({ baseUrl: v1BaseUrl, message: "trigger-invalid-params-auto" }),
      (err) => err instanceof A2AError && err.code === -32602,
    );
    assert.equal(v1Requests.length, 1);
    assert.equal(v1Requests[0].rpcMethod, "message/send");

    // reply_withheld works in v1.0 too
    const withheld = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "trigger-withheld" });
    assert.equal(withheld.state, "reply_withheld");

    // Strict "0.3" never falls back to v1.0
    v1Requests.length = 0;
    await assert.rejects(
      () => getAgentCard({ baseUrl: v1BaseUrl, protocol: "0.3" }),
      (err) => err instanceof A2AError && err.status === 404,
    );
    assert.deepEqual(v1Requests.map((r) => r.path), [AGENT_CARD_PATH]);

    v1Requests.length = 0;
    await assert.rejects(
      () => sendMessage({ baseUrl: v1BaseUrl, protocol: "0.3", message: "strict-v03" }),
      (err) => err instanceof A2AError && err.code === -32601,
    );
    assert.deepEqual(v1Requests.map((r) => r.rpcMethod), ["message/send"]);
  });

  it("supports per-gateway protocol in a2a.json, isolates PI_A2A_PROTOCOL, and handles v1.0 input-required via Pi tools", async () => {
    // Config validation rejects invalid protocol without echoing secret values
    assert.throws(
      () => validateGatewayConfig({ gateways: { bad: { url: v1BaseUrl, protocol: "SECRET_PROTO_VAL" } } }),
      (err) => err instanceof A2AError && /Invalid protocol/.test(err.message) && !err.message.includes("SECRET_PROTO_VAL"),
    );
    assert.throws(() => normalizeProtocol("2.0"), /Invalid protocol/);

    const pi = fakePi();
    registerPiA2aExtension(pi, {
      gateways: {
        coder: { url: v1BaseUrl, protocol: "1.0", description: "Remote Coder v1.0" },
        legacy: { url: baseUrl, protocol: "0.3", agent: "echo" },
      },
      // Named gateways must NOT inherit PI_A2A_PROTOCOL even if set to an invalid value
      env: { PI_A2A_PROTOCOL: "invalid-should-be-ignored-for-named" },
    });

    const gwList = await pi.tools.get("a2a_gateways").execute("v1-gw-1", {});
    assert.notEqual(gwList.isError, true);
    assert.match(gwList.content[0].text, /coder:.*protocol: 1\.0/);
    assert.match(gwList.content[0].text, /legacy:.*protocol: 0\.3/);

    const cardRes = await pi.tools.get("a2a_card").execute("v1-card-1", { gateway: "coder" });
    assert.notEqual(cardRes.isError, true);
    assert.match(cardRes.content[0].text, /protocolVersion: 1\.0/);

    // input-required -> a2a_reply over v1.0
    const askRes = await pi.tools.get("a2a_send").execute("v1-ask-1", { gateway: "coder", message: "need-more-info" });
    assert.notEqual(askRes.isError, true);
    assert.equal(askRes.details.state, "input-required");
    assert.match(askRes.content[0].text, /Continue with a2a_reply/);

    const replyRes = await pi.tools.get("a2a_reply").execute("v1-rep-1", {
      gateway: "coder",
      task_id: askRes.details.taskId,
      message: "dev-usc1",
    });
    assert.notEqual(replyRes.isError, true);
    assert.equal(replyRes.details.state, "completed");
    assert.match(replyRes.content[0].text, /continued:dev-usc1/);

    // Named legacy v0.3 gateway routes with v0.3 directly
    const legacyNamedRes = await pi.tools.get("a2a_send").execute("v1-leg-1", { gateway: "legacy", message: "hello-v03" });
    assert.notEqual(legacyNamedRes.isError, true);
    assert.match(legacyNamedRes.content[0].text, /echo: hello-v03/);

    // Legacy PI_A2A_URL honors PI_A2A_PROTOCOL and fails closed on invalid value
    const legacyBadPi = fakePi();
    registerPiA2aExtension(legacyBadPi, { env: { PI_A2A_URL: v1BaseUrl, PI_A2A_PROTOCOL: "9.9" } });
    const badRes = await legacyBadPi.tools.get("a2a_card").execute("v1-bad-1", {});
    assert.equal(badRes.isError, true);
    assert.match(badRes.content[0].text, /Invalid PI_A2A_PROTOCOL/);

    const legacyV1Pi = fakePi();
    registerPiA2aExtension(legacyV1Pi, { env: { PI_A2A_URL: v1BaseUrl, PI_A2A_PROTOCOL: "1.0" } });
    const okLegacy = await legacyV1Pi.tools.get("a2a_send").execute("v1-ok-1", { message: "via-env" });
    assert.notEqual(okLegacy.isError, true);
    assert.match(okLegacy.content[0].text, /v1:ROLE_USER:via-env/);
  });

  it("preserves origin pinning across mutable URL/options during fallback, handles history-only streaming Tasks, blocks observer/mid-stream retries, and enforces deadline exhaustion", async () => {
    // 1. Mutating a caller-owned URL object while getAgentCard's v0.3 request is in flight cannot redirect fallback
    const mutableUrl = new URL("https://safe.example");
    /** @type {string[]} */
    const cardSeenUrls = [];
    const cardFetch = async (url) => {
      cardSeenUrls.push(String(url));
      if (cardSeenUrls.length === 1) {
        mutableUrl.hostname = "evil.example";
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ name: "SafeV1", version: "1.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const pinnedCard = await getAgentCard({
      baseUrl: mutableUrl,
      pinnedOrigin: "https://safe.example",
      headers: { authorization: "Bearer SECRET" },
      fetchImpl: cardFetch,
    });
    assert.equal(pinnedCard.name, "SafeV1");
    assert.deepEqual(cardSeenUrls, [
      "https://safe.example/.well-known/agent.json",
      "https://safe.example/.well-known/agent-card.json",
    ]);

    // 2. Mutating options.baseUrl while streaming fallback is in flight cannot redirect the v1 retry
    /** @type {string[]} */
    const streamSeenUrls = [];
    const mutableOpts = {
      baseUrl: "https://safe.example",
      pinnedOrigin: "https://safe.example",
      headers: { authorization: "Bearer SECRET" },
      message: "hi",
      stream: true,
      fetchImpl: async (url) => {
        streamSeenUrls.push(String(url));
        if (streamSeenUrls.length === 1) {
          mutableOpts.baseUrl = "https://evil.example";
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: "2", result: { message: { role: "ROLE_AGENT", parts: [{ text: "ok" }] } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    };
    const pinnedStream = await sendMessage(mutableOpts);
    assert.equal(pinnedStream.text, "ok");
    assert.deepEqual(streamSeenUrls, ["https://safe.example/", "https://safe.example/"]);

    // 3. Streaming completed Task wrappers with history-only or messages-only answers preserve text
    const histTask = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "task-history-only", stream: true });
    assert.equal(histTask.state, "completed");
    assert.equal(histTask.text, "history-only-answer");

    const msgTask = await sendMessage({ baseUrl: v1BaseUrl, protocol: "1.0", message: "task-messages-only", stream: true });
    assert.equal(msgTask.state, "completed");
    assert.equal(msgTask.text, "messages-only-answer");

    // 4. Observer onEvent throwing A2AError(-32601) after an accepted event never triggers a retry
    let observerFetchCount = 0;
    const observerFetch = async () => {
      observerFetchCount += 1;
      const body = `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { kind: "status-update", taskId: "t1", status: { state: "working" }, final: false },
      })}\n\n`;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await assert.rejects(
      () =>
        sendMessage({
          baseUrl: "https://safe.example",
          message: "hi",
          stream: true,
          fetchImpl: observerFetch,
          onEvent: () => {
            throw new A2AError("observer failure", { code: -32601 });
          },
        }),
      (err) => err instanceof A2AError && err.message === "observer failure",
    );
    assert.equal(observerFetchCount, 1);

    // 5. Remote mid-stream JSON-RPC -32601 after an accepted event never triggers a retry
    let midStreamFetchCount = 0;
    const midStreamFetch = async () => {
      midStreamFetchCount += 1;
      const body =
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { kind: "status-update", taskId: "t1", status: { state: "working" }, final: false },
        })}\n\n` +
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          error: { code: -32601, message: "late method error" },
        })}\n\n`;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await assert.rejects(
      () => sendMessage({ baseUrl: "https://safe.example", message: "hi", stream: true, fetchImpl: midStreamFetch }),
      (err) => err instanceof A2AError && err.code === -32601,
    );
    assert.equal(midStreamFetchCount, 1);

    // 6. Multi-frame stream: earlier progress statusUpdate does NOT suppress a terminal Task's history/messages answer,
    //    and a later textless statusUpdate does NOT re-emit stale history text to onEvent
    const multiFrameHistoryFetch = async () =>
      new Response(
        `data: ${JSON.stringify({
          result: {
            statusUpdate: {
              taskId: "t-mf",
              contextId: "c-mf",
              status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", parts: [{ text: "Working" }] } },
            },
          },
        })}\n\n` +
          `data: ${JSON.stringify({
            result: {
              task: {
                id: "t-mf",
                contextId: "c-mf",
                status: { state: "TASK_STATE_COMPLETED" },
                history: [{ role: "ROLE_AGENT", parts: [{ text: "Final answer" }] }],
              },
            },
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const mfHist = await sendMessage({
      baseUrl: "https://safe.example",
      protocol: "1.0",
      message: "hi",
      stream: true,
      fetchImpl: multiFrameHistoryFetch,
    });
    assert.equal(mfHist.state, "completed");
    assert.equal(mfHist.text, "Final answer");

    const multiFrameMessagesFetch = async () =>
      new Response(
        `data: ${JSON.stringify({
          result: {
            statusUpdate: {
              taskId: "t-mf2",
              contextId: "c-mf2",
              status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", parts: [{ text: "Working" }] } },
            },
          },
        })}\n\n` +
          `data: ${JSON.stringify({
            result: {
              task: {
                id: "t-mf2",
                contextId: "c-mf2",
                status: { state: "TASK_STATE_COMPLETED" },
                messages: [{ role: "agent", parts: [{ type: "text", text: "Messages final" }] }],
              },
            },
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const mfMsg = await sendMessage({
      baseUrl: "https://safe.example",
      protocol: "1.0",
      message: "hi",
      stream: true,
      fetchImpl: multiFrameMessagesFetch,
    });
    assert.equal(mfMsg.state, "completed");
    assert.equal(mfMsg.text, "Messages final");

    /** @type {Array<{ kind: string; text?: string }>} */
    const staleCheckEvents = [];
    const staleHistoryEventFetch = async () =>
      new Response(
        `data: ${JSON.stringify({
          result: {
            task: {
              id: "t-sh",
              contextId: "c-sh",
              status: { state: "TASK_STATE_WORKING" },
              history: [{ role: "ROLE_AGENT", parts: [{ text: "partial" }] }],
            },
          },
        })}\n\n` +
          `data: ${JSON.stringify({
            result: {
              statusUpdate: {
                taskId: "t-sh",
                contextId: "c-sh",
                status: { state: "TASK_STATE_WORKING" },
              },
            },
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    await sendMessage({
      baseUrl: "https://safe.example",
      protocol: "1.0",
      message: "hi",
      stream: true,
      fetchImpl: staleHistoryEventFetch,
      onEvent: (e) => staleCheckEvents.push({ kind: e.kind, text: e.text }),
    });
    assert.equal(staleCheckEvents.length, 2);
    assert.equal(staleCheckEvents[0].text, "partial");
    assert.equal(staleCheckEvents[1].text, "");

    // 7. HTTP 405 on v0.3 Agent Card falls back to v1.0 in auto mode; strict protocol "1.0" never falls back to v0.3 on -32601
    /** @type {string[]} */
    const card405Urls = [];
    const card405 = await getAgentCard({
      baseUrl: "https://safe.example",
      fetchImpl: async (url) => {
        card405Urls.push(String(url));
        if (card405Urls.length === 1) return new Response("method not allowed", { status: 405 });
        return new Response(JSON.stringify({ name: "V1After405" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(card405.name, "V1After405");
    assert.deepEqual(card405Urls, [
      "https://safe.example/.well-known/agent.json",
      "https://safe.example/.well-known/agent-card.json",
    ]);

    let strictV1Calls = 0;
    await assert.rejects(
      () =>
        sendMessage({
          baseUrl: "https://safe.example",
          protocol: "1.0",
          message: "hi",
          fetchImpl: async () => {
            strictV1Calls += 1;
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Unknown method: SendMessage" } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
      (err) => err instanceof A2AError && err.code === -32601,
    );
    assert.equal(strictV1Calls, 1);

    // 8. Exhausted timeout deadline rejects before starting a fallback request (card & sendMessage; mocks intentionally ignore abort signal to return after deadline)
    let timeoutFetchCount = 0;
    const slow404Fetch = async () => {
      timeoutFetchCount += 1;
      await new Promise((r) => setTimeout(r, 35));
      return new Response("not found", { status: 404 });
    };
    await assert.rejects(
      () => getAgentCard({ baseUrl: "https://safe.example", timeoutMs: 20, fetchImpl: slow404Fetch }),
      (err) => err instanceof A2AError && /timed out/.test(err.message),
    );
    assert.equal(timeoutFetchCount, 1);

    let sendTimeoutCount = 0;
    const slowRpc404Fetch = async () => {
      sendTimeoutCount += 1;
      await new Promise((r) => setTimeout(r, 35));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await assert.rejects(
      () => sendMessage({ baseUrl: "https://safe.example", message: "hi", timeoutMs: 20, fetchImpl: slowRpc404Fetch }),
      (err) => err instanceof A2AError && /timed out/.test(err.message),
    );
    assert.equal(sendTimeoutCount, 1);
  });
});
