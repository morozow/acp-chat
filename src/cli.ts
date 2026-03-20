#!/usr/bin/env node
// Copyright 2026 Raman Marozau <raman@worktif.com>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// ============================================================================
// ACP Chat CLI — single-turn tool for agent-to-agent dialogue
// ============================================================================
// Usage:
//   acp-chat new "Hello"                              — create session + send
//   acp-chat <clientSessionId> <sessionId> "Hello"   — continue session

import { NDJSONClient } from './ndjson-client.js';
import { createACPClient, type SessionUpdate } from './acp-client.js';

const BUS_ADDRESS = process.env['ACP_BUS_ADDRESS'] ?? '127.0.0.1:9800';
const AGENT_ID = process.env['ACP_AGENT_ID'] ?? 'codex-acp';

async function main() {
  const args = process.argv.slice(2);

  let clientSessionId: string | undefined;
  let sessionId: string | undefined;
  let message: string;

  if (args[0] === 'new') {
    // acp-chat new "message"
    if (args.length < 2) {
      console.error('Usage: acp-chat new "<message>"');
      process.exit(1);
    }
    message = args[1];
  } else {
    // acp-chat <clientSessionId> <sessionId> "message"
    if (args.length < 3) {
      console.error('Usage: acp-chat <clientSessionId> <sessionId> "<message>"');
      process.exit(1);
    }
    clientSessionId = args[0];
    sessionId = args[1];
    message = args[2];
  }

  const ndjsonClient = new NDJSONClient({
    address: BUS_ADDRESS,
    connectionType: 'tcp',
    maxReconnectAttempts: 3,
    baseReconnectDelayMs: 500,
    maxReconnectDelayMs: 5000,
  });

  try {
    await ndjsonClient.connect();

    const client = createACPClient(ndjsonClient, {
      agentId: AGENT_ID,
      requestTimeoutMs: 5 * 60 * 1000,
      clientInfo: { name: 'acp-chat-cli', version: '1.0.0' },
      clientSessionId,
    });

    client.on('update', (_sid: string, update: SessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        process.stdout.write(update.content.text);
      }
    });

    await client.initialize();

    if (!sessionId) {
      const session = await client.sessionNew();
      sessionId = session.sessionId;
      console.error(`CLIENT_SESSION_ID=${session.clientSessionId}`);
      console.error(`SESSION_ID=${sessionId}`);
    } else {
      console.error(`CLIENT_SESSION_ID=${clientSessionId}`);
      console.error(`SESSION_ID=${sessionId} (continued)`);
    }

    const result = await client.sessionPrompt(sessionId, message);
    process.stdout.write('\n');
    console.error(`STOP=${result.stopReason} UPDATES=${result.updates.length}`);
  } finally {
    await ndjsonClient.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
