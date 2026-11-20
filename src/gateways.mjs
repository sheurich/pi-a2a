/**
 * Named A2A gateway registry and fail-closed configuration loader.
 *
 * Security invariants:
 * - Configuration files are loaded only from an explicit `PI_A2A_CONFIG` path
 *   or the user-level Pi agent directory (`$PI_CODING_AGENT_DIR/a2a.json` or
 *   `$HOME/.pi/agent/a2a.json`). Project/working directories are never searched.
 * - File inspection uses open() -> fstat() -> bounded read() on the same file
 *   descriptor to prevent TOCTOU races, caps size at 64 KiB, and on POSIX
 *   rejects non-regular files, files not owned by the current user, and group-
 *   or world-writable files (mode & 0o022).
 * - Secrets (`headers`, `token`, `apiKey`, etc.) are rejected in config files;
 *   authentication must come from `headersHelper` executables.
 * - Relative `headersHelper` executable paths (containing `/` or `\`) are
 *   rejected so helper resolution cannot depend on the active project cwd.
 * - Error messages never echo raw config values or JSON snippets.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { A2AError, AGENT_NAME_PATTERN, assertAllowedBaseUrl } from "./client.mjs";
import { splitCommandTokens } from "./headers-helper.mjs";

export const ENV_CONFIG = "PI_A2A_CONFIG";
export const ENV_GATEWAY = "PI_A2A_GATEWAY";

export const GATEWAY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_GATEWAYS = 64;
export const MAX_DESCRIPTION_CHARS = 256;

const ALLOWED_TOP_LEVEL_KEYS = Object.freeze(new Set(["defaultGateway", "gateways"]));
const ALLOWED_GATEWAY_KEYS = Object.freeze(new Set(["url", "headersHelper", "agent", "description"]));
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/**
 * @typedef {{
 *   url: string;
 *   headersHelper?: string | string[];
 *   agent?: string;
 *   description?: string;
 * }} GatewayInput
 */

/**
 * @typedef {Readonly<{
 *   name: string;
 *   url: string;
 *   origin: string;
 *   headersHelper: string | readonly string[] | undefined;
 *   agent: string | undefined;
 *   description: string | undefined;
 * }>} ResolvedGateway
 */

/**
 * @typedef {Readonly<{
 *   source: "options" | "env" | "default-file" | "none";
 *   configPath: string | undefined;
 *   defaultGateway: string | undefined;
 *   gateways: Readonly<Record<string, ResolvedGateway>>;
 * }>} LoadedGatewayConfig
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates a gateway name against `[a-z0-9][a-z0-9-]{0,62}`.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function validateGatewayName(value, label = "gateway name") {
  if (typeof value !== "string" || !GATEWAY_NAME_PATTERN.test(value)) {
    throw new A2AError(
      `Invalid ${label}: must be 1-63 characters of lowercase letters, digits, or '-' and start with a letter or digit`,
    );
  }
  return value;
}

/**
 * Normalizes and validates a gateway base URL without echoing raw values on error.
 * Rejects query parameters, fragments, embedded credentials, and non-HTTPS non-loopback hosts.
 *
 * @param {unknown} rawUrl
 * @param {string} label
 * @returns {{ url: string; origin: string }}
 */
export function normalizeGatewayUrl(rawUrl, label) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new A2AError(`Missing or empty url for ${label}`);
  }
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new A2AError(`Invalid URL for ${label}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new A2AError(`URL for ${label} must not contain query parameters or a fragment`);
  }
  assertAllowedBaseUrl(parsed);
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return {
    url: `${parsed.origin}${pathname}`,
    origin: parsed.origin,
  };
}

/**
 * Validates a `headersHelper` config value (string or string[]) and rejects relative paths.
 *
 * @param {unknown} rawHelper
 * @param {string} label
 * @returns {string | readonly string[]}
 */
function validateHeadersHelper(rawHelper, label) {
  /** @type {string | string[]} */
  let normalized;
  if (typeof rawHelper === "string") {
    const trimmed = rawHelper.trim();
    if (!trimmed) {
      throw new A2AError(`headersHelper for ${label} must not be empty`);
    }
    normalized = trimmed;
  } else if (Array.isArray(rawHelper)) {
    if (rawHelper.length === 0) {
      throw new A2AError(`headersHelper array for ${label} must not be empty`);
    }
    /** @type {string[]} */
    const parts = [];
    for (const item of rawHelper) {
      if (typeof item !== "string" || item.length === 0) {
        throw new A2AError(`headersHelper array for ${label} must contain only non-empty strings`);
      }
      parts.push(item);
    }
    normalized = parts;
  } else {
    throw new A2AError(`headersHelper for ${label} must be a string or array of non-empty strings`);
  }

  /** @type {string[]} */
  let tokens;
  try {
    tokens = splitCommandTokens(normalized);
  } catch {
    throw new A2AError(`Invalid headersHelper command syntax for ${label}`);
  }

  const executable = tokens[0];
  if ((executable.includes("/") || executable.includes("\\")) && !isAbsolute(executable)) {
    throw new A2AError(
      `headersHelper executable for ${label} must be an absolute path or bare command name (relative paths are not allowed)`,
    );
  }

  return Array.isArray(normalized) ? Object.freeze([...normalized]) : normalized;
}

/**
 * Validates a single gateway entry.
 *
 * @param {string} name
 * @param {unknown} rawEntry
 * @param {string} sourceLabel
 * @returns {ResolvedGateway}
 */
function validateGatewayEntry(name, rawEntry, sourceLabel) {
  validateGatewayName(name, `gateway name in ${sourceLabel}`);
  if (!isPlainObject(rawEntry)) {
    throw new A2AError(`Gateway "${name}" in ${sourceLabel} must be an object`);
  }

  for (const key of Object.getOwnPropertyNames(rawEntry)) {
    if (!ALLOWED_GATEWAY_KEYS.has(key)) {
      throw new A2AError(
        `Unknown key "${key}" in A2A gateway "${name}" (${sourceLabel}). Allowed keys: url, headersHelper, agent, description`,
      );
    }
  }

  const label = `gateway "${name}" (${sourceLabel})`;
  const { url, origin } = normalizeGatewayUrl(rawEntry.url, label);

  /** @type {string | readonly string[] | undefined} */
  let headersHelper;
  if (rawEntry.headersHelper !== undefined) {
    headersHelper = validateHeadersHelper(rawEntry.headersHelper, label);
  }

  /** @type {string | undefined} */
  let agent;
  if (rawEntry.agent !== undefined) {
    if (typeof rawEntry.agent !== "string" || !AGENT_NAME_PATTERN.test(rawEntry.agent.trim())) {
      throw new A2AError(
        `Invalid agent for ${label}: must be 1-63 characters of lowercase letters, digits, or '-' and start with a letter or digit`,
      );
    }
    agent = rawEntry.agent.trim();
  }

  /** @type {string | undefined} */
  let description;
  if (rawEntry.description !== undefined) {
    if (typeof rawEntry.description !== "string") {
      throw new A2AError(`description for ${label} must be a string`);
    }
    if (CONTROL_CHARS_RE.test(rawEntry.description)) {
      throw new A2AError(`description for ${label} must not contain control characters or newlines`);
    }
    const trimmed = rawEntry.description.trim();
    if (trimmed.length > MAX_DESCRIPTION_CHARS) {
      throw new A2AError(`description for ${label} must be at most ${MAX_DESCRIPTION_CHARS} characters`);
    }
    if (trimmed) {
      description = trimmed;
    }
  }

  return Object.freeze({
    name,
    url,
    origin,
    headersHelper,
    agent,
    description,
  });
}

/**
 * Validates a map of named gateways and returns a frozen null-prototype dictionary.
 *
 * @param {unknown} rawGateways
 * @param {string} [sourceLabel]
 * @returns {Readonly<Record<string, ResolvedGateway>>}
 */
export function validateGatewayMap(rawGateways, sourceLabel = "A2A gateways") {
  if (!isPlainObject(rawGateways)) {
    throw new A2AError(`gateways in ${sourceLabel} must be an object`);
  }
  const names = Object.getOwnPropertyNames(rawGateways);
  if (names.length > MAX_GATEWAYS) {
    throw new A2AError(`${sourceLabel} defines too many gateways (max ${MAX_GATEWAYS})`);
  }

  /** @type {Record<string, ResolvedGateway>} */
  const gateways = Object.create(null);
  for (const name of names) {
    gateways[name] = validateGatewayEntry(name, rawGateways[name], sourceLabel);
  }
  return Object.freeze(gateways);
}

/**
 * Validates a full gateway config object (`{ defaultGateway?, gateways }`).
 *
 * @param {unknown} rawConfig
 * @param {string} [sourceLabel]
 * @returns {Readonly<{ defaultGateway: string | undefined; gateways: Readonly<Record<string, ResolvedGateway>> }>}
 */
export function validateGatewayConfig(rawConfig, sourceLabel = "A2A config") {
  if (!isPlainObject(rawConfig)) {
    throw new A2AError(`${sourceLabel} must be a JSON object`);
  }

  for (const key of Object.getOwnPropertyNames(rawConfig)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new A2AError(
        `Unknown top-level key "${key}" in ${sourceLabel}. Allowed keys: defaultGateway, gateways`,
      );
    }
  }

  if (rawConfig.gateways === undefined) {
    throw new A2AError(`${sourceLabel} must include a "gateways" object`);
  }
  const gateways = validateGatewayMap(rawConfig.gateways, sourceLabel);

  /** @type {string | undefined} */
  let defaultGateway;
  if (rawConfig.defaultGateway !== undefined) {
    defaultGateway = validateGatewayName(rawConfig.defaultGateway, `defaultGateway in ${sourceLabel}`);
    if (!Object.hasOwn(gateways, defaultGateway)) {
      throw new A2AError(
        `defaultGateway "${defaultGateway}" in ${sourceLabel} is not defined in gateways`,
      );
    }
  }

  return Object.freeze({ defaultGateway, gateways });
}

/**
 * Resolves the default user-level config file path from `env` without falling back
 * to `os.homedir()` (preserving isolation when tests supply custom `options.env`).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function resolveDefaultConfigPath(env) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    return join(agentDir, "a2a.json");
  }
  const home = env.HOME?.trim();
  if (home) {
    return join(home, ".pi", "agent", "a2a.json");
  }
  return undefined;
}

/**
 * Reads and validates a gateway config file using open -> fstat -> bounded read on
 * a single file descriptor (no TOCTOU race).
 *
 * @param {string} filePath
 * @returns {Readonly<{ defaultGateway: string | undefined; gateways: Readonly<Record<string, ResolvedGateway>> }>}
 */
function readConfigFileStrict(filePath) {
  /** @type {number | undefined} */
  let fd;
  try {
    const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(filePath, openFlags);
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new A2AError(`A2A config path ${filePath} must be a regular file`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      if (stats.uid !== process.getuid()) {
        throw new A2AError(`Refusing to load A2A config ${filePath}: file must be owned by the current user`);
      }
      if ((stats.mode & 0o022) !== 0) {
        throw new A2AError(
          `Refusing to load A2A config ${filePath}: file must not be group- or world-writable`,
        );
      }
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      throw new A2AError(`A2A config file ${filePath} exceeds maximum size of ${MAX_CONFIG_BYTES} bytes`);
    }

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const bytesRead = readSync(fd, buffer, totalRead, buffer.length - totalRead, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      if (totalRead > MAX_CONFIG_BYTES) {
        throw new A2AError(`A2A config file ${filePath} exceeds maximum size of ${MAX_CONFIG_BYTES} bytes`);
      }
    }

    const rawText = buffer.subarray(0, totalRead).toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new A2AError(`Invalid JSON in A2A config file ${filePath}`);
    }
    return validateGatewayConfig(parsed, filePath);
  } catch (err) {
    if (err instanceof A2AError) {
      throw err;
    }
    const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
    throw new A2AError(
      `Failed to read A2A config file ${filePath}${code ? ` (${code})` : ""}`,
      { code },
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Loads named gateway configuration according to strict source precedence:
 * 1. Programmatic `options.gateways` (replaces file loading)
 * 2. Explicit `env.PI_A2A_CONFIG` (must exist and be valid; fail-closed)
 * 3. Default `$PI_CODING_AGENT_DIR/a2a.json` or `$HOME/.pi/agent/a2a.json` (optional if ENOENT; fail-closed if present and invalid)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ gateways?: Record<string, GatewayInput> }} [options]
 * @returns {LoadedGatewayConfig}
 */
export function loadGatewayConfig(env = process.env, options = {}) {
  if (options.gateways !== undefined) {
    const gateways = validateGatewayMap(options.gateways, "options.gateways");
    return Object.freeze({
      source: "options",
      configPath: undefined,
      defaultGateway: undefined,
      gateways,
    });
  }

  const explicitPath = env[ENV_CONFIG]?.trim();
  if (explicitPath) {
    if (!isAbsolute(explicitPath)) {
      throw new A2AError(`${ENV_CONFIG} must be an absolute path`);
    }
    const validated = readConfigFileStrict(explicitPath);
    return Object.freeze({
      source: "env",
      configPath: explicitPath,
      defaultGateway: validated.defaultGateway,
      gateways: validated.gateways,
    });
  }

  const defaultPath = resolveDefaultConfigPath(env);
  if (!defaultPath) {
    return Object.freeze({
      source: "none",
      configPath: undefined,
      defaultGateway: undefined,
      gateways: Object.freeze(Object.create(null)),
    });
  }

  try {
    const validated = readConfigFileStrict(defaultPath);
    return Object.freeze({
      source: "default-file",
      configPath: defaultPath,
      defaultGateway: validated.defaultGateway,
      gateways: validated.gateways,
    });
  } catch (err) {
    if (err instanceof A2AError && err.code === "ENOENT") {
      return Object.freeze({
        source: "none",
        configPath: undefined,
        defaultGateway: undefined,
        gateways: Object.freeze(Object.create(null)),
      });
    }
    throw err;
  }
}
