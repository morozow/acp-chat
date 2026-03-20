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
// ACP Chat — Public API
// ============================================================================

export { NDJSONClient, type NDJSONClientOptions, type NDJSONClientEvents } from './ndjson-client.js';
export { createACPClient, type ACPClient, type ACPClientOptions, type SessionUpdate, type SessionNewResult, type PromptResult, type InitializeResult, type ConfigOption, type AgentMessageChunk, type PlanUpdate, type ToolCallUpdate, type ToolCallStatusUpdate } from './acp-client.js';
export { createRequestTracker, type RequestTracker, type RequestTrackerOptions } from './request-tracker.js';
export { DisconnectedError, CapacityExceededError, RequestTimeoutError, ACPError, ErrorCodes } from './errors.js';
export type { JsonRpcId, JsonRpcResponse, JsonRpcError, ConnectionState } from './types.js';
