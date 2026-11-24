/**
 * A2A v1.0 Specification Conformance Test Suite for @sheurich/pi-a2a.
 *
 * Pinned against upstream specification commit:
 *   a2aproject/A2A @ 5f931b8a25fe66789f987ec4a55fc16ee9fe41ee (docs/specification.md)
 *
 * Enforces normative client MUST requirements on a strict spec-conforming server:
 * - §3.6.1 / §3.6.2 / §9.2: `A2A-Version: 1.0` HTTP header on v1.0 requests;
 *   omitted header interpreted as `0.3` and rejected with `-32009 VersionNotSupportedError` (HTTP 400).
 * - §4.1.3 / §4.1.5: All nine canonical `TASK_STATE_*` enums and `ROLE_USER` / `ROLE_AGENT`.
 * - §4.4.1 / §4.4.6: `/.well-known/agent-card.json` discovery, `supportedInterfaces` JSONRPC selection,
 *   and refusal to follow untrusted card URLs across origins.
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

      // §3.6.2 Agents MUST interpret empty A2A-Version header as 0.3, and reject unsupported versions with -32009
      const effectiveVersion = a2aVersion?.trim() || "0.3";
      if (effectiveVersion !== "1.0") {
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
            message: `VersionNotSupportedError: version ${effectiveVersion} is not supported; require 1.0`,
          },
        });
      }

      // §5.4 error code probes
      const prompt = body.params?.message?.parts?.[0]?.text ?? "";
      const errorMatch = /^error:(-3200[1-9])$/.exec(prompt);
      if (errorMatch) {
        const code = Number(errorMatch[1]);
        const status = code === -32001 ? 404 : code === -32006 ? 500 : 400;
        return sendJson(res, status, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code, message: `Spec error ${code}` },
        });
      }

      if (body.method === "SendMessage") {
        const msg = body.params?.message;
        // Strict v1.0 message checks: no kind, role === ROLE_USER, text parts without kind/type
        if (!msg || "kind" in msg || msg.role !== "ROLE_USER" || typeof msg.messageId !== "string" || !msg.messageId) {
          return sendJson(res, 400, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Invalid v1.0 Message envelope" },
          });
        }
        const part = msg.parts?.[0];
        if (!part || "kind" in part || "type" in part || typeof part.text !== "string") {
          return sendJson(res, 400, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Invalid v1.0 Part encoding" },
          });
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
        const accept = String(req.headers.accept ?? "").toLowerCase();
        if (!accept.includes("text/event-stream")) {
          return sendJson(res, 406, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED, message: "Must accept text/event-stream" },
          });
        }
        const id = `spec-stream-${++seq}`;
        const ctx = body.params?.message?.contextId ?? `spec-sctx-${seq}`;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        const writeFrame = (result) => res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);

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

  it("§3.6 & §9.2: sends A2A-Version: 1.0 on all v1.0 RPC methods (SendMessage, SendStreamingMessage, GetTask, CancelTask)", async () => {
    seen.length = 0;

    const sent = await sendMessage({ baseUrl, protocol: "1.0", message: "hello" });
    assert.equal(sent.state, "completed");
    assert.equal(sent.text, "ok:hello");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, "1.0");
    assert.equal(seen[0].rpcMethod, "SendMessage");

    seen.length = 0;
    const streamed = await sendMessage({ baseUrl, protocol: "1.0", message: "sse", stream: true });
    assert.equal(streamed.state, "completed");
    assert.equal(streamed.text, "stream-sse");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].a2aVersion, "1.0");
    assert.equal(seen[0].rpcMethod, "SendStreamingMessage");

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

  it("§3.6.2: auto mode upgrades from omitted-header -32009 VersionNotSupportedError to A2A-Version: 1.0 across all RPC operations, while strict 0.3 does not", async () => {
    // sendMessage auto upgrade on -32009
    seen.length = 0;
    const res = await sendMessage({ baseUrl, message: "auto-ver" });
    assert.equal(res.state, "completed");
    assert.equal(res.text, "ok:auto-ver");
    assert.deepEqual(
      seen.map((r) => [r.a2aVersion ?? "(omitted)", r.rpcMethod]),
      [
        ["(omitted)", "message/send"],
        ["1.0", "SendMessage"],
      ],
    );

    // sendMessage streaming auto upgrade on -32009
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

  it("§4.4 & §9.4: discovers JSONRPC supportedInterface, unwraps sync message/task unions, and continues input-required tasks", async () => {
    const card = await getAgentCard({ baseUrl, protocol: "1.0" });
    assert.equal(card.name, "StrictSpecV1Agent");
    assert.equal(card.protocolVersion, "1.0");
    // Prefers JSONRPC binding over HTTP+JSON untrusted interface
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

  it("§4.1.3 & §5.4: maps all canonical TaskState enums and preserves all A2A error codes (-32001..-32009) without unintended retries", async () => {
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

    // Verify canonical error code constants match §5.4 verbatim
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

    // None of -32001..-32008 trigger retries in protocol "1.0"
    for (const code of [-32001, -32002, -32003, -32004, -32005, -32006, -32007, -32008]) {
      seen.length = 0;
      await assert.rejects(
        () => sendMessage({ baseUrl, protocol: "1.0", message: `error:${code}` }),
        (err) => err instanceof A2AError && err.code === code,
      );
      assert.equal(seen.length, 1, `error ${code} must not retry`);
    }

    // Canceling a completed task surfaces -32002 TaskNotCancelableError
    const done = await sendMessage({ baseUrl, protocol: "1.0", message: "done-task" });
    await assert.rejects(
      () => cancelTask({ baseUrl, protocol: "1.0", taskId: done.taskId }),
      (err) => err instanceof A2AError && err.code === A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
    );

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
  });
});
