/**
 * Pi extension: tools for talking to A2A-compatible agents.
 *
 * Registers five tools:
 * - a2a_agents  — discover Agent Cards
 * - a2a_send    — start a conversation (message/send or message/stream)
 * - a2a_status  — tasks/get
 * - a2a_reply   — continue an `input-required` task (message/send with taskId)
 * - a2a_cancel  — tasks/cancel
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

import { cancelTask, discoverAgents, getTask, sendMessage, A2AError } from "./client.mjs";
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
    return { baseUrl, agent, headers, fetchImpl: options.fetchImpl };
  }

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
