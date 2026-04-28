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
// ACP Chat — ACP Client
// ============================================================================

import { NDJSONClient } from './ndjson-client.js';
import { createRequestTracker, type RequestTracker } from './request-tracker.js';
import type { JsonRpcResponse } from './types.js';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Session update types
// ---------------------------------------------------------------------------

export interface SessionUpdateNotification {
  jsonrpc: '2.0';
  method: 'session/update';
  params: { sessionId: string; update: SessionUpdate };
}

export type SessionUpdate = AgentMessageChunk | PlanUpdate | ToolCallUpdate | ToolCallStatusUpdate;

export interface AgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: { type: string; text: string };
}

export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: Array<{ content: string; priority: string; status: string }>;
}

export interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: string;
  content?: Array<{ type: string; content: { type: string; text: string } }>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SessionNewResult {
  sessionId: string;
  clientSessionId: string;
  modes?: unknown;
  models?: unknown;
  configOptions?: unknown;
}

export interface PromptResult {
  stopReason: string;
  updates: SessionUpdate[];
  text: string;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name: string; title?: string; version?: string };
  authMethods?: unknown[];
}

export interface ConfigOption {
  id: string;
  value: string;
}

// ---------------------------------------------------------------------------
// ACPClient interface
// ---------------------------------------------------------------------------

export interface ACPClient extends EventEmitter {
  initialize(): Promise<InitializeResult>;
  sessionNew(configOptions?: ConfigOption[]): Promise<SessionNewResult>;
  sessionPrompt(sessionId: string, text: string, role?: string): Promise<PromptResult>;
  sessionConfigure(sessionId: string, options: ConfigOption[]): Promise<void>;
  sessionCancel(sessionId: string): void;
  /** Send a JSON-RPC response to an incoming request (e.g. permission request). */
  sendResponse(id: string | number, result: unknown): void;
  /** Send a JSON-RPC error response to an incoming request. */
  sendErrorResponse(id: string | number, code: number, message: string): void;
  readonly requestTracker: RequestTracker;
}

export interface PermissionRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export type PermissionHandler = (request: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;

export interface PermissionResponse {
  approved: boolean;
  option?: string;
}

export interface ACPClientOptions {
  agentId: string;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title?: string; version?: string };
  clientSessionId?: string;
  /** Handler for incoming permission requests. Defaults to auto-approve. */
  permissionHandler?: PermissionHandler;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createACPClient(ndjsonClient: NDJSONClient, opts: ACPClientOptions): ACPClient {
  const { agentId, requestTimeoutMs = 120_000, clientInfo, permissionHandler } = opts;
  const emitter = new EventEmitter();
  const requestTracker = createRequestTracker({ defaultTimeoutMs: requestTimeoutMs });

  let nextId = 1;
  const clientSessionId = opts.clientSessionId ?? `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pendingUpdates = new Map<string, SessionUpdate[]>();

  function sendResponse(id: string | number, result: unknown): void {
    if (!ndjsonClient.isConnected()) return;
    ndjsonClient.send({ jsonrpc: '2.0', id, result });
  }

  function sendErrorResponse(id: string | number, code: number, message: string): void {
    if (!ndjsonClient.isConnected()) return;
    ndjsonClient.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function handleIncomingRequest(id: string | number, method: string, params: Record<string, unknown> | undefined): Promise<void> {
    if (method === 'session/request_permission') {
      // Always emit the event so consumers can observe permission requests
      emitter.emit('permissionRequest', { id, method, params });

      // If a permissionHandler was provided, call it and send the response.
      // This is for setups where the router does NOT auto-respond and the
      // client is responsible for answering permission requests.
      // When no handler is provided, we do NOT send a response — the stdio
      // Bus router already auto-responds, and a duplicate would stall the session.
      if (permissionHandler) {
        try {
          const response = await permissionHandler({ id, method, params });
          sendResponse(id, {
            permission: response.approved ? 'granted' : 'denied',
            option: response.option ?? (response.approved ? 'approved-execpolicy-amendment' : 'denied'),
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sendErrorResponse(id, -32000, `Permission handler error: ${errMsg}`);
        }
      }
      return;
    }

    // For any other incoming request, surface it as an event
    emitter.emit('incomingRequest', id, method, params);
  }

  ndjsonClient.on('message', (msg: unknown) => {
    const obj = msg as Record<string, unknown>;
    if (!obj || obj['jsonrpc'] !== '2.0') return;

    const hasId = 'id' in obj;
    const hasMethod = 'method' in obj;
    const hasResult = 'result' in obj;
    const hasError = 'error' in obj;

    // Case 1: Response to our outgoing request (has id + result or error)
    if (hasId && (hasResult || hasError)) {
      requestTracker.resolve(obj as unknown as JsonRpcResponse);
      return;
    }

    // Case 2: Incoming request from server/agent (has id + method, no result/error)
    // These are server→client requests like session/request_permission.
    if (hasId && hasMethod && !hasResult && !hasError) {
      const id = obj['id'] as string | number;
      const method = obj['method'] as string;
      const params = obj['params'] as Record<string, unknown> | undefined;
      handleIncomingRequest(id, method, params).catch(() => {
        // Swallow — permission handler errors are already handled inside
      });
      return;
    }

    // Case 3: Notification (method present, no id)
    if (hasMethod && !hasId) {
      const method = obj['method'] as string;
      const params = obj['params'] as Record<string, unknown> | undefined;

      if (method === 'session/update' && params) {
        const sessionId = params['sessionId'] as string;
        const update = params['update'] as SessionUpdate;
        const updates = pendingUpdates.get(sessionId);
        if (updates) updates.push(update);
        emitter.emit('update', sessionId, update);
      }

      emitter.emit('notification', method, params);
    }
  });

  function send(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, agentId, sessionId: clientSessionId, params };
    const promise = requestTracker.register(id);
    ndjsonClient.send(request);
    return promise;
  }

  async function initialize(): Promise<InitializeResult> {
    const resp = await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: clientInfo ?? { name: 'acp-chat', version: '1.0.0' },
    });
    if (resp.error) throw new Error(`initialize: [${resp.error.code}] ${resp.error.message}`);
    return resp.result as InitializeResult;
  }

  async function sessionNew(configOptions?: ConfigOption[]): Promise<SessionNewResult> {
    const params: Record<string, unknown> = { cwd: process.cwd(), mcpServers: [] };
    if (configOptions?.length) params['configOptions'] = configOptions;
    const resp = await send('session/new', params);
    if (resp.error) throw new Error(`session/new: [${resp.error.code}] ${resp.error.message}`);
    return { ...(resp.result as SessionNewResult), clientSessionId };
  }

  async function sessionPrompt(sessionId: string, text: string, role = 'user'): Promise<PromptResult> {
    pendingUpdates.set(sessionId, []);
    const resp = await send('session/prompt', { sessionId, prompt: [{ type: 'text', role, text }] });
    await new Promise(resolve => setTimeout(resolve, 200));

    const updates = pendingUpdates.get(sessionId) ?? [];
    pendingUpdates.delete(sessionId);

    if (resp.error) throw new Error(`session/prompt: [${resp.error.code}] ${resp.error.message}`);

    const result = resp.result as { stopReason: string };
    const textParts: string[] = [];
    for (const u of updates) {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        textParts.push(u.content.text);
      }
      if (u.sessionUpdate === 'tool_call_update' && u.content) {
        for (const c of u.content) {
          if (c.content?.text) textParts.push(c.content.text);
        }
      }
    }

    return { stopReason: result.stopReason, updates, text: textParts.join('') };
  }

  async function sessionConfigure(sessionId: string, options: ConfigOption[]): Promise<void> {
    const resp = await send('session/configure', { sessionId, options });
    if (resp.error) throw new Error(`session/configure: [${resp.error.code}] ${resp.error.message}`);
  }

  function sessionCancel(sessionId: string): void {
    ndjsonClient.send({
      jsonrpc: '2.0' as const,
      method: 'session/cancel',
      params: { sessionId },
      agentId,
      sessionId: clientSessionId,
    });
  }

  return Object.assign(emitter, { initialize, sessionNew, sessionPrompt, sessionConfigure, sessionCancel, sendResponse, sendErrorResponse, requestTracker }) as ACPClient;
}
