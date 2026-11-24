/**
 * A2A v1.0 Specification Conformance Test Suite for @sheurich/pi-a2a.
 *
 * Pinned against upstream specification commit:
 *   a2aproject/A2A @ 5f931b8a25fe66789f987ec4a55fc16ee9fe41ee
 *   (docs/specification.md and specification/a2a.proto)
 *
 * Enforces normative client MUST requirements on a strict spec-conforming server:
 * - §3.1.2: Task lifecycle streams begin with an initial `Task` object.
 * - §3.6.1 / §3.6.2 / §9.2: `A2A-Version: 1.0` HTTP header on v1.0 requests (authoritative over
 *   conflicting caller headers); omitted on v0.3 requests and rejected with `-32009 VersionNotSupportedError` (HTTP 400).
 * - §4.1.3 / §4.1.5: All nine canonical `TASK_STATE_*` enums and `ROLE_USER` / `ROLE_AGENT`.
 * - §4.4.1 / §4.4.6: `/.well-known/agent-card.json` discovery and JSONRPC `supportedInterfaces` selection.
 * - §5.4: All nine canonical A2A JSON-RPC error codes (`-32001` through `-32009`).
 * - §9.1–§9.4: Strict JSON-RPC 2.0 envelopes, camelCase params, PascalCase methods
 *   (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`), `{ task }` / `{ message }`
 *   sync union wrappers, and `StreamResponse` SSE union wrappers (`task`, `statusUpdate`,
 *   `artifactUpdate`, `message`).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  A2AError,
  A2A_ERROR_CODES,
  A2A_VERSION_HEADER,
  AGENT_CARD_V1_PATH,
  cancelTask,
  discoverAgents,
  getAgentCard,
  getTask,
  normalizeTaskState,
  sendMessage,
} from "../src/client.mjs";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Validates strict v1.0 Message encoding shared by SendMessage and SendStreamingMessage.
 *
 * @param {any} msg
 * @returns {string | null}
 */
function validateV1Message(msg) {
  if (!msg || "kind" in msg || msg.role !== "ROLE_USER" || typeof msg.messageId !== "string" || !msg.messageId) {
    return "Invalid v1.0 Message envelope";
  }
  const part = msg.parts?.[0];
  if (!part || "kind" in part || "type" in part || typeof part.text !== "string") {
    return "Invalid v1.0 Part encoding";
  }
  return null;
}

describe("A2A v1.0 specification conformance (a2aproject/A2A@5f931b8a)", () => {
  /** @type {http.Server} */
  let server;
  let baseUrl = "";
  /** @type {Array<{ method: string; path: string; a2aVersion: string | undefined; rpcMethod?: string; body?: any }>} */
  const seen = [];
  /** @type {Map<string, any>} */
  const tasks = new Map();
  let seq = 0;

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const a2aVersion = typeof req.headers[A2A_VERSION_HEADER] === "string"
        ? req.headers[A2A_VERSION_HEADER]
        : undefined;

      if (req.method === "GET") {
        seen.push({ method: "GET", path: url.pathname, a2aVersion });
        if (url.pathname === AGENT_CARD_V1_PATH) {
          return sendJson(res, 200, {
            name: "StrictSpecV1Agent",
            description: "Strict A2A v1.0 spec-conforming server",
            version: "1.0.0",
            capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
            supportedInterfaces: [
              { protocolBinding: "HTTP+JSON", protocolVersion: "1.0", url: "https://untrusted.example/rest" },
              { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: `${baseUrl}/` },
            ],
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [{ id: "echo", name: "Echo" }],
          });
        }
        res.writeHead(404);
        return res.end("not found");
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }

      // §9.1 Content-Type must be application/json
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        return sendJson(res, 415, {
          jsonrpc: "2.0",
          id: null,
          error: { code: A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED, message: "ContentTypeNotSupportedError" },
        });
      }

      const body = JSON.parse(await readBody(req));
      seen.push({ method: "POST", path: url.pathname, a2aVersion, rpcMethod: body.method, body });

      // §9.3 strict JSON-RPC 2.0 envelope
      if (body.jsonrpc !== "2.0" || body.id === undefined || body.id === null) {
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32600, message: "Invalid Request" },
        });
      }

      // §5.4 error code probes (evaluated before version gate so auto-mode non-retry is exercised directly)
      const prompt = body.params?.message?.parts?.[0]?.text ?? "";
      const errorMatch = /^error:(-3200[1-8])$/.exec(prompt);
      if (errorMatch) {
        const code = Number(errorMatch[1]);
        const status = code === -32001 ? 404 : code === -32006 ? 500 : 400;
        return sendJson(res, status, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code, message: `Spec error ${code}` },
        });
      }

      // §3.6.2 Agents MUST interpret empty A2A-Version header as 0.3, and reject unsupported versions with -32009
      const effectiveVersion = a2aVersion?.trim() || "0.3";
      if (effectiveVersion !== "1.0") {
        if (prompt === "sse-initial-32009") {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          res.write(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED, message: "VersionNotSupportedError" },
            })}\n\n`,
          );
          return res.end();
        }
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
            message: `VersionNotSupportedError: version ${effectiveVersion} is not supported; require 1.0`,
          },
        });
      }

      if (body.method === "SendMessage") {
        const msg = body.params?.message;
        const msgErr = validateV1Message(msg);
        if (msgErr) {
          return sendJson(res, 400, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: msgErr } });
        }

        if (prompt === "return-message") {
          return sendJson(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              message: {
                messageId: `srv-msg-${++seq}`,
                role: "ROLE_AGENT",
                contextId: msg.contextId ?? `ctx-${seq}`,
                parts: [{ text: "spec-v1-message-reply" }],
              },
            },
          });
        }

        if (prompt === "ask-input") {
          const id = `spec-task-${++seq}`;
          const task = {
            id,
            contextId: msg.contextId ?? `spec-ctx-${seq}`,
            status: {
              state: "TASK_STATE_INPUT_REQUIRED",
              message: { role: "ROLE_AGENT", parts: [{ text: "Provide target region" }] },
            },
            artifacts: [],
          };
          tasks.set(id, task);
          return sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { task } });
        }

        if (msg.taskId && tasks.has(msg.taskId)) {
          const task = tasks.get(msg.taskId);
          task.status = { state: "TASK_STATE_COMPLETED" };
          task.artifacts = [{ artifactId: "out", parts: [{ text: `resumed:${prompt}` }] }];
          return sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { task } });
        }

        const id = `spec-task-${++seq}`;
        const task = {
          id,
          contextId: msg.contextId ?? `spec-ctx-${seq}`,
          status: { state: prompt === "stay-working" ? "TASK_STATE_WORKING" : "TASK_STATE_COMPLETED" },
          artifacts: prompt === "stay-working" ? [] : [{ artifactId: "a1", parts: [{ text: `ok:${prompt}` }] }],
        };
        tasks.set(id, task);
        return sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { task } });
      }

      if (body.method === "SendStreamingMessage") {
        const msg = body.params?.message;
        const msgErr = validateV1Message(msg);
        if (msgErr) {
          return sendJson(res, 400, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: msgErr } });
        }
        const accept = String(req.headers.accept ?? "").toLowerCase();
        if (!accept.includes("text/event-stream")) {
          return sendJson(res, 406, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED, message: "Must accept text/event-stream" },
          });
        }
        const id = `spec-stream-${++seq}`;
        const ctx = msg.contextId ?? `spec-sctx-${seq}`;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        const writeFrame = (result) => res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);

        if (prompt === "stream-single-message") {
          writeFrame({
            message: {
              messageId: `srv-smsg-${seq}`,
              role: "ROLE_AGENT",
              contextId: ctx,
              parts: [{ text: "stream-direct-message" }],
            },
          });
          return res.end();
        }

        // §3.1.2: Task lifecycle stream MUST begin with the initial Task object
        writeFrame({
          task: {
            id,
            contextId: ctx,
            status: { state: "TASK_STATE_WORKING" },
            artifacts: [],
          },
        });
        writeFrame({
          statusUpdate: {
            taskId: id,
            contextId: ctx,
            status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", parts: [{ text: "running" }] } },
            final: false,
          },
        });
        writeFrame({
          artifactUpdate: {
            taskId: id,
            contextId: ctx,
            artifact: { artifactId: "out", parts: [{ text: "stream-" }] },
            append: false,
          },
        });
        writeFrame({
          artifactUpdate: {
            taskId: id,
            contextId: ctx,
            artifact: { artifactId: "out", parts: [{ text: prompt }] },
            append: true,
            lastChunk: true,
          },
        });
        writeFrame({
          statusUpdate: {
            taskId: id,
            contextId: ctx,
            status: { state: "TASK_STATE_COMPLETED" },
            final: true,
          },
        });
        return res.end();
      }

      if (body.method === "GetTask") {
        const task = tasks.get(body.params?.id);
        if (!task) {
          return sendJson(res, 404, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: A2A_ERROR_CODES.TASK_NOT_FOUND, message: "TaskNotFoundError" },
          });
        }
        return sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: task });
      }

      if (body.method === "CancelTask") {
        const task = tasks.get(body.params?.id);
        if (!task) {
          return sendJson(res, 404, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: A2A_ERROR_CODES.TASK_NOT_FOUND, message: "TaskNotFoundError" },
          });
        }
        if (task.status.state === "TASK_STATE_COMPLETED") {
          return sendJson(res, 400, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: A2A_ERROR_CODES.TASK_NOT_CANCELABLE, message: "TaskNotCancelableError" },
          });
        }
        task.status = { state: "TASK_STATE_CANCELED" };
        return sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: task });
      }

      return sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method}` },
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("§3.6 & §9.2: sends authoritative A2A-Version: 1.0 on all v1.0 RPC methods and overrides conflicting caller headers", async () => {
    seen.length = 0;

    // Even when caller passes a conflicting mixed-case or empty A2A-Version header, wire version wins
    const sent = await sendMessage({
      baseUrl,
      protocol: "1.0",
      headers: { "A2A-Version": "0.3" },
      message: "hello",
    });
    assert.equal(sent.state, "completed");
    assert.equal(sent.text, "ok:hello");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, "1.0");
    assert.equal(seen[0].rpcMethod, "SendMessage");

    seen.length = 0;
    const streamed = await sendMessage({
      baseUrl,
      protocol: "1.0",
      headers: { "a2a-version": "" },
      message: "sse",
      stream: true,
    });
    assert.equal(streamed.state, "completed");
    assert.equal(streamed.text, "stream-sse");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, "1.0");
    assert.equal(seen[0].rpcMethod, "SendStreamingMessage");

    // Single-Message stream per §3.1.2
    const directStreamMsg = await sendMessage({
      baseUrl,
      protocol: "1.0",
      message: "stream-single-message",
      stream: true,
    });
    assert.equal(directStreamMsg.state, "completed");
    assert.equal(directStreamMsg.text, "stream-direct-message");

    // Strict 0.3 strips any conflicting caller A2A-Version header so v0.3 stays omitted
    seen.length = 0;
    await assert.rejects(
      () => sendMessage({ baseUrl, protocol: "0.3", headers: { "A2A-Version": "1.0" }, message: "v03-strip" }),
      (err) => err instanceof A2AError && err.code === A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, undefined);

    const working = await sendMessage({ baseUrl, protocol: "1.0", message: "stay-working" });
    assert.equal(working.state, "working");

    seen.length = 0;
    const fetched = await getTask({ baseUrl, protocol: "1.0", taskId: working.taskId, historyLength: 5 });
    assert.equal(fetched.state, "working");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, "1.0");
    assert.equal(seen[0].rpcMethod, "GetTask");
    assert.equal(seen[0].body.params.historyLength, 5);

    seen.length = 0;
    const canceled = await cancelTask({ baseUrl, protocol: "1.0", taskId: working.taskId });
    assert.equal(canceled.state, "canceled");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, "1.0");
    assert.equal(seen[0].rpcMethod, "CancelTask");
  });

  it("§3.6.2: auto mode upgrades from -32009 VersionNotSupportedError (JSON and initial SSE) to A2A-Version: 1.0, while strict 0.3 does not", async () => {
    seen.length = 0;
    const res = await sendMessage({ baseUrl, headers: { "A2A-Version": "9.9" }, message: "auto-ver" });
    assert.equal(res.state, "completed");
    assert.equal(res.text, "ok:auto-ver");
    assert.deepEqual(
      seen.map((r) => [r.a2aVersion ?? "(omitted)", r.rpcMethod]),
      [
        ["(omitted)", "message/send"],
        ["1.0", "SendMessage"],
      ],
    );

    // Streaming auto upgrade from HTTP JSON -32009
    seen.length = 0;
    const sres = await sendMessage({ baseUrl, message: "auto-sse", stream: true });
    assert.equal(sres.state, "completed");
    assert.equal(sres.text, "stream-auto-sse");
    assert.deepEqual(
      seen.map((r) => [r.a2aVersion ?? "(omitted)", r.rpcMethod]),
      [
        ["(omitted)", "message/stream"],
        ["1.0", "SendStreamingMessage"],
      ],
    );

    // Streaming auto upgrade from initial SSE -32009 frame (before any accepted event)
    seen.length = 0;
    const initSse = await sendMessage({ baseUrl, message: "sse-initial-32009", stream: true });
    assert.equal(initSse.state, "completed");
    assert.equal(initSse.text, "stream-sse-initial-32009");
    assert.deepEqual(
      seen.map((r) => [r.a2aVersion ?? "(omitted)", r.rpcMethod]),
      [
        ["(omitted)", "message/stream"],
        ["1.0", "SendStreamingMessage"],
      ],
    );

    // getTask & cancelTask auto upgrade on -32009
    const working = await sendMessage({ baseUrl, protocol: "1.0", message: "stay-working" });
    seen.length = 0;
    const got = await getTask({ baseUrl, taskId: working.taskId });
    assert.equal(got.state, "working");
    assert.deepEqual(
      seen.map((r) => [r.a2aVersion ?? "(omitted)", r.rpcMethod]),
      [
        ["(omitted)", "tasks/get"],
        ["1.0", "GetTask"],
      ],
    );

    seen.length = 0;
    const can = await cancelTask({ baseUrl, taskId: working.taskId });
    assert.equal(can.state, "canceled");
    assert.deepEqual(
      seen.map((r) => [r.a2aVersion ?? "(omitted)", r.rpcMethod]),
      [
        ["(omitted)", "tasks/cancel"],
        ["1.0", "CancelTask"],
      ],
    );

    // Strict protocol "0.3" refuses to upgrade on -32009
    seen.length = 0;
    await assert.rejects(
      () => sendMessage({ baseUrl, protocol: "0.3", message: "strict" }),
      (err) => err instanceof A2AError && err.code === A2A_ERROR_CODES.VERSION_NOT_SUPPORTED && err.status === 400,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, undefined);
  });

  it("§4.4 & §9.4: selects JSONRPC supportedInterface, unwraps sync message/task unions, and continues input-required tasks", async () => {
    const card = await getAgentCard({ baseUrl, protocol: "1.0" });
    assert.equal(card.name, "StrictSpecV1Agent");
    assert.equal(card.protocolVersion, "1.0");
    assert.equal(card.url, `${baseUrl}/`);

    const disc = await discoverAgents({ baseUrl, protocol: "1.0" });
    assert.equal(disc.agents.length, 1);
    assert.equal(disc.agents[0].name, "StrictSpecV1Agent");

    const directMsg = await sendMessage({ baseUrl, protocol: "1.0", message: "return-message" });
    assert.equal(directMsg.state, "completed");
    assert.equal(directMsg.text, "spec-v1-message-reply");

    const ask = await sendMessage({ baseUrl, protocol: "1.0", message: "ask-input" });
    assert.equal(ask.state, "input-required");
    assert.equal(ask.text, "Provide target region");

    const resumed = await sendMessage({
      baseUrl,
      protocol: "1.0",
      taskId: ask.taskId,
      contextId: ask.contextId,
      message: "us-west1",
    });
    assert.equal(resumed.state, "completed");
    assert.equal(resumed.text, "resumed:us-west1");
  });

  it("§4.1.3 & §5.4: maps TaskState enums, enforces auto-mode non-retry on -32001..-32008 and -32009 boundaries, and preserves same-state final status text", async () => {
    const statePairs = [
      ["TASK_STATE_SUBMITTED", "submitted"],
      ["TASK_STATE_WORKING", "working"],
      ["TASK_STATE_INPUT_REQUIRED", "input-required"],
      ["TASK_STATE_COMPLETED", "completed"],
      ["TASK_STATE_CANCELED", "canceled"],
      ["TASK_STATE_FAILED", "failed"],
      ["TASK_STATE_REJECTED", "rejected"],
      ["TASK_STATE_AUTH_REQUIRED", "auth-required"],
      ["TASK_STATE_UNSPECIFIED", "unknown"],
    ];
    for (const [wire, canonical] of statePairs) {
      assert.equal(normalizeTaskState(wire), canonical);
    }

    assert.deepEqual(A2A_ERROR_CODES, {
      TASK_NOT_FOUND: -32001,
      TASK_NOT_CANCELABLE: -32002,
      PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
      UNSUPPORTED_OPERATION: -32004,
      CONTENT_TYPE_NOT_SUPPORTED: -32005,
      INVALID_AGENT_RESPONSE: -32006,
      EXTENDED_AGENT_CARD_NOT_CONFIGURED: -32007,
      EXTENSION_SUPPORT_REQUIRED: -32008,
      VERSION_NOT_SUPPORTED: -32009,
    });

    // None of -32001..-32008 trigger retries even in auto mode
    for (const code of [-32001, -32002, -32003, -32004, -32005, -32006, -32007, -32008]) {
      seen.length = 0;
      await assert.rejects(
        () => sendMessage({ baseUrl, message: `error:${code}` }),
        (err) => err instanceof A2AError && err.code === code,
      );
      assert.equal(seen.length, 1, `auto mode must not retry error ${code}`);
    }

    // Canceling a completed task surfaces -32002 TaskNotCancelableError
    const done = await sendMessage({ baseUrl, protocol: "1.0", message: "done-task" });
    await assert.rejects(
      () => cancelTask({ baseUrl, protocol: "1.0", taskId: done.taskId }),
      (err) => err instanceof A2AError && err.code === A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
    );

    // Same-state textless final:true update preserves prior input-required question (status-only, no artifacts/history)
    const preservedQuestion = await sendMessage({
      baseUrl: "https://safe.example",
      protocol: "0.3",
      message: "hi",
      stream: true,
      fetchImpl: async () =>
        new Response(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: { kind: "task", id: "t-iq", status: { state: "working" } },
          })}\n\n` +
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: "1",
              result: {
                kind: "status-update",
                taskId: "t-iq",
                status: {
                  state: "input-required",
                  message: { role: "agent", parts: [{ kind: "text", text: "Which region?" }] },
                },
                final: false,
              },
            })}\n\n` +
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: "1",
              result: {
                kind: "status-update",
                taskId: "t-iq",
                status: { state: "input-required" },
                final: true,
              },
            })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    assert.equal(preservedQuestion.state, "input-required");
    assert.equal(preservedQuestion.text, "Which region?");

    // State transition working("running") -> completed(no message, final:true) clears stale progress text
    const clearedProgress = await sendMessage({
      baseUrl: "https://safe.example",
      protocol: "1.0",
      message: "hi",
      stream: true,
      fetchImpl: async () =>
        new Response(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: {
              statusUpdate: {
                taskId: "t-cl",
                status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", parts: [{ text: "running" }] } },
              },
            },
          })}\n\n` +
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: "1",
              result: {
                statusUpdate: {
                  taskId: "t-cl",
                  status: { state: "TASK_STATE_COMPLETED" },
                  final: true,
                },
              },
            })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    assert.equal(clearedProgress.state, "completed");
    assert.equal(clearedProgress.text, "");

    // Remote mid-stream -32009 after an accepted event never retries
    let midStreamFetches = 0;
    await assert.rejects(
      () =>
        sendMessage({
          baseUrl: "https://safe.example",
          message: "hi",
          stream: true,
          fetchImpl: async () => {
            midStreamFetches += 1;
            const body =
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: "1",
                result: { kind: "status-update", taskId: "t1", status: { state: "working" }, final: false },
              })}\n\n` +
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: "1",
                error: { code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED, message: "late version error" },
              })}\n\n`;
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
          },
        }),
      (err) => err instanceof A2AError && err.code === A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
    );
    assert.equal(midStreamFetches, 1);

    // Observer throwing A2AError(-32009) after an accepted stream event never retries
    let observerFetches = 0;
    await assert.rejects(
      () =>
        sendMessage({
          baseUrl: "https://safe.example",
          message: "hi",
          stream: true,
          fetchImpl: async () => {
            observerFetches += 1;
            const frame = `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: "1",
              result: { kind: "status-update", taskId: "t1", status: { state: "working" }, final: false },
            })}\n\n`;
            return new Response(frame, { status: 200, headers: { "content-type": "text/event-stream" } });
          },
          onEvent: () => {
            throw new A2AError("observer version error", { code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED });
          },
        }),
      (err) => err instanceof A2AError && err.message === "observer version error",
    );
    assert.equal(observerFetches, 1);

    // Aborted signal or exhausted timeout deadline blocks -32009 auto fallback
    const abortCtrl = new AbortController();
    let abortedFetches = 0;
    await assert.rejects(
      () =>
        sendMessage({
          baseUrl: "https://safe.example",
          message: "hi",
          signal: abortCtrl.signal,
          fetchImpl: async () => {
            abortedFetches += 1;
            abortCtrl.abort();
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "1",
                error: { code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED, message: "VersionNotSupportedError" },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          },
        }),
      (err) => err instanceof A2AError && err.code === A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
    );
    assert.equal(abortedFetches, 1);

    let expiredFetches = 0;
    await assert.rejects(
      () =>
        sendMessage({
          baseUrl: "https://safe.example",
          message: "hi",
          timeoutMs: 20,
          // Mock intentionally ignores abort signal to return -32009 after deadline exhaustion
          fetchImpl: async () => {
            expiredFetches += 1;
            await new Promise((r) => setTimeout(r, 35));
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "1",
                error: { code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED, message: "VersionNotSupportedError" },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          },
        }),
      (err) => err instanceof A2AError && /timed out/.test(err.message),
    );
    assert.equal(expiredFetches, 1);
  });
});
