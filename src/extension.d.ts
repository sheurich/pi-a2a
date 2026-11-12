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

export interface PiA2aOptions {
  /** Overrides PI_A2A_URL. */
  baseUrl?: string;
  /** Overrides PI_A2A_HEADERS_HELPER. */
  headersHelper?: string;
  /** Overrides PI_A2A_AGENT. */
  agent?: string;
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

export function readConfig(env?: NodeJS.ProcessEnv): {
  baseUrl: string | undefined;
  headersHelper: string | undefined;
  agent: string | undefined;
};

export function formatResult(result: NormalizedTaskResult, heading: string): string;

/**
 * Registers a2a_agents, a2a_card, a2a_send, a2a_status, a2a_reply, a2a_cancel,
 * a2a_get_task, a2a_cancel_task, a2a_send_file, and a2a_get_file, plus the `/a2a` command
 * when the host provides `registerCommand`.
 */
export default function registerPiA2aExtension(pi: PiLikeExtensionApi, options?: PiA2aOptions): void;
export { registerPiA2aExtension };
