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
// ACP Chat — NDJSON Framing
// ============================================================================

export function serializeNdjson(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (json === undefined) {
    throw new TypeError('Value is not JSON-serializable');
  }
  return json + '\n';
}

export function deserializeNdjsonLine(line: string): unknown {
  return JSON.parse(line);
}
