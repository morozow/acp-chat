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
// ACP Chat — Error Classes
// ============================================================================

export const ErrorCodes = {
  CAPACITY_EXCEEDED: -32000,
  REQUEST_TIMEOUT: -32001,
  DISCONNECTED: -32004,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ACPError extends Error {
  public readonly code: ErrorCode;
  public readonly data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'ACPError';
    this.code = code;
    this.data = data;
  }
}

export class CapacityExceededError extends ACPError {
  constructor(message = 'Capacity exceeded', data?: unknown) {
    super(ErrorCodes.CAPACITY_EXCEEDED, message, data);
    this.name = 'CapacityExceededError';
  }
}

export class RequestTimeoutError extends ACPError {
  constructor(message = 'Request timeout', data?: unknown) {
    super(ErrorCodes.REQUEST_TIMEOUT, message, data);
    this.name = 'RequestTimeoutError';
  }
}

export class DisconnectedError extends ACPError {
  constructor(message = 'Disconnected', data?: unknown) {
    super(ErrorCodes.DISCONNECTED, message, data);
    this.name = 'DisconnectedError';
  }
}
