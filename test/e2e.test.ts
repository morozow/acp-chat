// ============================================================================
// ACP Chat — E2E Tests
// ============================================================================
// These tests spin up a real TCP server that simulates a stdio Bus router,
// connect the NDJSONClient + ACPClient to it, and exercise the full protocol
// flow including session/request_permission handling.
// ============================================================================

import * as net from 'node:net';
import { NDJSONClient } from '../src/ndjson-client.js';
import { createACPClient, type SessionUpdate } from '../src/acp-client.js';
import { serializeNdjson } from '../src/ndjson.js';
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockRouter {
  server: net.Server;
  port: number;
  connections: net.Socket[];
  /** All parsed JSON-RPC messages received from clients */
  received: Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * Creates a real TCP server that simulates a stdio Bus router.
 * The `handler` callback is invoked for every JSON-RPC message received,
 * giving the test full control over responses.
 */
function createMockRouter(
  handler: (msg: Record<string, unknown>, socket: net.Socket) => void,
): Promise<MockRouter> {
  return new Promise((resolve, reject) => {
    const connections: net.Socket[] = [];
    const received: Record<string, unknown>[] = [];
    const server = net.createServer((socket) => {
      connections.push(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.length) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            received.push(msg);
            handler(msg, socket);
          } catch {
            // ignore framing errors in tests
          }
        }
      });
      socket.on('error', () => { });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        server,
        port: addr.port,
        connections,
        received,
        close: () =>
          new Promise<void>((res) => {
            for (const c of connections) c.destroy();
            server.close(() => res());
          }),
      });
    });
    server.on('error', reject);
  });
}

function sendToSocket(socket: net.Socket, obj: unknown): void {
  socket.write(serializeNdjson(obj));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('E2E: full ACP protocol flow', () => {
  let router: MockRouter;
  let ndjsonClient: NDJSONClient;

  afterEach(async () => {
    if (ndjsonClient) await ndjsonClient.close().catch(() => { });
    if (router) await router.close().catch(() => { });
  });

  // -----------------------------------------------------------------------
  // Test 1: Basic initialize → sessionNew → sessionPrompt (happy path)
  // -----------------------------------------------------------------------
  it('should complete initialize → sessionNew → sessionPrompt', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'test-agent', version: '1.0.0' },
          },
        });
      } else if (method === 'session/new') {
        sendToSocket(socket, {
          jsonrpc: '2.0',
          id,
          result: { sessionId: 'sess-001' },
        });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        // Send streaming updates first
        sendToSocket(socket, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello ' },
            },
          },
        });
        sendToSocket(socket, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'World!' },
            },
          },
        });

        // Then send the final response
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            id,
            result: { stopReason: 'end_turn' },
          });
        }, 50);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    });

    const initResult = await client.initialize();
    assert.equal(initResult.protocolVersion, 1);
    assert.equal(initResult.agentInfo?.name, 'test-agent');

    const session = await client.sessionNew();
    assert.equal(session.sessionId, 'sess-001');
    assert.ok(session.clientSessionId);

    const result = await client.sessionPrompt(session.sessionId, 'Hi');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Hello World!');
    assert.ok(result.updates.length >= 2);
  });

  // -----------------------------------------------------------------------
  // Test 2: session/request_permission arrives during prompt — should NOT
  //         block the prompt response
  // -----------------------------------------------------------------------
  it('should not hang when session/request_permission arrives during prompt', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: 1 },
        });
      } else if (method === 'session/new') {
        sendToSocket(socket, {
          jsonrpc: '2.0',
          id,
          result: { sessionId: 'sess-perm' },
        });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        // 1. Send a streaming chunk
        sendToSocket(socket, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Working...' },
            },
          },
        });

        // 2. Simulate the router forwarding session/request_permission
        //    (incoming request with its own id + method)
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            id: 'perm-req-001',
            method: 'session/request_permission',
            params: {
              sessionId,
              permission: 'execute',
              description: 'Run shell command',
            },
          });
        }, 20);

        // 3. Send more streaming after permission
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: ' Done.' },
              },
            },
          });
        }, 40);

        // 4. Final response — this MUST be received by the client
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            id,
            result: { stopReason: 'end_turn' },
          });
        }, 60);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const permissionEvents: unknown[] = [];
    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    client.on('permissionRequest', (req: unknown) => {
      permissionEvents.push(req);
    });

    await client.initialize();
    const session = await client.sessionNew();

    // This MUST NOT hang — the permission request should be handled
    // without blocking the prompt response
    const result = await client.sessionPrompt(session.sessionId, 'Do something');
    assert.equal(result.stopReason, 'end_turn');
    assert.ok(result.text.includes('Working...'));
    assert.ok(result.text.includes('Done.'));

    // Verify the permission event was emitted
    assert.equal(permissionEvents.length, 1);
    const permReq = permissionEvents[0] as Record<string, unknown>;
    assert.equal(permReq['id'], 'perm-req-001');
    assert.equal(permReq['method'], 'session/request_permission');
  });

  // -----------------------------------------------------------------------
  // Test 3: Multiple permission requests during a single prompt
  // -----------------------------------------------------------------------
  it('should handle multiple permission requests without hanging', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { sessionId: 'sess-multi' } });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        // Fire 3 permission requests in sequence
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            sendToSocket(socket, {
              jsonrpc: '2.0',
              id: `perm-${i}`,
              method: 'session/request_permission',
              params: { sessionId, permission: `action-${i}` },
            });
          }, 10 + i * 15);
        }

        // Streaming chunk
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'All permissions granted.' },
              },
            },
          });
        }, 70);

        // Final response
        setTimeout(() => {
          sendToSocket(socket, { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }, 100);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const permissionEvents: unknown[] = [];
    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    client.on('permissionRequest', (req: unknown) => permissionEvents.push(req));

    await client.initialize();
    const session = await client.sessionNew();

    const result = await client.sessionPrompt(session.sessionId, 'Multi-perm task');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'All permissions granted.');
    assert.equal(permissionEvents.length, 3);
  });

  // -----------------------------------------------------------------------
  // Test 4: Router auto-response (result with permission request id)
  //         should not confuse the request tracker
  // -----------------------------------------------------------------------
  it('should ignore router auto-response for permission request ids', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { sessionId: 'sess-auto' } });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        // 1. Router forwards permission request to client
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            id: 'perm-auto-001',
            method: 'session/request_permission',
            params: { sessionId, permission: 'execute' },
          });
        }, 10);

        // 2. Router also sends its own auto-response (as if echoing)
        //    This has id + result — looks like a response
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            id: 'perm-auto-001',
            result: { permission: 'granted', option: 'approved-execpolicy-amendment' },
          });
        }, 20);

        // 3. Streaming chunk
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Executed successfully.' },
              },
            },
          });
        }, 40);

        // 4. Final prompt response
        setTimeout(() => {
          sendToSocket(socket, { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }, 60);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    await client.initialize();
    const session = await client.sessionNew();

    // Must not hang — the auto-response for perm-auto-001 should be
    // harmlessly ignored by requestTracker (no matching pending entry)
    const result = await client.sessionPrompt(session.sessionId, 'Auto-response test');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Executed successfully.');
  });

  // -----------------------------------------------------------------------
  // Test 5: Session continuation (reuse clientSessionId)
  // -----------------------------------------------------------------------
  it('should continue an existing session with clientSessionId', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        sendToSocket(socket, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Continued session response.' },
            },
          },
        });

        setTimeout(() => {
          sendToSocket(socket, { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }, 30);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
      clientSessionId: 'existing-client-session-42',
    });

    await client.initialize();

    // Skip sessionNew — go straight to prompt with known sessionId
    const result = await client.sessionPrompt('existing-session-id', 'Follow-up');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Continued session response.');

    // Verify the clientSessionId was sent in the request
    const promptMsg = router.received.find((m) => m['method'] === 'session/prompt');
    assert.ok(promptMsg);
    assert.equal(promptMsg['sessionId'], 'existing-client-session-42');
  });

  // -----------------------------------------------------------------------
  // Test 6: Error response from server
  // -----------------------------------------------------------------------
  it('should throw on server error response', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { sessionId: 'sess-err' } });
      } else if (method === 'session/prompt') {
        sendToSocket(socket, {
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'Internal agent error' },
        });
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    await client.initialize();
    const session = await client.sessionNew();

    await assert.rejects(
      () => client.sessionPrompt(session.sessionId, 'Fail'),
      (err: Error) => {
        assert.ok(err.message.includes('Internal agent error'));
        return true;
      },
    );
  });

  // -----------------------------------------------------------------------
  // Test 7: Streaming updates arrive in real-time via 'update' event
  // -----------------------------------------------------------------------
  it('should emit streaming updates in real-time', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { sessionId: 'sess-stream' } });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        const chunks = ['chunk1', 'chunk2', 'chunk3'];
        chunks.forEach((text, i) => {
          setTimeout(() => {
            sendToSocket(socket, {
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text },
                },
              },
            });
          }, 10 + i * 20);
        });

        setTimeout(() => {
          sendToSocket(socket, { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }, 100);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    const streamedChunks: string[] = [];
    client.on('update', (_sid: string, update: SessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        streamedChunks.push(update.content.text);
      }
    });

    await client.initialize();
    const session = await client.sessionNew();

    const result = await client.sessionPrompt(session.sessionId, 'Stream test');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(streamedChunks, ['chunk1', 'chunk2', 'chunk3']);
    assert.equal(result.text, 'chunk1chunk2chunk3');
  });

  // -----------------------------------------------------------------------
  // Test 8: Request timeout
  // -----------------------------------------------------------------------
  it('should timeout if server never responds', async () => {
    router = await createMockRouter((_msg, _socket) => {
      // Intentionally never respond
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 1500,
    });

    await assert.rejects(
      () => client.initialize(),
      (err: Error) => {
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
  });

  // -----------------------------------------------------------------------
  // Test 9: tool_call and tool_call_update in session updates
  // -----------------------------------------------------------------------
  it('should handle tool_call and tool_call_update session updates', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { sessionId: 'sess-tools' } });
      } else if (method === 'session/prompt') {
        const params = msg['params'] as Record<string, unknown>;
        const sessionId = params['sessionId'] as string;

        // tool_call update
        sendToSocket(socket, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-001',
              title: 'Read file',
              kind: 'file_read',
              status: 'running',
            },
          },
        });

        // tool_call_update with content
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-001',
                status: 'completed',
                content: [
                  { type: 'text', content: { type: 'text', text: 'File contents here.' } },
                ],
              },
            },
          });
        }, 20);

        // Agent message after tool
        setTimeout(() => {
          sendToSocket(socket, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Analysis complete.' },
              },
            },
          });
        }, 40);

        setTimeout(() => {
          sendToSocket(socket, { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }, 60);
      }
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    await client.initialize();
    const session = await client.sessionNew();

    const result = await client.sessionPrompt(session.sessionId, 'Read and analyze');
    assert.equal(result.stopReason, 'end_turn');
    // text should include tool_call_update content + agent message
    assert.ok(result.text.includes('File contents here.'));
    assert.ok(result.text.includes('Analysis complete.'));
    // Should have 3 updates: tool_call, tool_call_update, agent_message_chunk
    assert.equal(result.updates.length, 3);
  });

  // -----------------------------------------------------------------------
  // Test 10: sessionCancel sends cancel notification
  // -----------------------------------------------------------------------
  it('should send session/cancel as a notification', async () => {
    router = await createMockRouter((msg, socket) => {
      const id = msg['id'];
      const method = msg['method'] as string;

      if (method === 'initialize') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        sendToSocket(socket, { jsonrpc: '2.0', id, result: { sessionId: 'sess-cancel' } });
      }
      // Don't respond to session/prompt — we'll cancel it
    });

    ndjsonClient = new NDJSONClient({
      address: `127.0.0.1:${router.port}`,
      connectionType: 'tcp',
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
    });

    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: 'test-agent',
      requestTimeoutMs: 5000,
    });

    await client.initialize();
    const session = await client.sessionNew();

    // Send cancel
    client.sessionCancel(session.sessionId);

    // Wait a bit for the message to arrive
    await new Promise((r) => setTimeout(r, 50));

    const cancelMsg = router.received.find((m) => m['method'] === 'session/cancel');
    assert.ok(cancelMsg, 'session/cancel message should have been sent');
    const cancelParams = cancelMsg['params'] as Record<string, unknown>;
    assert.equal(cancelParams['sessionId'], 'sess-cancel');
  });
});
