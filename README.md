# @sheurich/pi-a2a

Pi extension for discovering and talking to [A2A](https://a2a-protocol.org) agents over JSON-RPC 2.0 and Server-Sent Events.

## Overview

`pi-a2a` gives Pi eleven tools that let the model discover configured gateways and remote agents, send them work, stream their replies, answer their follow-up questions, stage files, and check or cancel tasks. It has zero runtime dependencies: everything is built on Node's `fetch`, `node:http`, `node:fs`, and `node:child_process`.

Security defaults:

- Only `https://` gateways are accepted (`http://` is allowed for `127.0.0.1`, `localhost`, and `[::1]` so you can test locally).
- Redirects are refused (`redirect: "error"`), so credentials are never replayed to another origin.
- Agent Card responses are capped at 64 KiB; RPC and SSE bodies at 4 MiB.
- Authentication headers come only from a configured helper command, never from tool parameters, and are restricted to `authorization` and `x-goog-iap-jwt-assertion`. Header values are never written to errors or logs.
- A gateway that withholds a reply (HTTP 502, or a JSON-RPC error with `data.reason === "reply_withheld"`) is reported as the soft state `reply_withheld` instead of an exception.

## Configuration

Install the package with `pi install npm:@sheurich/pi-a2a` (or `pi install git:github.com/sheurich/pi-a2a`), or add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@sheurich/pi-a2a"]
}
```

Then configure one or more gateways via a user-level JSON config file (`~/.pi/agent/a2a.json`, or `PI_A2A_CONFIG`) and/or environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PI_A2A_CONFIG` | no | Explicit absolute path to a JSON gateway config file. When unset, `$PI_CODING_AGENT_DIR/a2a.json` (or `$HOME/.pi/agent/a2a.json`) is loaded if present. Project/working directories are never searched. |
| `PI_A2A_GATEWAY` | no | Default named gateway from the config file when a tool call omits `gateway`. |
| `PI_A2A_URL` | yes* | Legacy base URL of a single A2A gateway, e.g. `https://agents.example.com`. Agents are expected under `/a2a/{agent}`; the root agent is served from the base URL itself. |
| `PI_A2A_HEADERS_HELPER` | no | Command that prints authentication headers to stdout for legacy `PI_A2A_URL` mode, either as a JSON object or as `Header: value` lines. Run with `execFile` (no shell), a 10 s timeout, and a 64 KiB output cap. Only `authorization` and `x-goog-iap-jwt-assertion` are accepted. |
| `PI_A2A_AGENT` | no | Default agent name used in legacy `PI_A2A_URL` mode when a tool call does not specify one. |
| `PI_A2A_PROTOCOL` | no | Wire protocol for legacy `PI_A2A_URL` mode: `auto` (default), `0.3`, or `1.0`. Named gateways configure `protocol` per entry and do not inherit this variable. |

\* The model may also pass `gateway` (targeting a configured named gateway) or `url` per call (when no legacy `headersHelper` is configured); every URL still has to satisfy the HTTPS/loopback rule.

### Named gateways (`a2a.json`)

Configure multiple independent A2A gateways in `~/.pi/agent/a2a.json` (or the path in `PI_A2A_CONFIG`) so one Pi session can talk to different origins with isolated credentials:

```json
{
  "defaultGateway": "sumac",
  "gateways": {
    "sumac": {
      "url": "https://agents.example.com/a2a",
      "headersHelper": "/usr/local/bin/sumac-headers",
      "description": "Sumac A2A gateway"
    },
    "coder": {
      "url": "http://127.0.0.1:18081",
      "headersHelper": ["/usr/local/bin/coder-a2a-headers", "--workspace", "dev"],
      "protocol": "1.0",
      "description": "Loopback SSH-forwarded Coder workspace (A2A v1.0)"
    }
  }
}
```

Gateway config rules and security invariants:

- **Strict schema:** Top-level keys are `gateways` (required, up to 64 entries) and `defaultGateway` (optional, must exist in `gateways`). Gateway names match `[a-z0-9][a-z0-9-]{0,62}`. Each entry accepts only `url` (required, HTTPS or loopback HTTP, no query/fragment/userinfo), `headersHelper` (optional string or string array), `agent` (optional), `description` (optional, max 256 chars, no control characters), and `protocol` (optional `"auto"`, `"0.3"`, or `"1.0"`). Static `headers` or secret keys are rejected.
- **File trust checks:** Config files are opened non-blockingly (`O_RDONLY | O_NONBLOCK` → `fstat` → bounded 64 KiB `read`) to avoid TOCTOU races and FIFO hangs. Non-regular files are rejected; on POSIX, the resolved file must be owned by the current user and not group- or world-writable (`mode & 0o022`). (Parent directory permissions are not checked, and mode/ownership checks are skipped on Windows.) An explicit `PI_A2A_CONFIG` must be an absolute path and fails closed if missing or invalid; a dangling symlink at the default `~/.pi/agent/a2a.json` path behaves as absent (`ENOENT`).
- **Executable path safety:** Relative `headersHelper` executables containing `/` or `\` are rejected (use absolute paths or bare `PATH` command names), and named-gateway helpers execute with `cwd` set to the config file's directory (or `$HOME` for programmatic gateways) rather than the active project working directory.
- **Credential & origin isolation:** Named gateways never inherit `PI_A2A_URL`, `PI_A2A_HEADERS_HELPER`, `PI_A2A_AGENT`, or `PI_A2A_PROTOCOL`. Passing a different `url` alongside a named gateway (even same-origin with a different path) is refused, and `pinnedOrigin` is always enforced at the client layer.
- **A2A v0.3 & v1.0 wire compatibility:** `"0.3"` uses `/.well-known/agent.json` and `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`. `"1.0"` uses `/.well-known/agent-card.json`, `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `role: "ROLE_USER"`, and `{ text }` parts. `"auto"` (default) tries v0.3 first and falls back to v1.0 only on HTTP 404/405 for Agent Cards or JSON-RPC `-32601` (Method not found) for RPC calls. Response and SSE normalization transparently accepts v0.3 payloads, v1.0 `TASK_STATE_*` / `ROLE_AGENT` / union-wrapped (`task`, `message`, `statusUpdate`, `artifactUpdate`) payloads, and bare Swival SSE event frames.
- **Precedence when `gateway` is omitted:** `options.gateway` → `options.baseUrl` → `PI_A2A_GATEWAY` → `PI_A2A_URL` → `a2a.json` `defaultGateway` → ad-hoc `url` (only when no legacy `headersHelper` is configured). This keeps existing `PI_A2A_URL` setups unchanged when `a2a.json` is added.
- **Multi-gateway reach tradeoff:** Any gateway listed in `a2a.json` is reachable by the model via `gateway: "<name>"` (and can invoke that gateway's `headersHelper`). Only configure gateways you intend the active Pi session to reach.

Example:

```sh
export PI_A2A_URL="https://agents.example.com"
export PI_A2A_HEADERS_HELPER="/usr/local/bin/a2a-headers --audience agents.example.com"
```

The command string is split into arguments (single/double quotes and backslash escapes are honored) and executed directly, not through a shell. A minimal helper script looks like this:

```js
#!/usr/bin/env node
process.stdout.write(JSON.stringify({ authorization: `Bearer ${process.env.MY_TOKEN}` }));
```

## Tools

| Tool | Parameters | What it does |
| --- | --- | --- |
| `a2a_gateways` | *(none)* | Lists configured named gateways (names, URLs, default agent, description, and `auth: configured\|none`; never exposes helper commands or credentials). |
| `a2a_agents` | `gateway?`, `url?`, `agent?` | Fetches `GET /.well-known/agent.json` and the `GET /a2a` directory (or a single `GET /a2a/{agent}/.well-known/agent.json`) and lists names, versions, streaming support, and skills. |
| `a2a_send` | `message`, `gateway?`, `agent?`, `url?`, `context_id?`, `stream?` | Starts a task with `message/send`, or `message/stream` (SSE) when `stream` is true. Returns `taskId`, `contextId`, `state`, and the agent's text. |
| `a2a_status` | `task_id`, `gateway?`, `agent?`, `url?` | Calls `tasks/get` and returns the current state, artifacts, and latest agent message. |
| `a2a_reply` | `task_id`, `message`, `gateway?`, `agent?`, `url?`, `context_id?`, `stream?` | Continues a task that is in `input-required` by sending another user message with the same `taskId`. |
| `a2a_cancel` | `task_id`, `gateway?`, `agent?`, `url?` | Calls `tasks/cancel`. |
| `a2a_card` | `gateway?`, `agent?`, `url?` | Fetches one agent's card from `/a2a/{agent}/.well-known/agent.json` (root card without `agent`). |
| `a2a_get_task` | `task_id`, `gateway?`, `agent?`, `url?` | Calls `tasks/get` on `/a2a/{agent}`. |
| `a2a_cancel_task` | `task_id`, `gateway?`, `agent?`, `url?` | Calls `tasks/cancel` on `/a2a/{agent}`. |
| `a2a_send_file` | `task_id`, `name`, `content`, `encoding?`, `content_type?`, `gateway?`, `url?` | Stages a file with `POST /files/{task_id}/{name}` (max 8 MiB). |
| `a2a_get_file` | `task_id`, `name`, `gateway?`, `url?` | Downloads a staged file with `GET /files/{task_id}/{name}` (text inline, binary as base64). |

### Multi-agent routing

`agent` is an optional name matching `[a-z0-9][a-z0-9-]{0,62}` (for example `research`, `code-review`, `incident-triage`, `main`). It resolves to `<base>/a2a/<agent>` for JSON-RPC and `<base>/a2a/<agent>/.well-known/agent.json` for the card. Anything else (uppercase, `/`, `..`, `.`, encoded separators) is rejected before any request is made. The default comes from `PI_A2A_AGENT`.

The slash command `/a2a [-g <gateway>] [@agent] <message>` sends a message, `/a2a card [-g <gateway>] [@agent]` (or `/a2a -g <gateway> card [@agent]`) shows a card, and `/a2a gateways` lists configured gateways, when the host supports `registerCommand`.

### Task file staging

`task_id` and `name` must each be a single path segment (letters, digits, `.`, `_`, `-`; no `/`, `\`, `..`, `%`, `?`, `#`), so they cannot traverse out of `/files/{task_id}/`. Files are posted as raw bytes, with `application/octet-stream` unless `content_type` is given.

### Credential pinning

When `PI_A2A_HEADERS_HELPER` is set, a tool-supplied `url` must have the same origin as `PI_A2A_URL`. This applies to every tool, including the file tools. The extension also passes `pinnedOrigin` to the client, which refuses any call whose base URL has a different origin. Redirects are never followed.

Task states surfaced to the model: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`, `auth-required`, and `reply_withheld`. When a result is `input-required`, the tool output tells the model to continue with `a2a_reply`.

The underlying client is exported for direct use:

```js
import { discoverAgents, sendMessage, getTask, cancelTask, sendFile, getFile } from "@sheurich/pi-a2a/client";
// getTask(baseUrl, { taskId, agent }), cancelTask(baseUrl, { taskId, agent }),
// sendFile(baseUrl, { taskId, name, content }), getFile(baseUrl, { taskId, name })
// All accept `pinnedOrigin` to refuse calls to any other origin.

const { agents } = await discoverAgents({ baseUrl: "https://agents.example.com" });
const reply = await sendMessage({
  baseUrl: "https://agents.example.com",
  agent: agents[0].agent,
  message: "Summarize today's open incidents",
  stream: true,
  onEvent: (event) => console.error(event.kind, event.state ?? ""),
});
console.log(reply.state, reply.text);
```

## Development

```sh
node --test test/a2a.test.mjs
```

The test suite spins up a loopback mock gateway with `node:http` and covers Agent Card discovery, `message/send`, `message/stream` SSE parsing, `input-required` continuation via `a2a_reply`, `tasks/get` and `tasks/cancel`, `reply_withheld` handling, and the headers helper allowlist and redaction. It runs offline and needs no `node_modules`.

Layout:

- `src/client.mjs` — A2A JSON-RPC/SSE client (`discoverAgents`, `getAgentCard`, `sendMessage`, `getTask`, `cancelTask`, `sendFile`, `getFile`, `parseSseStream`)
- `src/gateways.mjs` — named gateway config loader and fail-closed validator
- `src/headers-helper.mjs` — helper command runner with strict header allowlist
- `src/extension.mjs` — Pi tool registration (`registerPiA2aExtension`)
- `src/extension.d.ts` — type declarations
- `test/a2a.test.mjs` — `node:test` suite with mock gateway

Requires Node 20 or later. Licensed under MIT.
