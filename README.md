# @sheurich/pi-a2a

Pi extension for discovering and talking to [A2A](https://a2a-protocol.org) agents over JSON-RPC 2.0 and Server-Sent Events.

## Overview

`pi-a2a` gives Pi ten tools that let the model find remote agents behind an A2A gateway, send them work, stream their replies, answer their follow-up questions, and check or cancel tasks. It has zero runtime dependencies: everything is built on Node's `fetch`, `node:http`, and `node:child_process`.

Security defaults:

- Only `https://` gateways are accepted (`http://` is allowed for `127.0.0.1`, `localhost`, and `[::1]` so you can test locally).
- Redirects are refused (`redirect: "error"`), so credentials are never replayed to another origin.
- Agent Card responses are capped at 64 KiB; RPC and SSE bodies at 4 MiB.
- Authentication headers come only from a configured helper command, never from tool parameters, and are restricted to `authorization` and `x-goog-iap-jwt-assertion`. Header values are never written to errors or logs.
- A gateway that withholds a reply (HTTP 502, or a JSON-RPC error with `data.reason === "reply_withheld"`) is reported as the soft state `reply_withheld` instead of an exception.

## Configuration

Install the package and point Pi at it, for example in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["@sheurich/pi-a2a"]
}
```

Then configure the gateway through environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PI_A2A_URL` | yes* | Base URL of the A2A gateway, e.g. `https://agents.example.com`. Agents are expected under `/a2a/{agent}`; the root agent is served from the base URL itself. |
| `PI_A2A_HEADERS_HELPER` | no | Command that prints authentication headers to stdout, either as a JSON object or as `Header: value` lines. Run with `execFile` (no shell), a 10 s timeout, and a 64 KiB output cap. Only `authorization` and `x-goog-iap-jwt-assertion` are accepted. |
| `PI_A2A_AGENT` | no | Default agent name used when a tool call does not specify one. |

\* The model may also pass `url` per call; it still has to satisfy the HTTPS rule.

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
| `a2a_agents` | `url?`, `agent?` | Fetches `GET /.well-known/agent.json` and the `GET /a2a` directory (or a single `GET /a2a/{agent}/.well-known/agent.json`) and lists names, versions, streaming support, and skills. |
| `a2a_send` | `message`, `agent?`, `url?`, `context_id?`, `stream?` | Starts a task with `message/send`, or `message/stream` (SSE) when `stream` is true. Returns `taskId`, `contextId`, `state`, and the agent's text. |
| `a2a_status` | `task_id`, `agent?`, `url?` | Calls `tasks/get` and returns the current state, artifacts, and latest agent message. |
| `a2a_reply` | `task_id`, `message`, `agent?`, `url?`, `context_id?`, `stream?` | Continues a task that is in `input-required` by sending another user message with the same `taskId`. |
| `a2a_cancel` | `task_id`, `agent?`, `url?` | Calls `tasks/cancel`. |
| `a2a_card` | `agent?`, `url?` | Fetches one agent's card from `/a2a/{agent}/.well-known/agent.json` (root card without `agent`). |
| `a2a_get_task` | `task_id`, `agent?`, `url?` | Calls `tasks/get` on `/a2a/{agent}`. |
| `a2a_cancel_task` | `task_id`, `agent?`, `url?` | Calls `tasks/cancel` on `/a2a/{agent}`. |
| `a2a_send_file` | `task_id`, `name`, `content`, `encoding?`, `content_type?`, `url?` | Stages a file with `POST /files/{task_id}/{name}` (max 8 MiB). |
| `a2a_get_file` | `task_id`, `name`, `url?` | Downloads a staged file with `GET /files/{task_id}/{name}` (text inline, binary as base64). |

### Multi-agent routing

`agent` is an optional name matching `[a-z0-9][a-z0-9-]{0,62}` (for example `observability`, `pgm`, `traffic-insights`, `main`, `defamer`, `performance-center`). It resolves to `<base>/a2a/<agent>` for JSON-RPC and `<base>/a2a/<agent>/.well-known/agent.json` for the card. Anything else (uppercase, `/`, `..`, `.`, encoded separators) is rejected before any request is made. The default comes from `PI_A2A_AGENT`.

The slash command `/a2a [@agent] <message>` sends a message, and `/a2a card [@agent]` shows a card, when the host supports `registerCommand`.

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

- `src/client.mjs` — A2A JSON-RPC/SSE client (`discoverAgents`, `sendMessage`, `getTask`, `cancelTask`, `parseSseStream`)
- `src/headers-helper.mjs` — helper command runner with strict header allowlist
- `src/extension.mjs` — Pi tool registration (`registerPiA2aExtension`)
- `src/extension.d.ts` — type declarations
- `test/a2a.test.mjs` — `node:test` suite with mock gateway

Requires Node 20 or later. Licensed under MIT.
