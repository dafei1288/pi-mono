# @mariozechner/pi-mobile-server

Network bridge for the pi coding agent. Exposes the RPC protocol over **WebSocket** and **HTTP** so mobile and remote clients can use pi without going through openclaw.

## Architecture

```
Mobile Client ◄──WebSocket/HTTP──► pi-mobile-server ◄──stdin/stdout JSONL──► pi agent (RPC mode)
```

## Quick Start

```bash
# Install
npm install @mariozechner/pi-mobile-server

# Start (no auth, default port 18790)
npx pi-mobile-server

# With password auth
npx pi-mobile-server --password mysecret

# Custom port and model
npx pi-mobile-server --port 8080 --provider anthropic --model claude-sonnet-4-20250514

# Specify working directory
npx pi-mobile-server --cwd /path/to/project
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port, -p` | `18790` | TCP port |
| `--host, -h` | `0.0.0.0` | Bind host |
| `--password, -P` | (none) | Require password auth |
| `--provider` | (auto) | LLM provider |
| `--model, -m` | (auto) | Model ID |
| `--cwd` | (cwd) | Working directory for agent |

## WebSocket Protocol

Connect to `ws://host:port` and send JSON frames.

### Frame Types

**Request** (client → server):
```json
{ "type": "req", "id": "1", "method": "prompt", "params": { "message": "Hello" } }
```

**Response** (server → client):
```json
{ "type": "res", "id": "1", "ok": true, "payload": { "acknowledged": true } }
```

**Event** (server → client, streamed):
```json
{ "type": "event", "event": "text_delta", "payload": { ... }, "seq": 1 }
```

### Connect (Authenticate)

```json
→ { "type": "req", "id": "1", "method": "connect", "params": { "auth": { "password": "mysecret" } } }
← { "type": "res", "id": "1", "ok": true, "payload": { "token": "...", "serverVersion": "0.1.0", "sessionId": "..." } }
```

### Send a Prompt

```json
→ { "type": "req", "id": "2", "method": "prompt", "params": { "message": "Write a React counter" } }
← { "type": "res", "id": "2", "ok": true, "payload": { "acknowledged": true } }
← { "type": "event", "event": "agent_start", "payload": { "type": "agent_start" }, "seq": 1 }
← { "type": "event", "event": "text_delta", "payload": { ... }, "seq": 2 }
← { "type": "event", "event": "agent_end", "payload": { ... }, "seq": 5 }
```

### Methods

| Method | Description |
|--------|-------------|
| `connect` | Authenticate, get server info |
| `prompt` | Send message to agent |
| `abort` | Abort current generation |
| `steer` | Mid-run steering |
| `follow_up` | Queue follow-up message |
| `get_messages` | Get message history |
| `get_state` | Get session state |
| `get_models` | List available models |
| `set_model` | Switch model |
| `cycle_model` | Cycle to next model |
| `new_session` | Start new session |
| `switch_session` | Switch to existing session |
| `get_session_stats` | Get session statistics |
| `set_session_name` | Rename session |
| `compact` | Compact context |
| `bash` | Execute bash command |
| `set_thinking_level` | Set thinking level |
| `cycle_thinking_level` | Cycle thinking level |
| `fork` | Fork from a message |
| `get_fork_messages` | List forkable messages |
| `get_commands` | List extension commands |

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (no auth) |
| `/api/state` | GET | Session state |
| `/api/messages` | GET | Message history |
| `/api/models` | GET | Available models |
| `/api/prompt` | POST | Send prompt |
| `/api/abort` | POST | Abort generation |
| `/api/compact` | POST | Compact context |
| `/api/bash` | POST | Execute bash |

All `/api/*` endpoints require `Authorization: Bearer <token>` header when auth is configured.

## Programmatic Usage

```typescript
import { MobileServer } from "@mariozechner/pi-mobile-server";

const server = new MobileServer({
  port: 18790,
  auth: { password: "secret" },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    cwd: "/path/to/project",
  },
});

await server.start();
// ... later
await server.stop();
```

## Security

- **No auth mode**: all connections accepted (LAN/trusted network only)
- **Password mode**: clients authenticate with password, receive a bearer token
- **Token mode**: subsequent connections use the bearer token
- Tokens are HMAC-signed, expire after 7 days by default
- The server only binds to `0.0.0.0` — use a firewall or VPN for remote access
