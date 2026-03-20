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
// ACP Chat — Request Tracker
// ============================================================================

import type { JsonRpcId, JsonRpcResponse, PendingEntry } from './types.js';
import { CapacityExceededError, RequestTimeoutError } from './errors.js';

export interface RequestTrackerOptions {
  maxPending: number;
  defaultTimeoutMs: number;
}

const DEFAULT_OPTIONS: RequestTrackerOptions = {
  maxPending: 4096,
  defaultTimeoutMs: 30_000,
};

const MIN_TIMEOUT_MS = 1000;

export interface RequestTracker {
  register(id: JsonRpcId, timeoutMs?: number): Promise<JsonRpcResponse>;
  resolve(response: JsonRpcResponse): boolean;
  cancelAll(reason: Error): void;
  pendingCount(): number;
  hasPending(id: JsonRpcId): boolean;
}

export function createRequestTracker(opts?: Partial<RequestTrackerOptions>): RequestTracker {
  const options: RequestTrackerOptions = { ...DEFAULT_OPTIONS, ...opts };

  if (options.defaultTimeoutMs < MIN_TIMEOUT_MS) {
    options.defaultTimeoutMs = MIN_TIMEOUT_MS;
  }

  const pending = new Map<JsonRpcId, PendingEntry>();

  function register(id: JsonRpcId, timeoutMs?: number): Promise<JsonRpcResponse> {
    if (pending.size >= options.maxPending) {
      return Promise.reject(
        new CapacityExceededError(`Maximum pending requests (${options.maxPending}) exceeded`)
      );
    }

    let effectiveTimeout = timeoutMs ?? options.defaultTimeoutMs;
    if (effectiveTimeout < MIN_TIMEOUT_MS) {
      effectiveTimeout = MIN_TIMEOUT_MS;
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pending.delete(id);
        reject(new RequestTimeoutError(`Request ${String(id)} timed out after ${effectiveTimeout}ms`, { id, timeoutMs: effectiveTimeout }));
      }, effectiveTimeout);

      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }

      pending.set(id, { id, registeredAt: Date.now(), timeoutMs: effectiveTimeout, timeoutHandle, resolve, reject });
    });
  }

  function resolve(response: JsonRpcResponse): boolean {
    const entry = pending.get(response.id);
    if (!entry) return false;
    clearTimeout(entry.timeoutHandle);
    pending.delete(response.id);
    entry.resolve(response);
    return true;
  }

  function cancelAll(reason: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(reason);
    }
    pending.clear();
  }

  return { register, resolve, cancelAll, pendingCount: () => pending.size, hasPending: (id) => pending.has(id) };
}
