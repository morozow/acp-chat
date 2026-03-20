# acp-chat

Agent-to-agent dialogue over stdio_bus using the ACP protocol.

## Installation

```bash
npm install acp-chat
```

## CLI Usage

```bash
# Create new session and send message
npx acp-chat new "Hello"

# Continue existing session
npx acp-chat <sessionId> "Follow-up message"
```

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
});

// Stream responses in real-time
client.on('update', (sessionId, update) => {
  if (update.sessionUpdate === 'agent_message_chunk') {
    process.stdout.write(update.content.text);
  }
});

await client.initialize();

const session = await client.sessionNew();
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

### Client Methods

- `initialize()`: Initialize the ACP connection
- `sessionNew(configOptions?)`: Create a new session
- `sessionPrompt(sessionId, text, role?)`: Send a prompt
- `sessionConfigure(sessionId, options)`: Configure session
- `sessionCancel(sessionId)`: Cancel ongoing operation

### Events

- `update`: Session update notifications (streaming chunks, tool calls, etc.)
- `notification`: Raw JSON-RPC notifications
