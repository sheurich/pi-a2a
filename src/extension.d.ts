/**
 * Type declarations for @sheurich/pi-a2a.
 */

export interface A2aToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}

export interface A2aRegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: A2aToolResult) => void,
    ctx?: unknown,
  ): Promise<A2aToolResult>;
}

/** Minimal structural view of Pi's ExtensionAPI used by this extension. */
export interface PiLikeExtensionApi {
  registerTool(tool: A2aRegisteredTool): void;
  registerCommand?(
    name: string,
    command: {
      description?: string;
      handler(args: string | undefined, ctx?: { ui?: { notify?(message: string, level?: string): void } }): Promise<void>;
    },
  ): void;
}

export interface GatewayInput {
  url: string;
  headersHelper?: string | string[];
  agent?: string;
  description?: string;
}

export interface ResolvedGateway {
  readonly name: string;
  readonly url: string;
  readonly origin: string;
  readonly headersHelper: string | readonly string[] | undefined;
  readonly agent: string | undefined;
  readonly description: string | undefined;
}

export interface LoadedGatewayConfig {
  readonly source: "options" | "env" | "default-file" | "none";
  readonly configPath: string | undefined;
  readonly defaultGateway: string | undefined;
  readonly gateways: Readonly<Record<string, ResolvedGateway>>;
}

export interface GatewayInventoryEntry {
  name: string;
  url: string;
  agent?: string;
  description?: string;
  auth: "configured" | "none";
  isDefault: boolean;
}

export interface GatewayInventorySummary {
  activeDefault: { kind: "named"; name: string } | { kind: "legacy" } | { kind: "none" };
  gateways: GatewayInventoryEntry[];
  legacy?: {
    url: string;
    agent?: string;
    auth: "configured" | "none";
    isDefault: boolean;
  };
}

export interface PiA2aOptions {
  /** Overrides PI_A2A_URL. */
  baseUrl?: string;
  /** Overrides PI_A2A_HEADERS_HELPER. */
  headersHelper?: string | string[];
  /** Overrides PI_A2A_AGENT. */
  agent?: string;
  /** Default named gateway to target when `gateway` is omitted. */
  gateway?: string;
  /** Programmatic named gateway registry (replaces config file loading). */
  gateways?: Record<string, GatewayInput>;
  /** Environment to read configuration from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Custom fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

export interface NormalizedTaskResult {
  taskId: string | undefined;
  contextId: string | undefined;
  state: string;
  text: string;
  raw: unknown;
  error?: string;
  events?: unknown[];
}

export const ENV_URL: "PI_A2A_URL";
export const ENV_HEADERS_HELPER: "PI_A2A_HEADERS_HELPER";
export const ENV_AGENT: "PI_A2A_AGENT";
export const ENV_CONFIG: "PI_A2A_CONFIG";
export const ENV_GATEWAY: "PI_A2A_GATEWAY";
export const GATEWAY_NAME_PATTERN: RegExp;
export const MAX_CONFIG_BYTES: number;

export function readConfig(env?: NodeJS.ProcessEnv): {
  baseUrl: string | undefined;
  headersHelper: string | undefined;
  agent: string | undefined;
  configPath: string | undefined;
  gateway: string | undefined;
};

export function loadGatewayConfig(
  env?: NodeJS.ProcessEnv,
  options?: { gateways?: Record<string, GatewayInput> },
): LoadedGatewayConfig;

export function validateGatewayConfig(
  rawConfig: unknown,
  sourceLabel?: string,
): Readonly<{ defaultGateway: string | undefined; gateways: Readonly<Record<string, ResolvedGateway>> }>;

export function formatResult(result: NormalizedTaskResult, heading: string, gateway?: string): string;
export function formatGateways(summary: GatewayInventorySummary): string;
export function parseSlashArgs(args: string | undefined):
  | { kind: "gateways" }
  | { kind: "card"; gateway?: string; agent?: string }
  | { kind: "send"; gateway?: string; agent?: string; message: string }
  | { kind: "error"; message: string };

/**
 * Registers a2a_gateways, a2a_agents, a2a_card, a2a_send, a2a_status, a2a_reply, a2a_cancel,
 * a2a_get_task, a2a_cancel_task, a2a_send_file, and a2a_get_file, plus the `/a2a` command
 * when the host provides `registerCommand`.
 */
export default function registerPiA2aExtension(pi: PiLikeExtensionApi, options?: PiA2aOptions): void;
export { registerPiA2aExtension };
