import { execFile } from "node:child_process";

export const HEADERS_HELPER_TIMEOUT_MS = 10_000;
export const HEADERS_HELPER_MAX_STDOUT_BYTES = 64 * 1024;
export const ALLOWED_HEADER_NAMES = Object.freeze(
  new Set(["authorization", "x-goog-iap-jwt-assertion"]),
);

const CANONICAL_HEADER_NAMES = Object.freeze({
  authorization: "authorization",
  "x-goog-iap-jwt-assertion": "x-goog-iap-jwt-assertion",
});

/**
 * Splits a command string into argv tokens without invoking a shell.
 * Supports single-quoted and double-quoted arguments with backslash escaping.
 *
 * @param {string | string[]} command
 * @returns {string[]}
 */
export function splitCommandTokens(command) {
  if (Array.isArray(command)) {
    const tokens = command.map((part) => String(part)).filter((part) => part.length > 0);
    if (tokens.length === 0) {
      throw new Error("headersHelper command must not be empty");
    }
    return tokens;
  }

  if (typeof command !== "string") {
    throw new Error("headersHelper command must be a string or array of strings");
  }

  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        if (i + 1 >= command.length) {
          throw new Error("headersHelper command has trailing escape in double quotes");
        }
        const next = command[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= command.length) {
        throw new Error("headersHelper command has trailing backslash escape");
      }
      current += command[i + 1];
      inToken = true;
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (quote !== null) {
    throw new Error("headersHelper command has unclosed quote");
  }

  if (inToken) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error("headersHelper command must not be empty");
  }

  return tokens;
}

/**
 * Validates and normalizes headers against the strict allowlist.
 * Never includes header values in thrown error messages.
 *
 * @param {Record<string, unknown>} rawHeaders
 * @returns {Record<string, string>}
 */
export function validateAndNormalizeHeaders(rawHeaders) {
  if (
    rawHeaders === null ||
    typeof rawHeaders !== "object" ||
    Array.isArray(rawHeaders)
  ) {
    throw new Error("headersHelper output must be a JSON object or header lines");
  }

  /** @type {Record<string, string>} */
  const normalized = {};

  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    const trimmedName = String(rawName).trim();
    const lowerName = trimmedName.toLowerCase();

    if (!ALLOWED_HEADER_NAMES.has(lowerName)) {
      throw new Error(
        `Disallowed header name "${trimmedName}". Allowed headers: authorization, x-goog-iap-jwt-assertion`,
      );
    }

    if (typeof rawValue !== "string") {
      throw new Error(`Invalid non-string value for header "${lowerName}" (redacted)`);
    }

    if (/[\r\n\0]/.test(rawValue)) {
      throw new Error(
        `Invalid control characters in value for header "${lowerName}" (redacted)`,
      );
    }

    const trimmedValue = rawValue.trim();
    if (!trimmedValue) {
      throw new Error(`Empty value for header "${lowerName}" (redacted)`);
    }

    const canonicalName = CANONICAL_HEADER_NAMES[lowerName] ?? lowerName;
    normalized[canonicalName] = trimmedValue;
  }

  return normalized;
}

/**
 * Parses stdout from the headers helper into a record of raw headers without leaking values.
 *
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
export function parseHeadersHelperOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("headersHelper produced invalid JSON output (values redacted)");
    }
    return validateAndNormalizeHeaders(parsed);
  }

  // Also support HTTP-style "Header-Name: value" lines.
  const lines = trimmed.split(/\r?\n/);
  /** @type {Record<string, string>} */
  const parsedLines = {};
  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) {
      continue;
    }
    const colonIndex = cleanLine.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        "headersHelper output must be a JSON object or 'Header: value' lines (values redacted)",
      );
    }
    const name = cleanLine.slice(0, colonIndex).trim();
    const value = cleanLine.slice(colonIndex + 1).trim();
    parsedLines[name] = value;
  }

  return validateAndNormalizeHeaders(parsedLines);
}

/**
 * Executes the configured headersHelper via execFile with shell: false,
 * 10000 ms timeout, 64 KiB stdout cap, and strict header-name allowlist.
 *
 * @param {string | string[]} command
 * @param {{ timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv; cwd?: string }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export function runHeadersHelper(command, options = {}) {
  const tokens = splitCommandTokens(command);
  const [file, ...args] = tokens;
  const timeoutMs = options.timeoutMs ?? HEADERS_HELPER_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? HEADERS_HELPER_MAX_STDOUT_BYTES;

  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        shell: false,
        timeout: timeoutMs,
        maxBuffer: maxBufferBytes,
        encoding: "utf8",
        windowsHide: true,
        env: options.env ?? process.env,
        cwd: options.cwd,
      },
      (error, stdout) => {
        if (error) {
          const code = /** @type {NodeJS.ErrnoException & { killed?: boolean; signal?: string }} */ (
            error
          );
          if (code.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(
              new Error(
                `headersHelper stdout exceeded maximum size of ${maxBufferBytes} bytes (output redacted)`,
              ),
            );
            return;
          }
          if (code.killed || code.signal === "SIGTERM") {
            reject(
              new Error(
                `headersHelper timed out after ${timeoutMs} ms (output redacted)`,
              ),
            );
            return;
          }
          const exitCode =
            typeof code.code === "number" || typeof code.code === "string"
              ? String(code.code)
              : "unknown";
          reject(
            new Error(
              `headersHelper execution failed (code: ${exitCode}, output redacted)`,
            ),
          );
          return;
        }

        const byteLength = Buffer.byteLength(stdout, "utf8");
        if (byteLength > maxBufferBytes) {
          reject(
            new Error(
              `headersHelper stdout exceeded maximum size of ${maxBufferBytes} bytes (output redacted)`,
            ),
          );
          return;
        }

        try {
          const validated = parseHeadersHelperOutput(stdout);
          resolve(validated);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

/**
 * Resolves headers from static headers and/or a headersHelper command.
 * All supplied headers are validated against the allowlist.
 *
 * @param {{
 *   headers?: Record<string, string>;
 *   headersHelper?: string | string[];
 *   timeoutMs?: number;
 *   maxBufferBytes?: number;
 *   env?: NodeJS.ProcessEnv;
 * }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveHeaders(options = {}) {
  /** @type {Record<string, string>} */
  const merged = {};

  if (options.headersHelper) {
    const helperHeaders = await runHeadersHelper(options.headersHelper, {
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
      env: options.env,
    });
    Object.assign(merged, helperHeaders);
  }

  if (options.headers) {
    const staticHeaders = validateAndNormalizeHeaders(options.headers);
    Object.assign(merged, staticHeaders);
  }

  return merged;
}
