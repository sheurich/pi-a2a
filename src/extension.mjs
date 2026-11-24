/**
 * Pi extension: tools for talking to A2A-compatible agents.
 *
 * Registers eleven tools (plus a `/a2a` command when the host supports it):
 * - a2a_gateways — list configured named A2A gateways (without exposing helper commands/secrets)
 * - a2a_agents   — discover Agent Cards
 * - a2a_card     — fetch one agent's card (`agent` routes to /a2a/<agent>)
 * - a2a_send     — start a conversation (message/send or message/stream)
 * - a2a_status   — tasks/get
 * - a2a_reply    — continue an `input-required` task (message/send with taskId)
 * - a2a_cancel   — tasks/cancel
 * - a2a_get_task / a2a_cancel_task — tasks/get and tasks/cancel
 * - a2a_send_file / a2a_get_file   — POST/GET /files/{task_id}/{name}
 *
 * Configuration comes from the environment and optional user-level config file:
 * - PI_A2A_CONFIG          optional path to JSON gateway config (defaults to
 *                          $PI_CODING_AGENT_DIR/a2a.json or $HOME/.pi/agent/a2a.json)
 * - PI_A2A_GATEWAY         optional default named gateway from config
 * - PI_A2A_URL             legacy default HTTPS base URL of a single A2A gateway
 * - PI_A2A_HEADERS_HELPER  optional command producing `authorization` /
 *                          `x-goog-iap-jwt-assertion` headers (JSON object or
 *                          `Header: value` lines on stdout)
 * - PI_A2A_AGENT           optional default agent name for legacy single-gateway mode
 * - PI_A2A_PROTOCOL        optional wire protocol (`auto`, `0.3`, or `1.0`) for legacy mode
 * - PI_A2A_TIMEOUT_MS      optional default request timeout in milliseconds (1–3600000)
 *
 * Header values and helper commands are never accepted from tool parameters, so
 * the model cannot inject credentials or run arbitrary helper commands.
 */

import { dirname } from "node:path";

import {
  DEFAULT_STREAM_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  cancelTask,
  discoverAgents,
  getAgentCard,
  getFile,
  getTask,
  normalizeProtocol,
  normalizeTimeoutMs,
  sendFile,
  sendMessage,
  A2AError,
} from "./client.mjs";
import {
  ENV_CONFIG,
  ENV_GATEWAY,
  GATEWAY_NAME_PATTERN,
  MAX_CONFIG_BYTES,
  loadGatewayConfig,
  normalizeGatewayUrl,
  validateGatewayConfig,
  validateGatewayName,
} from "./gateways.mjs";
import { resolveHeaders } from "./headers-helper.mjs";

export const ENV_URL = "PI_A2A_URL";
export const ENV_HEADERS_HELPER = "PI_A2A_HEADERS_HELPER";
export const ENV_AGENT = "PI_A2A_AGENT";
export const ENV_PROTOCOL = "PI_A2A_PROTOCOL";
export const ENV_TIMEOUT_MS = "PI_A2A_TIMEOUT_MS";
export { ENV_CONFIG, ENV_GATEWAY, GATEWAY_NAME_PATTERN, MAX_CONFIG_BYTES, loadGatewayConfig, validateGatewayConfig };

/**
 * @typedef {import("./gateways.mjs").GatewayInput} GatewayInput
 * @typedef {import("./gateways.mjs").ResolvedGateway} ResolvedGateway
 * @typedef {import("./gateways.mjs").LoadedGatewayConfig} LoadedGatewayConfig
 */

/**
 * @typedef {{
 *   baseUrl?: string;
 *   headersHelper?: string | string[];
 *   agent?: string;
 *   protocol?: "auto" | "0.3" | "1.0";
 *   timeoutMs?: number;
 *   gateway?: string;
 *   gateways?: Record<string, GatewayInput>;
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
    protocol: trim(env[ENV_PROTOCOL]),
    timeoutMs: trim(env[ENV_TIMEOUT_MS]),
    configPath: trim(env[ENV_CONFIG]),
    gateway: trim(env[ENV_GATEWAY]),
  };
}

const gatewayProperty = {
  type: "string",
  description: `Named A2A gateway from a2a.json (or ${ENV_CONFIG}). Call a2a_gateways to list available gateways.`,
};
const urlProperty = {
  type: "string",
  description: `A2A gateway base URL (https://…). Defaults to ${ENV_URL}; omit when targeting a named gateway.`,
};
const agentProperty = {
  type: "string",
  description: `Agent name under /a2a/{agent}. Omit to use the gateway's default agent, ${ENV_AGENT}, or the root agent.`,
};
const fileNameProperty = {
  type: "string",
  description: "Single-segment file name (letters, digits, '.', '_', '-'); no slashes or '..'.",
};
const taskIdProperty = { type: "string", description: "Task id returned by a2a_send / a2a_reply." };
const contextIdProperty = { type: "string", description: "Optional contextId to keep related tasks together." };
const streamProperty = {
  type: "boolean",
  description: "Use streaming (message/stream or SendStreamingMessage over SSE) instead of a blocking request. Default false.",
};
const timeoutMsProperty = {
  type: "integer",
  minimum: 1,
  maximum: MAX_TIMEOUT_MS,
  description: `Optional request timeout in milliseconds (1–${MAX_TIMEOUT_MS}). Overrides ${ENV_TIMEOUT_MS} and the default (${DEFAULT_TIMEOUT_MS} ms blocking, ${DEFAULT_STREAM_TIMEOUT_MS} ms streaming).`,
};

/**
 * Formats a normalized task result for the model.
 *
 * @param {{ taskId?: string; contextId?: string; state: string; text: string; error?: string }} result
 * @param {string} heading
 * @param {string} [gateway]
 */
export function formatResult(result, heading, gateway) {
  const lines = [heading];
  lines.push(`state: ${result.state}`);
  if (gateway) lines.push(`gateway: ${gateway}`);
  if (result.taskId) lines.push(`taskId: ${result.taskId}`);
  if (result.contextId) lines.push(`contextId: ${result.contextId}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.state === "input-required") {
    lines.push(
      gateway
        ? `The agent needs more input. Continue with a2a_reply using this taskId and gateway="${gateway}".`
        : "The agent needs more input. Continue with a2a_reply using this taskId.",
    );
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
 * @param {{ agent?: string; name: string; description?: string; version?: string; protocolVersion?: string; streaming: boolean; cardUrl: string; skills: Array<{ id?: string; name?: string; description?: string }> }} summary
 * @param {string} [gateway]
 */
export function formatCard(summary, gateway) {
  const lines = [`A2A agent card: ${summary.agent ? `${summary.agent} — ` : ""}${summary.name}${summary.version ? ` v${summary.version}` : ""}`];
  if (gateway) lines.push(`gateway: ${gateway}`);
  if (summary.protocolVersion) lines.push(`protocolVersion: ${summary.protocolVersion}`);
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
 * @param {string} [gateway]
 */
export function formatAgents(discovery, gateway) {
  const lines = [`A2A agents at ${discovery.baseUrl}`];
  if (gateway) lines.push(`gateway: ${gateway}`);
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
 * Formats configured gateway inventory without revealing helper commands or credentials.
 *
 * @param {{
 *   activeDefault: { kind: "named"; name: string } | { kind: "legacy" } | { kind: "none" };
 *   gateways: Array<{ name: string; url: string; agent?: string; protocol?: "auto" | "0.3" | "1.0"; description?: string; auth: "configured" | "none"; isDefault: boolean }>;
 *   legacy?: { url: string; agent?: string; protocol?: "auto" | "0.3" | "1.0"; auth: "configured" | "none"; isDefault: boolean };
 * }} summary
 */
export function formatGateways(summary) {
  const lines = [];
  if (summary.gateways.length === 0) {
    lines.push("No named A2A gateways configured.");
  } else {
    lines.push("Configured A2A gateways:");
    for (const gw of summary.gateways) {
      const meta = [];
      if (gw.agent) meta.push(`agent: ${gw.agent}`);
      if (gw.protocol) meta.push(`protocol: ${gw.protocol}`);
      meta.push(`auth: ${gw.auth}`);
      const suffix = gw.description ? ` — ${gw.description}` : "";
      lines.push(`- ${gw.name}${gw.isDefault ? " (default)" : ""}: ${gw.url} (${meta.join(", ")})${suffix}`);
    }
  }
  if (summary.legacy) {
    const meta = [];
    if (summary.legacy.agent) meta.push(`agent: ${summary.legacy.agent}`);
    if (summary.legacy.protocol) meta.push(`protocol: ${summary.legacy.protocol}`);
    meta.push(`auth: ${summary.legacy.auth}`);
    lines.push(
      `Legacy single-gateway (${ENV_URL})${summary.legacy.isDefault ? " (default)" : ""}: ${summary.legacy.url} (${meta.join(", ")})`,
    );
  }
  return lines.join("\n");
}

/**
 * Sanitizes a legacy URL for display in `a2a_gateways` (strips userinfo, query, and fragment).
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function sanitizeDisplayUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * Parses `/a2a` slash command arguments.
 *
 * Supported forms:
 * - `/a2a gateways`
 * - `/a2a [-g <gw> | --gateway <gw>] [@agent] <message>`
 * - `/a2a [-g <gw> | --gateway <gw>] card [@agent]`
 * - `/a2a card [-g <gw> | --gateway <gw>] [@agent]`
 *
 * @param {string | undefined} args
 * @returns {{ kind: "gateways" } | { kind: "card"; gateway?: string; agent?: string } | { kind: "send"; gateway?: string; agent?: string; message: string } | { kind: "error"; message: string }}
 */
export function parseSlashArgs(args) {
  let rest = (args ?? "").trim();
  if (rest === "gateways") {
    return { kind: "gateways" };
  }

  /** @type {string | undefined} */
  let gateway;

  const consumeGateway = () => {
    const match = /^(?:-g|--gateway)(?:\s+(\S+))?(?:\s+|$)/.exec(rest);
    if (!match) return { consumed: false };
    const value = match[1];
    if (!value) {
      return { error: "Usage: /a2a [-g <gateway>] [@agent] <message> | /a2a card [-g <gateway>] [@agent] | /a2a gateways" };
    }
    if (!GATEWAY_NAME_PATTERN.test(value)) {
      return { error: `Invalid gateway name "${value}": must be 1-63 lowercase letters, digits, or '-'` };
    }
    gateway = value;
    rest = rest.slice(match[0].length).trim();
    return { consumed: true };
  };

  const firstGw = consumeGateway();
  if (firstGw.error) return { kind: "error", message: firstGw.error };

  let wantsCard = false;
  if (/^card(?:\s|$)/.test(rest)) {
    wantsCard = true;
    rest = rest.slice(4).trim();
  }

  if (wantsCard && !gateway) {
    const secondGw = consumeGateway();
    if (secondGw.error) return { kind: "error", message: secondGw.error };
  }

  /** @type {string | undefined} */
  let agent;
  const agentMatch = /^@(\S+)(?:\s+|$)/.exec(rest);
  if (agentMatch) {
    agent = agentMatch[1];
    rest = rest.slice(agentMatch[0].length).trim();
  }

  if (wantsCard) {
    return { kind: "card", gateway, agent };
  }
  if (!rest) {
    return {
      kind: "error",
      message: "Usage: /a2a [-g <gateway>] [@agent] <message> | /a2a card [-g <gateway>] [@agent] | /a2a gateways",
    };
  }
  return { kind: "send", gateway, agent, message: rest };
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
 * @param {{ registerTool: (tool: Record<string, unknown>) => void; registerCommand?: (name: string, cmd: Record<string, unknown>) => void }} pi
 * @param {PiA2aOptions} [options]  Overrides, mainly for tests.
 */
export default function registerPiA2aExtension(pi, options = {}) {
  const env = options.env ?? process.env;

  /**
   * Resolves a named gateway connection with strict URL binding and isolated credentials.
   *
   * @param {string} name
   * @param {LoadedGatewayConfig} loaded
   * @param {string | undefined} requestedUrl
   * @param {string | undefined} requestedAgent
   */
  async function buildNamedConnection(name, loaded, requestedUrl, requestedAgent) {
    validateGatewayName(name, "gateway");
    const entry = Object.hasOwn(loaded.gateways, name) ? loaded.gateways[name] : undefined;
    if (!entry) {
      const available = Object.keys(loaded.gateways).sort();
      throw new A2AError(
        `Unknown A2A gateway "${name}". ${available.length > 0 ? `Configured gateways: ${available.join(", ")}.` : "No named gateways are configured."}`,
      );
    }
    if (requestedUrl) {
      let normalized;
      try {
        normalized = normalizeGatewayUrl(requestedUrl, "url parameter");
      } catch {
        throw new A2AError(
          `Refusing to override named gateway "${name}" URL; omit url or target another gateway.`,
        );
      }
      if (normalized.url !== entry.url) {
        throw new A2AError(
          `Refusing to override named gateway "${name}" URL; omit url or target another gateway.`,
        );
      }
    }
    const helper = Array.isArray(entry.headersHelper) ? [...entry.headersHelper] : entry.headersHelper;
    const helperCwd = loaded.configPath ? dirname(loaded.configPath) : (env.HOME?.trim() || undefined);
    const headers = helper ? await resolveHeaders({ headersHelper: helper, env, cwd: helperCwd }) : {};
    const agent = requestedAgent || entry.agent;
    return {
      gateway: name,
      baseUrl: entry.url,
      agent,
      protocol: entry.protocol,
      headers,
      pinnedOrigin: entry.origin,
      fetchImpl: options.fetchImpl,
    };
  }

  /**
   * Resolves a legacy single-gateway connection (`options.baseUrl` or `PI_A2A_URL`).
   *
   * @param {string} configuredUrl
   * @param {string | string[] | undefined} headersHelper
   * @param {string | undefined} defaultAgent
   * @param {"auto" | "0.3" | "1.0" | undefined} protocol
   * @param {string | undefined} requestedUrl
   * @param {string | undefined} requestedAgent
   */
  async function buildLegacyConnection(configuredUrl, headersHelper, defaultAgent, protocol, requestedUrl, requestedAgent) {
    const baseUrl = requestedUrl || configuredUrl;
    if (headersHelper && requestedUrl) {
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
    const agent = requestedAgent || defaultAgent;
    const headers = headersHelper ? await resolveHeaders({ headersHelper, env }) : {};
    const pinnedOrigin = headersHelper ? configuredUrl : undefined;
    return {
      gateway: undefined,
      baseUrl,
      agent,
      protocol,
      headers,
      pinnedOrigin,
      fetchImpl: options.fetchImpl,
    };
  }

  /**
   * Resolves per-call connection settings. Header values only come from configured helpers.
   *
   * Precedence:
   * 1. params.gateway
   * 2. options.gateway
   * 3. options.baseUrl
   * 4. env.PI_A2A_GATEWAY
   * 5. env.PI_A2A_URL
   * 6. configFile.defaultGateway
   * 7. params.url (only if no legacy headersHelper is configured)
   * 8. error
   *
   * @param {{ gateway?: string; url?: string; agent?: string }} params
   */
  async function connection(params) {
    const config = readConfig(env);
    const requestedGateway = params.gateway?.trim() || undefined;
    const requestedUrl = params.url?.trim() || undefined;
    const requestedAgent = params.agent?.trim() || undefined;
    const optionsGateway = options.gateway?.trim() || undefined;
    const optionsBaseUrl = options.baseUrl?.trim() || undefined;
    const legacyHelper = options.headersHelper ?? config.headersHelper;
    const legacyAgent = options.agent || config.agent;

    if (requestedGateway) {
      const loaded = loadGatewayConfig(env, options);
      return buildNamedConnection(requestedGateway, loaded, requestedUrl, requestedAgent);
    }

    if (optionsGateway) {
      const loaded = loadGatewayConfig(env, options);
      return buildNamedConnection(optionsGateway, loaded, requestedUrl, requestedAgent);
    }

    if (optionsBaseUrl) {
      const legacyProtocol = normalizeProtocol(options.protocol ?? config.protocol, ENV_PROTOCOL);
      return buildLegacyConnection(optionsBaseUrl, legacyHelper, legacyAgent, legacyProtocol, requestedUrl, requestedAgent);
    }

    if (config.gateway) {
      const loaded = loadGatewayConfig(env, options);
      return buildNamedConnection(config.gateway, loaded, requestedUrl, requestedAgent);
    }

    if (config.baseUrl) {
      const legacyProtocol = normalizeProtocol(options.protocol ?? config.protocol, ENV_PROTOCOL);
      return buildLegacyConnection(config.baseUrl, legacyHelper, legacyAgent, legacyProtocol, requestedUrl, requestedAgent);
    }

    const loaded = loadGatewayConfig(env, options);
    if (loaded.defaultGateway) {
      return buildNamedConnection(loaded.defaultGateway, loaded, requestedUrl, requestedAgent);
    }

    if (requestedUrl) {
      if (legacyHelper) {
        throw new A2AError(
          `Refusing to send ${ENV_HEADERS_HELPER} credentials to a tool-supplied url when ${ENV_URL} is not configured.`,
        );
      }
      const legacyProtocol = normalizeProtocol(options.protocol ?? config.protocol, ENV_PROTOCOL);
      return {
        gateway: undefined,
        baseUrl: requestedUrl,
        agent: requestedAgent || legacyAgent,
        protocol: legacyProtocol,
        headers: {},
        pinnedOrigin: undefined,
        fetchImpl: options.fetchImpl,
      };
    }

    const available = Object.keys(loaded.gateways).sort();
    if (available.length > 0) {
      throw new A2AError(
        `No default A2A gateway configured. Pass gateway (configured: ${available.join(", ")}), set ${ENV_GATEWAY}, or set defaultGateway in your config.`,
      );
    }
    throw new A2AError(`No A2A URL configured. Set ${ENV_URL}, configure ${ENV_CONFIG}, or pass the url parameter.`);
  }

  /**
   * Builds the sanitized gateway inventory for `a2a_gateways` and `/a2a gateways`.
   */
  function listGatewaysSummary() {
    const config = readConfig(env);
    const loaded = loadGatewayConfig(env, options);
    const optionsGateway = options.gateway?.trim() || undefined;
    const optionsBaseUrl = options.baseUrl?.trim() || undefined;
    const legacyUrl = optionsBaseUrl || config.baseUrl;
    const legacyHelper = options.headersHelper ?? config.headersHelper;
    const legacyAgent = options.agent || config.agent;
    const legacyProtocol = legacyUrl
      ? normalizeProtocol(options.protocol ?? config.protocol, ENV_PROTOCOL)
      : undefined;

    /** @type {{ kind: "named"; name: string } | { kind: "legacy" } | { kind: "none" }} */
    let activeDefault = { kind: "none" };
    if (optionsGateway) {
      activeDefault = { kind: "named", name: optionsGateway };
    } else if (optionsBaseUrl) {
      activeDefault = { kind: "legacy" };
    } else if (config.gateway) {
      activeDefault = { kind: "named", name: config.gateway };
    } else if (config.baseUrl) {
      activeDefault = { kind: "legacy" };
    } else if (loaded.defaultGateway) {
      activeDefault = { kind: "named", name: loaded.defaultGateway };
    }

    const gateways = Object.keys(loaded.gateways)
      .sort()
      .map((name) => {
        const entry = loaded.gateways[name];
        return {
          name,
          url: entry.url,
          ...(entry.agent ? { agent: entry.agent } : {}),
          ...(entry.protocol ? { protocol: entry.protocol } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          auth: /** @type {"configured" | "none"} */ (entry.headersHelper ? "configured" : "none"),
          isDefault: activeDefault.kind === "named" && activeDefault.name === name,
        };
      });

    const legacy = legacyUrl
      ? {
          url: sanitizeDisplayUrl(legacyUrl),
          ...(legacyAgent ? { agent: legacyAgent } : {}),
          ...(legacyProtocol ? { protocol: legacyProtocol } : {}),
          auth: /** @type {"configured" | "none"} */ (legacyHelper ? "configured" : "none"),
          isDefault: activeDefault.kind === "legacy",
        }
      : undefined;

    return { activeDefault, gateways, ...(legacy ? { legacy } : {}) };
  }

  /**
   * Resolves the effective request timeout: tool `timeout_ms` → programmatic `options.timeoutMs` → `PI_A2A_TIMEOUT_MS` → `undefined` (client default).
   *
   * @param {unknown} paramTimeoutMs
   * @returns {number | undefined}
   */
  function resolveTimeoutMs(paramTimeoutMs) {
    if (paramTimeoutMs !== undefined) {
      return normalizeTimeoutMs(/** @type {number | string} */ (paramTimeoutMs), undefined);
    }
    if (options.timeoutMs !== undefined) {
      return normalizeTimeoutMs(options.timeoutMs, undefined);
    }
    const envTimeout = readConfig(env).timeoutMs;
    if (envTimeout !== undefined) {
      return normalizeTimeoutMs(envTimeout, undefined);
    }
    return undefined;
  }

  /**
   * Handles `/a2a` slash commands.
   *
   * @param {string | undefined} args
   * @param {{ ui?: { notify?: (message: string, level?: string) => void } }} [ctx]
   */
  async function runSlashCommand(args, ctx) {
    const notify = (/** @type {string} */ message, level = "info") => ctx?.ui?.notify?.(message, level);
    const parsed = parseSlashArgs(args);
    if (parsed.kind === "error") {
      notify(parsed.message, "error");
      return;
    }
    const result = await guard(async () => {
      if (parsed.kind === "gateways") {
        const summary = listGatewaysSummary();
        return { text: formatGateways(summary), details: summary };
      }
      const conn = await connection({ gateway: parsed.gateway, agent: parsed.agent });
      if (parsed.kind === "card") {
        const summary = await getAgentCard({ ...conn });
        return { text: formatCard(summary, conn.gateway), details: { ...(conn.gateway ? { gateway: conn.gateway } : {}), ...summary } };
      }
      const sent = await sendMessage({ ...conn, message: parsed.message, timeoutMs: resolveTimeoutMs(undefined) });
      return { text: formatResult(sent, "A2A message sent", conn.gateway), details: { ...(conn.gateway ? { gateway: conn.gateway } : {}), ...sent } };
    });
    notify(result.content[0].text, result.isError ? "error" : "info");
  }

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("a2a", {
      description: "Send a message to an A2A agent: /a2a [-g <gw>] [@agent] <message>, /a2a card [-g <gw>] [@agent], or /a2a gateways",
      handler: runSlashCommand,
    });
  }

  pi.registerTool({
    name: "a2a_gateways",
    label: "A2A Gateways",
    description:
      "List configured named A2A gateways (names, URLs, default agents, protocols, descriptions, and whether auth is configured). Does not expose credentials or helper commands.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return guard(async () => {
        const summary = listGatewaysSummary();
        return { text: formatGateways(summary), details: summary };
      });
    },
  });

  pi.registerTool({
    name: "a2a_card",
    label: "A2A Card",
    description:
      "Fetch one A2A agent's Agent Card (/.well-known/agent.json or /.well-known/agent-card.json, under /a2a/{agent} when an agent is given).",
    parameters: {
      type: "object",
      properties: { gateway: gatewayProperty, agent: agentProperty, url: urlProperty },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params ?? {});
        const summary = await getAgentCard({ ...conn, signal });
        const { card, ...rest } = summary;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatCard(summary, conn.gateway), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_get_task",
    label: "A2A Get Task",
    description: "Get the current state, text, and artifacts of an A2A task (tasks/get or GetTask).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, gateway: gatewayProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await getTask(conn.baseUrl, { ...conn, taskId: params.task_id, signal });
        const { raw, ...rest } = result;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatResult(result, "A2A task", conn.gateway), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_cancel_task",
    label: "A2A Cancel Task",
    description: "Cancel a running A2A task (tasks/cancel or CancelTask).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, gateway: gatewayProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await cancelTask(conn.baseUrl, { ...conn, taskId: params.task_id, signal });
        const { raw, ...rest } = result;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatResult(result, "A2A task cancel requested", conn.gateway), details };
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
        gateway: gatewayProperty,
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
        const details = {
          ...(conn.gateway ? { gateway: conn.gateway } : {}),
          taskId: result.taskId,
          name: result.name,
          size: result.size,
          status: result.status,
        };
        return {
          text: `A2A file staged: ${result.name} (${result.size} bytes) for task ${result.taskId}${conn.gateway ? ` (gateway: ${conn.gateway})` : ""}`,
          details,
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
      properties: { task_id: taskIdProperty, name: fileNameProperty, gateway: gatewayProperty, url: urlProperty },
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
        const encoding = isText ? "utf8" : "base64";
        const details = {
          ...(conn.gateway ? { gateway: conn.gateway } : {}),
          taskId: file.taskId,
          name: file.name,
          size: file.size,
          contentType: file.contentType,
          encoding,
        };
        return {
          text: `A2A file ${file.name} (${file.size} bytes, ${file.contentType}, ${encoding}${conn.gateway ? `, gateway: ${conn.gateway}` : ""})\n\n${body}`,
          details,
        };
      });
    },
  });

  pi.registerTool({
    name: "a2a_agents",
    label: "A2A Agents",
    description:
      "Discover A2A agents: fetches Agent Cards from /.well-known/agent.json or /.well-known/agent-card.json and the /a2a directory, or a single agent's card when `agent` is given.",
    parameters: {
      type: "object",
      properties: { gateway: gatewayProperty, url: urlProperty, agent: agentProperty },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params ?? {});
        const discovery = await discoverAgents({ ...conn, signal });
        const rest = { baseUrl: discovery.baseUrl, agents: discovery.agents.map(({ card, ...item }) => item), errors: discovery.errors };
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return {
          text: formatAgents(discovery, conn.gateway),
          details,
        };
      });
    },
  });

  pi.registerTool({
    name: "a2a_send",
    label: "A2A Send",
    description:
      "Send a message to an A2A agent (JSON-RPC message/send or SendMessage, or streaming when stream=true). Returns the task id, state, and reply text. If state is input-required, continue with a2a_reply.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to send to the agent." },
        gateway: gatewayProperty,
        agent: agentProperty,
        url: urlProperty,
        context_id: contextIdProperty,
        stream: streamProperty,
        timeout_ms: timeoutMsProperty,
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
          timeoutMs: resolveTimeoutMs(params.timeout_ms),
          signal,
          onEvent: (event) => {
            if (!onUpdate) return;
            const progress = event.text ? event.text : `${event.kind}${event.state ? ` (${event.state})` : ""}`;
            onUpdate({ content: [{ type: "text", text: progress }], details: { kind: event.kind, state: event.state } });
          },
        });
        const { raw, events, ...rest } = result;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatResult(result, "A2A message sent", conn.gateway), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_status",
    label: "A2A Status",
    description: "Get the current state, text, and artifacts of an A2A task (tasks/get or GetTask).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, gateway: gatewayProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await getTask({ ...conn, taskId: params.task_id, signal });
        const { raw, ...rest } = result;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatResult(result, "A2A task status", conn.gateway), details };
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
        gateway: gatewayProperty,
        agent: agentProperty,
        url: urlProperty,
        context_id: contextIdProperty,
        stream: streamProperty,
        timeout_ms: timeoutMsProperty,
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
          timeoutMs: resolveTimeoutMs(params.timeout_ms),
          signal,
          onEvent: (event) => {
            if (!onUpdate) return;
            const progress = event.text ? event.text : `${event.kind}${event.state ? ` (${event.state})` : ""}`;
            onUpdate({ content: [{ type: "text", text: progress }], details: { kind: event.kind, state: event.state } });
          },
        });
        const { raw, events, ...rest } = result;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatResult(result, "A2A reply sent", conn.gateway), details };
      });
    },
  });

  pi.registerTool({
    name: "a2a_cancel",
    label: "A2A Cancel",
    description: "Cancel a running A2A task (tasks/cancel or CancelTask).",
    parameters: {
      type: "object",
      properties: { task_id: taskIdProperty, gateway: gatewayProperty, agent: agentProperty, url: urlProperty },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      return guard(async () => {
        const conn = await connection(params);
        const result = await cancelTask({ ...conn, taskId: params.task_id, signal });
        const { raw, ...rest } = result;
        const details = conn.gateway ? { gateway: conn.gateway, ...rest } : rest;
        return { text: formatResult(result, "A2A task cancel requested", conn.gateway), details };
      });
    },
  });
}

export { registerPiA2aExtension };
