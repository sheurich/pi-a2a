/**
 * Pi extension: tools for talking to A2A-compatible agents.
 *
 * Registers these tools (plus a `/a2a [@agent] <message>` command when the host supports it):
 * - a2a_agents  — discover Agent Cards
 * - a2a_card    — fetch one agent's card (`agent` routes to /a2a/<agent>)
 * - a2a_send    — start a conversation (message/send or message/stream)
 * - a2a_status  — tasks/get
 * - a2a_reply   — continue an `input-required` task (message/send with taskId)
 * - a2a_cancel  — tasks/cancel
 * - a2a_get_task / a2a_cancel_task — tasks/get and tasks/cancel (B.1 names)
 * - a2a_send_file / a2a_get_file   — POST/GET /files/{task_id}/{name}
 *
 * Configuration comes from the environment:
 * - PI_A2A_URL             default HTTPS base URL of the A2A gateway
 * - PI_A2A_HEADERS_HELPER  optional command producing `authorization` /
 *                          `x-goog-iap-jwt-assertion` headers (JSON object or
 *                          `Header: value` lines on stdout)
 * - PI_A2A_AGENT           optional default agent name
 *
 * Header values are never accepted from tool parameters, so the model cannot
 * inject credentials or run arbitrary helper commands.
 */

import { cancelTask, discoverAgents, getAgentCard, getFile, getTask, sendFile, sendMessage, A2AError } from "./client.mjs";
import { resolveHeaders } from "./headers-helper.mjs";

export const ENV_URL = "PI_A2A_URL";
export const ENV_HEADERS_HELPER = "PI_A2A_HEADERS_HELPER";
export const ENV_AGENT = "PI_A2A_AGENT";

/**
 * @typedef {{
 *   baseUrl?: string;
 *   headersHelper?: string;
 *   agent?: string;
 *   env?: NodeJS.ProcessEnv;
 *   fetchImpl?: typeof fetch;
 * }} PiA2aOptions
 */

/**
 * Reads the extension configuration from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readConfig(env = process.env) {
  const trim = (/** @type {string | undefined} */ value) => (value && value.trim() ? value.trim() : undefined);
  return {
    baseUrl: trim(env[ENV_URL]),
    headersHelper: trim(env[ENV_HEADERS_HELPER]),
    agent: trim(env[ENV_AGENT]),
  };
}

const urlProperty = {
  type: "string",
  description: `A2A gateway base URL (https://…). Defaults to ${ENV_URL}.`,
};
const agentProperty = {
  type: "string",
  description: `Agent name under /a2a/{agent}. Omit to use ${ENV_AGENT} or the root agent.`,
};
const fileNameProperty = {
  type: "string",
  description: "Single-segment file name (letters, digits, '.', '_', '-'); no slashes or '..'.",
};
const taskIdProperty = { type: "string", description: "Task id returned by a2a_send / a2a_reply." };
const contextIdProperty = { type: "string", description: "Optional contextId to keep related tasks together." };
const streamProperty = {
  type: "boolean",
  description: "Use message/stream (Server-Sent Events) instead of message/send. Default false.",
};

/**
 * Formats a normalized task result for the model.
 *
 * @param {{ taskId?: string; contextId?: string; state: string; text: string; error?: string }} result
 * @param {string} heading
 */
export function formatResult(result, heading) {
  const lines = [heading];
  lines.push(`state: ${result.state}`);
  if (result.taskId) lines.push(`taskId: ${result.taskId}`);
  if (result.contextId) lines.push(`contextId: ${result.contextId}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.state === "input-required") {
    lines.push("The agent needs more input. Continue with a2a_reply using this taskId.");
  } else if (result.state === "reply_withheld") {
    lines.push("The agent withheld its reply (policy or safety filter). Do not retry with the same content.");
  }
  if (result.text) {
    lines.push("", result.text);
  }
  return lines.join("\n");
}

/**
 * Formats a single Agent Card summary for the model.
 *
 * @param {{ agent?: string; name: string; description?: string; version?: string; streaming: boolean; cardUrl: string; skills: Array<{ id?: string; name?: string; description?: string }> }} summary
 */
export function formatCard(summary) {
  const lines = [`A2A agent card: ${summary.agent ? `${summary.agent} — ` : ""}${summary.name}${summary.version ? ` v${summary.version}` : ""}`];
  lines.push(`streaming: ${summary.streaming}`);
  if (summary.description) lines.push(summary.description);
  for (const skill of summary.skills.slice(0, 50)) {
    lines.push(`• ${skill.name ?? skill.id}${skill.description ? `: ${skill.description}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Formats discovery output for the model.
 *
 * @param {Awaited<ReturnType<typeof discoverAgents>>} discovery
 */
export function formatAgents(discovery) {
  const lines = [`A2A agents at ${discovery.baseUrl}`];
  for (const agent of discovery.agents) {
    const label = agent.agent ? `${agent.agent} — ${agent.name}` : `${agent.name} (root)`;
    lines.push(`- ${label}${agent.version ? ` v${agent.version}` : ""}${agent.streaming ? " [streaming]" : ""}`);
    if (agent.description) lines.push(`  ${agent.description}`);
    for (const skill of agent.skills.slice(0, 20)) {
      lines.push(`  • ${skill.name ?? skill.id}${skill.description ? `: ${skill.description}` : ""}`);
    }
  }
  if (discovery.errors.length) {
    lines.push("", `warnings: ${discovery.errors.join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Wraps a tool body with uniform error handling.
 *
 * @template T
 * @param {() => Promise<{ text: string; details: T }>} run
 * @returns {Promise<{ content: Array<{ type: "text"; text: string }>; details: T | { error: string }; isError?: boolean }>}
 */
async function guard(run) {
  try {
    const { text, details } = await run();
    return { content: [{ type: "text", text }], details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefix = err instanceof A2AError ? "A2A error" : "Error";
    return { content: [{ type: "text", text: `${prefix}: ${message}` }], details: { error: message }, isError: true };
  }
}

/**
 * Registers the A2A tools on a Pi ExtensionAPI.
 *
 * @param {{ registerTool: (tool: Record<string, unknown>) => void }} pi
 * @param {PiA2aOptions} [options]  Overrides, mainly for tests.
 */
export default function registerPiA2aExtension(pi, options = {}) {
  const env = options.env ?? process.env;

  /**
   * Resolves per-call connection settings. Header values only come from the configured helper.
   *
   * @param {{ url?: string; agent?: string }} params
   */
  async function connection(params) {
    const config = readConfig(env);
    const configuredUrl = options.baseUrl || config.baseUrl;
    const requestedUrl = params.url?.trim();
    const baseUrl = requestedUrl || configuredUrl;
    if (!baseUrl) {
      throw new A2AError(`No A2A URL configured. Set ${ENV_URL} or pass the url parameter.`);
    }
    const headersHelper = options.headersHelper ?? config.headersHelper;
    if (headersHelper && requestedUrl) {
      if (!configuredUrl) {
        throw new A2AError(
          `Refusing to send ${ENV_HEADERS_HELPER} credentials to a tool-supplied url when ${ENV_URL} is not configured.`,
        );
      }
      let configuredOrigin;
      let requestedOrigin;
      try {
        configuredOrigin = new URL(configuredUrl).origin;
        requestedOrigin = new URL(requestedUrl).origin;
      } catch {
        throw new A2AError("Invalid A2A gateway URL.");
      }
      if (requestedOrigin !== configuredOrigin) {
        throw new A2AError(
          `Refusing to send configured credentials to cross-origin URL ${requestedOrigin} (pinned origin: ${configuredOrigin}).`,
        );
      }
    }
    const agent = params.agent?.trim() || options.agent || config.agent;
    const headers = headersHelper ? await resolveHeaders({ headersHelper, env }) : {};
    // Defense in depth: the client re-checks that the target origin equals the configured one
    // whenever credentials are attached.
    const pinnedOrigin = headersHelper && configuredUrl ? configuredUrl : undefined;
    return { baseUrl, agent, headers, pinnedOrigin, fetchImpl: options.fetchImpl };
  }

  /**
   * Handles `/a2a [@agent] <message>` and `/a2a card [@agent]`.
   *
   * @param {string | undefined} args
   * @param {{ ui?: { notify?: (message: string, level?: string) => void } }} [ctx]
   */
  async function runSlashCommand(args, ctx) {
    const notify = (/** @type {string} */ message, level = "info") => ctx?.ui?.notify?.(message, level);
    let rest = (args ?? "").trim();
    let wantsCard = false;
    if (/^card(\s|$)/.test(rest)) {
      wantsCard = true;
      rest = rest.slice(4).trim();
    }
    let agent;
    const match = /^@(\S+)\s*/.exec(rest);
    if (match) {
      agent = match[1];
      rest = rest.slice(match[0].length).trim();
    }
    if (!wantsCard && !rest) {
      notify("Usage: /a2a [@agent] <message> | /a2a card [@agent]", "error");
      return;
    }
    const result = await guard(async () => {
      const conn = await connection({ agent });
      if (wantsCard) {
        const summary = await getAgentCard({ ...conn });
        return { text: formatCard(summary), details: summary };
      }
      const sent = await sendMessage({ ...conn, message: rest });
      return { text: formatResult(sent, "A2A message sent"), details: sent };
    });
    notify(result.content[0].text, result.isError ? "error" : "info");
  }

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("a2a", {
      description: "Send a message to an A2A agent: /a2a [@agent] <message>, or /a2a card [@agent]",
      handler: runSlashCommand,
    });
  }

  pi.registerTool({
    name: "a2a_card",
    label: "A2A Card",
    description:
      "Fetch one A2A agent's Agent Card (/a2a/{agent}/.well-known/agent.json, or the root card when no agent is given).",
    parameters: {
      type: "object",
      properties: { agent: agentProperty, url: urlProperty },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params ?? {});
        const summary = await getAgentCard({ ...conn, signal });
        const { card, ...details } = summary;
        return { text: formatCard(summary), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_get_task",
    label: "A2A Get Task",
    description: "Get the current state, text, and artifacts of an A2A task (tasks/get).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await getTask(conn.baseUrl, { ...conn, taskId: params.task_id, signal });
        const { raw, ...details } = result;
        return { text: formatResult(result, "A2A task"), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_cancel_task",
    label: "A2A Cancel Task",
    description: "Cancel a running A2A task (tasks/cancel).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await cancelTask(conn.baseUrl, { ...conn, taskId: params.task_id, signal });
        const { raw, ...details } = result;
        return { text: formatResult(result, "A2A task cancel requested"), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_send_file",
    label: "A2A Send File",
    description:
      "Stage a file for an A2A task (POST /files/{task_id}/{name}). `name` must be a single file name without slashes. Content is UTF-8 text unless encoding is base64.",
    parameters: {
      type: "object",
      properties: {
        task_id: taskIdProperty,
        name: fileNameProperty,
        content: { type: "string", description: "File content (UTF-8 text, or base64 when encoding=base64)." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "Content encoding. Default utf8." },
        content_type: { type: "string", description: "Optional MIME type. Default application/octet-stream." },
        url: urlProperty,
      },
      required: ["task_id", "name", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        if (params.encoding !== undefined && params.encoding !== "utf8" && params.encoding !== "base64") {
          throw new A2AError("encoding must be utf8 or base64");
        }
        let content;
        if (params.encoding === "base64") {
          const stripped = String(params.content).replace(/[\r\n\t ]+/g, "");
          if (stripped.length % 4 !== 0) {
            throw new A2AError("invalid base64 content");
          }
          const decoded = Buffer.from(stripped, "base64");
          if (decoded.toString("base64") !== stripped) {
            throw new A2AError("invalid base64 content");
          }
          content = decoded;
        } else {
          content = String(params.content);
        }
        const result = await sendFile(conn.baseUrl, {
          ...conn,
          taskId: params.task_id,
          name: params.name,
          content,
          contentType: params.content_type,
          signal,
        });
        return {
          text: `A2A file staged: ${result.name} (${result.size} bytes) for task ${result.taskId}`,
          details: { taskId: result.taskId, name: result.name, size: result.size, status: result.status },
        };
      });
    },
  });

  pi.registerTool({
    name: "a2a_get_file",
    label: "A2A Get File",
    description: "Download a staged task file (GET /files/{task_id}/{name}). Text is returned inline; binary files are returned as base64.",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, name: fileNameProperty, url: urlProperty },
      required: ["task_id", "name"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const file = await getFile(conn.baseUrl, { ...conn, taskId: params.task_id, name: params.name, signal });
        let isText = false;
        let body = "";
        if (!file.content.includes(0)) {
          try {
            body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content);
            isText = true;
          } catch {
            isText = false;
          }
        }
        if (!isText) {
          body = file.content.toString("base64");
        }
        return {
          text: `A2A file ${file.name} (${file.size} bytes, ${file.contentType}, ${isText ? "utf8" : "base64"})\n\n${body}`,
          details: { taskId: file.taskId, name: file.name, size: file.size, contentType: file.contentType, encoding: isText ? "utf8" : "base64" },
        };
      });
    },
  });

  pi.registerTool({
    name: "a2a_agents",
    label: "A2A Agents",
    description:
      "Discover A2A agents: fetches Agent Cards from /.well-known/agent.json and the /a2a directory, or a single agent's card when `agent` is given.",
    parameters: {
      type: "object",
      properties: { url: urlProperty, agent: agentProperty },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params ?? {});
        const discovery = await discoverAgents({ ...conn, signal });
        return {
          text: formatAgents(discovery),
          details: { baseUrl: discovery.baseUrl, agents: discovery.agents.map(({ card, ...rest }) => rest), errors: discovery.errors },
        };
      });
    },
  });

  pi.registerTool({
    name: "a2a_send",
    label: "A2A Send",
    description:
      "Send a message to an A2A agent (JSON-RPC message/send, or message/stream when stream=true). Returns the task id, state, and reply text. If state is input-required, continue with a2a_reply.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to send to the agent." },
        agent: agentProperty,
        url: urlProperty,
        context_id: contextIdProperty,
        stream: streamProperty,
      },
      required: ["message"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await sendMessage({
          ...conn,
          message: params.message,
          contextId: params.context_id,
          stream: Boolean(params.stream),
          signal,
          onEvent: (event) => {
            if (!onUpdate) return;
            const progress = event.text ? event.text : `${event.kind}${event.state ? ` (${event.state})` : ""}`;
            onUpdate({ content: [{ type: "text", text: progress }], details: { kind: event.kind, state: event.state } });
          },
        });
        const { raw, events, ...details } = result;
        return { text: formatResult(result, "A2A message sent"), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_status",
    label: "A2A Status",
    description: "Get the current state, text, and artifacts of an A2A task (tasks/get).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await getTask({ ...conn, taskId: params.task_id, signal });
        const { raw, ...details } = result;
        return { text: formatResult(result, "A2A task status"), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_reply",
    label: "A2A Reply",
    description:
      "Continue an A2A task that is in the input-required state by sending another user message with the same task id.",
    parameters: {
      type: "object",
      properties: {
        task_id: taskIdProperty,
        message: { type: "string", description: "Reply text for the waiting agent." },
        agent: agentProperty,
        url: urlProperty,
        context_id: contextIdProperty,
        stream: streamProperty,
      },
      required: ["task_id", "message"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await sendMessage({
          ...conn,
          message: params.message,
          taskId: params.task_id,
          contextId: params.context_id,
          stream: Boolean(params.stream),
          signal,
          onEvent: (event) => {
            if (!onUpdate) return;
            const progress = event.text ? event.text : `${event.kind}${event.state ? ` (${event.state})` : ""}`;
            onUpdate({ content: [{ type: "text", text: progress }], details: { kind: event.kind, state: event.state } });
          },
        });
        const { raw, events, ...details } = result;
        return { text: formatResult(result, "A2A reply sent"), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_cancel",
    label: "A2A Cancel",
    description: "Cancel a running A2A task (tasks/cancel).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await cancelTask({ ...conn, taskId: params.task_id, signal });
        const { raw, ...details } = result;
        return { text: formatResult(result, "A2A task cancel requested"), details };
      });
    },
  });
}

export { registerPiA2aExtension };
