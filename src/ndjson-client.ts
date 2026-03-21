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
// ACP Chat — NDJSON Client (TCP/Unix Socket Transport)
// ============================================================================

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { serializeNdjson, deserializeNdjsonLine } from './ndjson.js';
import { DisconnectedError } from './errors.js';
import type { ConnectionState } from './types.js';

/**
 * Interface representing the options for the NDJSON client configuration.
 */
export interface NDJSONClientOptions {

  /**
   * Represents a physical or virtual location identifier.
   * This variable is used to store an address, which could be in various formats such as a street address, email address, or network address.
   */
  address: string;

  /**
   * Specifies the type of connection to establish.
   *
   * The `connectionType` variable can take one of two possible string values:
   * - `'tcp'`: Represents a Transmission Control Protocol connection, typically used for network communications over IP.
   * - `'unix'`: Represents a Unix domain socket connection, commonly used for inter-process communication on the same host.
   */
  connectionType: 'tcp' | 'unix';

  /**
   * The `maxReconnectAttempts` variable represents the maximum number of reconnection attempts that can be made in case of a disconnection.
   * It is used to limit the number of times a reconnection process will be retried before giving up.
   * This number is typically set based on the requirements for network reliability and performance.
   */
  maxReconnectAttempts: number;

  /**
   * The baseReconnectDelayMs variable represents the initial delay in milliseconds before attempting to reconnect after a disconnection event occurs.
   * It is used to set a foundational time duration for the reconnection logic, which may be adjusted by multiplying factors to implement exponential backoff strategies.
   * This value is crucial in controlling the frequency and interval of reconnection attempts, ensuring a balance between rapid reconnection and resource consumption.
   */
  baseReconnectDelayMs: number;

  /**
   * Represents the maximum delay, in milliseconds, before attempting to reconnect.
   * This is used in networking or data communication contexts where repeated connection
   * attempts are necessary after a disconnection. By setting a maximum reconnect delay,
   * the application ensures that attempts to re-establish a connection do not exceed
   * a specified threshold, potentially improving system responsiveness and user experience.
   */
  maxReconnectDelayMs: number;
}

export interface NDJSONClientEvents {
  message: (msg: unknown) => void;
  error: (err: Error) => void;
  disconnect: () => void;
  reconnect: (attempt: number) => void;
  framingError: (line: string, err: Error) => void;
}

export class NDJSONClient extends EventEmitter {
  private readonly opts: NDJSONClientOptions;
  private socket: net.Socket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lineBuffer = '';
  private closedByUser = false;

  constructor(opts: NDJSONClientOptions) {
    super();
    this.opts = opts;
  }

  connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(new Error('Client has been closed'));

    this.closedByUser = false;
    this.reconnectAttempt = 0;
    return this.createConnection();
  }

  send(message: unknown): void {
    if (this.state !== 'connected' || !this.socket) {
      throw new DisconnectedError('Cannot send: not connected to stdio Bus');
    }
    this.socket.write(serializeNdjson(message));
  }

  close(): Promise<void> {
    this.closedByUser = true;
    this.clearReconnectTimer();
    const prevState = this.state;
    this.state = 'closed';

    if (prevState === 'closed' || prevState === 'disconnected') return Promise.resolve();

    return new Promise<void>((resolve) => {
      if (this.socket) {
        const sock = this.socket;
        this.socket = null;
        if (sock.destroyed) { resolve(); return; }
        sock.once('close', () => resolve());
        sock.destroy();
      } else {
        resolve();
      }
    });
  }

  isConnected(): boolean { return this.state === 'connected'; }
  getState(): ConnectionState { return this.state; }

  private createConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.state = this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
      this.lineBuffer = '';

      const connectOpts = this.buildConnectOptions();
      const socket = net.createConnection(connectOpts);
      this.socket = socket;

      const onConnect = () => {
        cleanup();
        this.state = 'connected';
        this.reconnectAttempt = 0;
        this.wireSocketEvents(socket);
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        if (this.reconnectAttempt === 0 && this.state === 'connecting') {
          this.state = 'disconnected';
          reject(err);
        }
      };

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  private buildConnectOptions(): net.NetConnectOpts {
    if (this.opts.connectionType === 'unix') return { path: this.opts.address };
    const lastColon = this.opts.address.lastIndexOf(':');
    if (lastColon === -1) throw new Error(`Invalid TCP address: expected "host:port", got "${this.opts.address}"`);
    const host = this.opts.address.slice(0, lastColon);
    const port = parseInt(this.opts.address.slice(lastColon + 1), 10);
    if (isNaN(port)) throw new Error(`Invalid TCP port in address "${this.opts.address}"`);
    return { host, port };
  }

  private wireSocketEvents(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => this.handleData(chunk.toString('utf-8')));
    socket.on('error', (err: Error) => this.emit('error', err));
    socket.on('close', () => {
      if (this.closedByUser || this.state === 'closed') return;
      this.state = 'disconnected';
      this.emit('disconnect');
      this.scheduleReconnect();
    });
  }

  private handleData(data: string): void {
    this.lineBuffer += data;
    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx);
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        this.emit('message', deserializeNdjsonLine(line));
      } catch (err) {
        this.emit('framingError', line, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.state === 'closed') return;
    if (this.reconnectAttempt >= this.opts.maxReconnectAttempts) {
      this.state = 'disconnected';
      this.emit('disconnect');
      return;
    }

    this.state = 'reconnecting';
    const attempt = this.reconnectAttempt++;
    const jitter = Math.random() * this.opts.baseReconnectDelayMs;
    const delay = Math.min(this.opts.baseReconnectDelayMs * Math.pow(2, attempt) + jitter, this.opts.maxReconnectDelayMs);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.emit('reconnect', this.reconnectAttempt);
      this.attemptReconnect();
    }, delay);
  }

  private attemptReconnect(): void {
    if (this.closedByUser || this.state === 'closed') return;
    this.lineBuffer = '';
    const socket = net.createConnection(this.buildConnectOptions());
    this.socket = socket;

    socket.once('connect', () => {
      socket.removeAllListeners('error');
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this.wireSocketEvents(socket);
    });

    socket.once('error', () => {
      socket.destroy();
      this.scheduleReconnect();
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
