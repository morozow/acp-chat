# acp-chat

[![npm](https://img.shields.io/npm/v/acp-chat?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/acp-chat)
[![stdioBus](https://img.shields.io/badge/ecosystem-stdio%20Bus-ff4500?style=for-the-badge)](https://github.com/stdiobus)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple?style=for-the-badge&logo=jsonwebtokens)](https://modelcontextprotocol.io)
[![ACP](https://img.shields.io/badge/protocol-ACP-purple?style=for-the-badge&logo=jsonwebtokens)](https://agentclientprotocol.com)
[![JSON‑RPC](https://img.shields.io/badge/transport-JSON--RPC%202.0-orange?style=for-the-badge&logo=json)](https://www.jsonrpc.org/specification)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=for-the-badge&logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org)
[![Build](https://img.shields.io/badge/build-esbuild-yellow?style=for-the-badge&logo=esbuild)](https://esbuild.github.io)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=for-the-badge&logo=nodedotjs)](https://github.com/morozow/acp-chat)
[![Windows](https://img.shields.io/badge/Windows-via%20Docker-2496ED?style=for-the-badge&logo=docker)](https://github.com/morozow/acp-chat)
[![npm downloads](https://img.shields.io/npm/dm/acp-chat?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/acp-chat)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge&logo=opensourceinitiative)](https://github.com/morozow/acp-chat/blob/main/LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge&logo=packagephobia)](https://www.npmjs.com/package/acp-chat)

Agent-to-agent dialogue over TCP/Unix socket using the ACP protocol.

![ACP Chat Example](https://raw.githubusercontent.com/morozow/acp-chat/main/assets/acp-chat-example.png)

## Installation

```bash
npm install acp-chat
```

## CLI Usage

```bash
# Create new session and send message
npx acp-chat new "Hello"
# Output:
#   CLIENT_SESSION_ID=client-1234567890-abc123
#   SESSION_ID=019d0a91-deb3-72c1-857a-80cfeea503cc
#   <agent response>

# Continue existing session (requires both IDs)
npx acp-chat <clientSessionId> <sessionId> "Follow-up message"
# Example:
npx acp-chat client-1234567890-abc123 019d0a91-deb3-72c1-857a-80cfeea503cc "What about X?"
```

Environment variables:
- `ACP_BUS_ADDRESS` — bus address (default: `127.0.0.1:9800`)
- `ACP_AGENT_ID` — target agent ID (default: `codex-acp`)

## Programmatic Usage

```typescript
import { createACPClient, NDJSONClient } from 'acp-chat';

const ndjsonClient = new NDJSONClient({
  address: '127.0.0.1:9800',
  connectionType: 'tcp',
  maxReconnectAttempts: 3,
  baseReconnectDelayMs: 500,
  maxReconnectDelayMs: 5000,
});

await ndjsonClient.connect();

const client = createACPClient(ndjsonClient, {
  agentId: 'codex-acp',
  requestTimeoutMs: 5 * 60 * 1000,
  clientInfo: { name: 'my-app', version: '1.0.0' },
  // For continuing a session, pass the clientSessionId:
  // clientSessionId: 'client-1234567890-abc123',
});

// Stream responses in real-time
client.on('update', (sessionId, update) => {
  if (update.sessionUpdate === 'agent_message_chunk') {
    process.stdout.write(update.content.text);
  }
});

await client.initialize();

const session = await client.sessionNew();
// Save both IDs for continuing the session later:
// - session.clientSessionId — needed to restore client connection
// - session.sessionId — needed to identify the dialogue
const result = await client.sessionPrompt(session.sessionId, 'Hello!');

console.log(result.text);

await ndjsonClient.close();
```

## API

### `NDJSONClient`

TCP/Unix socket client with NDJSON framing and automatic reconnection.

### `createACPClient(ndjsonClient, options)`

Creates an ACP client for agent communication.

Options:
- `agentId`: Target agent identifier
- `requestTimeoutMs`: Request timeout (default: 120000)
- `clientInfo`: Client identification info
- `clientSessionId`: Existing client session ID (for continuing sessions)

### Client Methods

- `initialize()`: Initialize the ACP connection
- `sessionNew(configOptions?)`: Create a new session (returns `sessionId` and `clientSessionId`)
- `sessionPrompt(sessionId, text, role?)`: Send a prompt
- `sessionConfigure(sessionId, options)`: Configure session
- `sessionCancel(sessionId)`: Cancel ongoing operation

### Events

- `update`: Session update notifications (streaming chunks, tool calls, etc.)
- `notification`: Raw JSON-RPC notifications

## License

Apache-2.0