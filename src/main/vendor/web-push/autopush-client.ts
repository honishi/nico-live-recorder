import { pushDiagnostics, pushLog, shortVersion } from './push-diagnostics';

// Type definitions
interface HelloResponse {
  messageType: string;
  status: number;
  uaid: string;
  use_webpush?: boolean;
}

interface RegisterMessage {
  messageType: string;
  channelID: string;
  key?: string;
}

interface RegisterResponse {
  messageType: string;
  status: number;
  channelID: string;
  pushEndpoint?: string;
}

interface NotificationMessage {
  messageType?: string;
  channelID?: string;
  version?: number;
  data?: string;
  headers?: Record<string, unknown>;
}

interface MessageData {
  messageType?: string;
  status?: number;
  uaid?: string;
  use_webpush?: boolean;
  channelID?: string;
  pushEndpoint?: string;
  version?: number;
  data?: string;
  headers?: Record<string, unknown>;
}

/**
 * AutoPush (Mozilla Push Service) client
 * Receives Push notifications via WebSocket
 */
export class AutoPushClient {
  // WebSocket related
  private ws?: WebSocket;
  private readonly endpoint: string;

  // Connection state management
  private isConnected = false;
  private intentionalDisconnect = false;

  // Reconnection management
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 2025; // roughly 1 week of retries (capped at 5 min interval)
  private reconnectDelay = 1000; // ms
  private maxReconnectDelay = 300000; // ms
  private reconnectTimer?: NodeJS.Timeout;
  private stateCheckInterval?: NodeJS.Timeout;

  // Connect rate limiting
  private connectCallTimestamps: number[] = [];
  private readonly maxConnectCallsPerHour = 100;
  private lastConnectedAt?: Date;

  // Liveness watchdog (half-open connection detection)
  private lastActivityAt = Date.now();
  private lastLivenessPingAt = 0;
  private pongTimer?: NodeJS.Timeout;
  private readonly idlePingThresholdMs = 2 * 60 * 1000; // ping after 2 min without inbound traffic
  private readonly pongTimeoutMs = 10 * 1000; // reconnect if no reply within 10 s
  private readonly minLivenessPingIntervalMs = 60 * 1000; // AutoPush forbids pings more often than 1/min

  // Canary self-push probe (desync detection).
  // A key-less channel registered on this client's UAID yields an endpoint
  // the extension can POST to itself; the push must come back as a
  // notification on this socket within seconds because it travels the real
  // per-user delivery path (routing record -> connection node -> socket).
  // No reply to an accepted POST means the server lost this connection's
  // routing entry (session desync) - invisible to close events and pings.
  private canaryChannelId?: string;
  private canaryEndpoint?: string;
  private probeTicker?: NodeJS.Timeout;
  private probeTimeoutTimer?: NodeJS.Timeout;
  private pendingProbe?: { sentAt: number; attempt: number; controller: AbortController };
  private lastProbeMissReconnectAt = 0;
  private readonly canaryProbeIntervalMs = 60 * 1000;
  private readonly canaryProbeTimeoutMs = 10 * 1000;
  private readonly maxCanaryProbeAttempts = 2; // one immediate retry before declaring desync
  private readonly probeMissReconnectCooldownMs = 5 * 60 * 1000; // failure budget for probe-triggered reconnects

  // Test utilities
  private testAutoCloseTimer?: NodeJS.Timeout;
  private testAutoCloseMs?: number;

  // Authentication and channel management
  private uaid?: string;
  private channelIds: string[] = [];
  private pendingChannelIds?: string[];
  private lastHelloSentUaid?: string; // For diagnostics: detect server-side UAID rotation
  // A new UAID in response to a HELLO for a saved UAID means every endpoint
  // registered under the old UAID is no longer usable. Keep the socket open
  // for diagnostics, but surface that user-initiated re-registration is needed.
  private subscriptionRepairRequired = false;

  // Message handlers
  private messageHandlers: Map<string, (data: unknown) => void> = new Map();

  // Async operation management
  private pendingOperations: Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  > = new Map();

  constructor(endpoint: string = 'wss://push.services.mozilla.com') {
    this.endpoint = endpoint;
  }

  // ==================== Public Methods (Status Check) ====================

  /**
   * Check connection status
   */
  isConnectionOpen(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Whether AutoPush reassigned the saved UAID, invalidating its endpoints.
   */
  isSubscriptionRepairRequired(): boolean {
    return this.subscriptionRepairRequired;
  }

  /**
   * Return WebSocket connection state
   */
  get connectionState(): string {
    if (!this.ws) return 'NO_SOCKET';
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return states[this.ws.readyState];
  }

  /**
   * Enable test auto-close after given minutes (default: 1)
   * Call before connect(). For testing only.
   */
  enableTestAutoClose(minutes = 1): void {
    this.testAutoCloseMs = minutes * 60 * 1000;
  }

  /**
   * Get WebSocket connection status label
   */
  getConnectionStatusLabel(): string {
    if (!this.ws) return 'NO_SOCKET';
    if (this.subscriptionRepairRequired) return 'REPAIR_REQUIRED';
    if (this.ws.readyState === WebSocket.OPEN && this.uaid) return 'AUTHENTICATED';
    if (this.ws.readyState === WebSocket.OPEN) return 'CONNECTED';
    if (this.ws.readyState === WebSocket.CONNECTING) return 'CONNECTING';
    if (this.ws.readyState === WebSocket.CLOSING) return 'CLOSING';
    return 'CLOSED';
  }

  /**
   * Get UAID
   */
  getUaid(): string | undefined {
    return this.uaid;
  }

  /**
   * Get list of registered channel IDs
   */
  getChannelIds(): string[] {
    return [...this.channelIds];
  }

  /**
   * Get connection metrics including rate limit info
   */
  getConnectionStatus(): {
    currentAttempts: number;
    maxAttempts: number;
    lastAttemptTime?: Date;
    lastConnectedTime?: Date;
  } {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Filter for attempts within the last hour
    const recentAttempts = this.connectCallTimestamps.filter((ts) => ts > oneHourAgo);

    // Get the most recent attempt time
    const lastAttemptTime =
      this.connectCallTimestamps.length > 0
        ? new Date(Math.max(...this.connectCallTimestamps))
        : undefined;

    return {
      currentAttempts: recentAttempts.length,
      maxAttempts: this.maxConnectCallsPerHour,
      lastAttemptTime,
      lastConnectedTime: this.lastConnectedAt,
    };
  }

  // ==================== Public Methods (Connection Management) ====================

  /**
   * Connect to Mozilla Push Service
   */
  async connect(): Promise<void> {
    // Check connect rate limit before proceeding
    this.checkAndEnforceConnectRateLimit();

    // Skip if already connecting or connected
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      pushLog.debug('WebSocket already connecting or connected');

      // Wait for connection to complete. Must settle in every case: the
      // socket can also go CLOSING/CLOSED here, and an unsettled promise
      // would leave the caller (and its reconnection chain) hanging forever
      if (this.ws.readyState === WebSocket.CONNECTING) {
        const CONNECT_WAIT_TIMEOUT_MS = 15000;
        await new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const checkInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              clearInterval(checkInterval);
              resolve();
            } else if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) {
              clearInterval(checkInterval);
              reject(new Error('WebSocket closed while waiting for connection'));
            } else if (Date.now() - startedAt > CONNECT_WAIT_TIMEOUT_MS) {
              clearInterval(checkInterval);
              reject(new Error('Timed out waiting for WebSocket connection'));
            }
          }, 100);
        });
      }
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        pushLog.debug(`Connecting to AutoPush service: ${this.endpoint}`);
        // Capture the socket so every handler can verify it still owns the
        // shared state; a handler firing late on a replaced (stale) socket
        // must not mutate the current connection or trigger reconnection
        const socket = new WebSocket(this.endpoint);
        this.ws = socket;

        // A socket stuck in CONNECTING would leave this promise (and any
        // lifecycle operation awaiting it) pending forever; bound it
        const CONNECT_TIMEOUT_MS = 15000;
        const connectTimer = setTimeout(() => {
          pushLog.error('[AutoPush] WebSocket connect timed out');
          try {
            socket.close();
          } catch (e) {
            pushLog.error('[AutoPush] Failed to close timed-out socket:', e);
          }
          reject(new Error('WebSocket connect timeout'));
        }, CONNECT_TIMEOUT_MS);

        socket.onopen = () => {
          clearTimeout(connectTimer);
          if (this.ws !== socket) {
            // Superseded while connecting; abandon this socket
            try {
              socket.close();
            } catch (e) {
              pushLog.error('[AutoPush] Failed to close superseded socket:', e);
            }
            reject(new Error('WebSocket superseded during connect'));
            return;
          }
          pushLog.debug('[AutoPush] ✅ WebSocket OPENED');
          pushLog.debug('[AutoPush] Connected to:', this.endpoint);
          pushDiagnostics.record('ws_open');
          this.isConnected = true;
          this.lastConnectedAt = new Date();
          this.lastActivityAt = Date.now();

          // Clear and reset state check timer
          if (this.stateCheckInterval) {
            clearInterval(this.stateCheckInterval);
          }
          this.stateCheckInterval = setInterval(() => {
            if (this.ws) {
              const state = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.ws.readyState];
              pushLog.debug(
                `[AutoPush] WebSocket state check: ${state} (${new Date().toISOString()})`,
              );
            }
            this.checkLiveness();
          }, 30000); // Every 30 seconds

          resolve();
        };

        socket.onmessage = (event) => {
          if (this.ws !== socket) {
            return;
          }
          // Any inbound traffic proves the connection is alive
          this.lastActivityAt = Date.now();
          clearTimeout(this.pongTimer);
          this.pongTimer = undefined;
          try {
            const message = JSON.parse(event.data);
            pushLog.debug(
              '[AutoPush] ← Received',
              message.messageType ? message.messageType.toUpperCase() : 'UNKNOWN',
              ':',
              message,
            );
            this.handleMessage(message);
          } catch (error) {
            pushLog.error('[AutoPush] Failed to parse message:', error);
          }
        };

        socket.onerror = (error) => {
          clearTimeout(connectTimer);
          pushLog.error('[AutoPush] ❌ WebSocket ERROR:', error);
          pushDiagnostics.record('ws_error');
          if (this.ws === socket) {
            this.isConnected = false;
          }
          // Always settle this connect attempt's promise
          reject(error);
        };

        socket.onclose = (event) => {
          clearTimeout(connectTimer);
          // Settle the connect promise if it is still pending (no-op once
          // resolved): a socket closed while CONNECTING would otherwise
          // leave the awaiting caller hanging forever
          reject(new Error('WebSocket closed during connect'));
          if (this.ws !== socket) {
            return;
          }
          pushLog.debug('[AutoPush] ❌ WebSocket CLOSED');
          pushLog.debug('[AutoPush] Close details:', {
            code: event.code,
            reason: event.reason || '(no reason provided)',
            wasClean: event.wasClean,
          });
          pushDiagnostics.record('ws_close', {
            code: event.code,
            reason: event.reason || undefined,
            wasClean: event.wasClean,
            intentional: this.intentionalDisconnect,
          });
          this.isConnected = false;
          this.handleDisconnect();
        };
      } catch (error) {
        pushLog.error('[AutoPush] Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect connection
   */
  disconnect(): void {
    // Clear existing timers
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = undefined;
    clearTimeout(this.testAutoCloseTimer);
    this.testAutoCloseTimer = undefined;
    this.clearSessionTimers();

    if (this.ws) {
      pushLog.debug('[AutoPush] Disconnecting WebSocket...');
      this.intentionalDisconnect = true; // Set intentional disconnect flag
      this.reconnectAttempts = this.maxReconnectAttempts; // Additional protection

      // Remove event listeners before disconnecting
      this.ws.close();
      this.ws = undefined;
    }

    // Reset state
    this.isConnected = false;
    this.uaid = undefined;
    this.channelIds = [];
    this.subscriptionRepairRequired = false;
    this.pendingOperations.clear();
  }

  /**
   * Configure the canary self-push probe. The channel must be registered
   * key-less on this client's UAID so its endpoint accepts unauthenticated
   * TTL:0 POSTs. Probing starts with the next successful HELLO, or
   * immediately when the session is already authenticated.
   */
  configureCanaryProbe(channelId: string, endpoint: string): void {
    this.canaryChannelId = channelId;
    this.canaryEndpoint = endpoint;
    if (this.isConnectionOpen() && this.uaid && !this.subscriptionRepairRequired) {
      this.startCanaryProbeTimer();
    }
  }

  /**
   * Drop the current socket and rebuild the session through the normal
   * reconnection chain. Public for session resync: when canary channel
   * bookkeeping fails partway, a fresh HELLO realigns the server-side
   * channel record with the client's list.
   */
  restartSession(): void {
    this.forceReconnect();
  }

  // ==================== Public Methods (Message Sending) ====================

  /**
   * Send HANDSHAKE
   */
  async sendHello(uaid?: string, channelIds?: string[]): Promise<HelloResponse> {
    const hello = {
      messageType: 'hello',
      uaid: uaid || '',
      channelIDs: channelIds || [],
      use_webpush: true,
    };

    pushLog.debug('[AutoPush] → Sending HELLO:', JSON.stringify(hello));

    // Save channelIds for use in handleHello
    this.pendingChannelIds = channelIds || [];
    this.lastHelloSentUaid = uaid || undefined;

    return new Promise((resolve, reject) => {
      // Set up one-time handler for hello response
      const originalHandler = this.messageHandlers.get('hello');
      let timeoutTimer: NodeJS.Timeout | undefined;

      // Remove our wrapper only if it is still the registered handler;
      // a newer sendHello may have replaced it in the meantime
      const restoreHandler = () => {
        if (this.messageHandlers.get('hello') !== helloHandler) {
          return;
        }
        if (originalHandler) {
          this.messageHandlers.set('hello', originalHandler);
        } else {
          this.messageHandlers.delete('hello');
        }
      };

      const helloHandler = (response: unknown) => {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
        restoreHandler();
        resolve(response as HelloResponse);
      };
      this.messageHandlers.set('hello', helloHandler);

      // Send hello message
      this.sendMessage(hello, 'HELLO');

      // Timeout after 10 seconds
      timeoutTimer = setTimeout(() => {
        restoreHandler();
        reject(new Error('Hello response timeout'));
      }, 10000);
    });
  }

  /**
   * Register channel
   */
  async registerChannel(channelId: string, publicKey?: string): Promise<RegisterResponse> {
    const register: RegisterMessage = {
      messageType: 'register',
      channelID: channelId,
    };

    // Add public key for WebPush
    if (publicKey) {
      register.key = publicKey;
    }

    pushLog.debug('[AutoPush] → Sending REGISTER:', JSON.stringify(register));

    return new Promise((resolve, reject) => {
      // Store the resolver for this channel registration
      this.pendingOperations.set(`register_${channelId}`, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
      });

      // Send register message
      this.sendMessage(register, 'REGISTER');

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingOperations.has(`register_${channelId}`)) {
          this.pendingOperations.delete(`register_${channelId}`);
          reject(new Error('Register response timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Unregister channel
   */
  async unregisterChannel(channelId: string): Promise<void> {
    const unregister = {
      messageType: 'unregister',
      channelID: channelId,
    };

    pushLog.debug('[AutoPush] → Sending UNREGISTER:', JSON.stringify(unregister));
    this.sendMessage(unregister, 'UNREGISTER');

    // Remove from local list
    this.channelIds = this.channelIds.filter((id) => id !== channelId);
  }

  /**
   * Manually send PING (for debugging)
   */
  sendPing(): void {
    if (this.isConnected && this.ws) {
      // Check if authenticated
      if (!this.uaid) {
        pushLog.debug('[AutoPush] Cannot send PING: not authenticated (no UAID)');
        return;
      }
      pushLog.debug('[AutoPush] Manually sending PING');
      this.sendMessage({}, 'PING');
    } else {
      pushLog.debug('[AutoPush] Cannot send PING: not connected');
    }
  }

  // ==================== Public Methods (Event Registration) ====================

  /**
   * Register message handler
   */
  onMessage(type: string, handler: (data: unknown) => void): void {
    this.messageHandlers.set(type, handler);
  }

  // ==================== Private Methods (Sending) ====================

  /**
   * Send message
   */
  private sendMessage(message: unknown, type: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(message);
      pushLog.debug(`[AutoPush] → Sending ${type}:`, payload);
      this.ws.send(payload);
    } else {
      pushLog.error(`[AutoPush] Cannot send ${type}: WebSocket not open`);
    }
  }

  // ==================== Private Methods (Receiving) ====================

  /**
   * Process received message
   */
  private handleMessage(message: MessageData): void {
    const messageType =
      message.messageType || (Object.keys(message).length === 0 ? 'pong' : 'ping');

    pushLog.debug('[AutoPush] Processing message type:', messageType);
    pushLog.debug('[AutoPush] Message keys:', Object.keys(message));

    // Internal processing
    switch (messageType) {
      case 'hello':
        this.handleHello(message as HelloResponse);
        break;
      case 'register':
        this.handleRegister(message as RegisterResponse);
        break;
      case 'notification':
        this.handleNotification(message);
        break;
      case 'ping':
        this.handlePing();
        break;
      case 'pong':
        this.handlePong();
        break;
    }

    // Canary probe notifications are internal to this client and must not
    // reach the push pipeline
    if (
      messageType === 'notification' &&
      this.canaryChannelId &&
      message.channelID === this.canaryChannelId
    ) {
      return;
    }

    // Execute custom handler if exists
    const handler = this.messageHandlers.get(messageType);
    if (handler) {
      handler(message);
    }
  }

  // ==================== Private Methods (Various Handlers) ====================

  /**
   * Process Hello response
   */
  private handleHello(message: HelloResponse): void {
    const uaidChanged = !!(
      this.lastHelloSentUaid &&
      message.uaid &&
      this.lastHelloSentUaid !== message.uaid
    );
    pushDiagnostics.record('hello_result', {
      status: message.status,
      uaid: message.uaid,
      sentUaid: this.lastHelloSentUaid,
      uaidChanged,
      channelCount: this.pendingChannelIds?.length ?? 0,
    });

    // If UAID is expired (409 Conflict or 410 Gone)
    if (message.status === 409 || message.status === 410) {
      pushLog.warn(
        '[AutoPush] UAID expired (status:',
        message.status,
        '), disconnecting. Please turn push notifications off and on again',
      );

      // Pass error message to handler before disconnecting
      const handler = this.messageHandlers.get('hello');
      if (handler) {
        // Return with error status
        handler(message);
      }

      // Explicitly disconnect to prevent further connection attempts
      this.disconnect();
      return;
    }

    if (message.status !== 200) {
      pushLog.warn('[AutoPush] Hello failed:', message);
      this.pendingChannelIds = undefined;
      return;
    }

    // Process handshake response
    this.uaid = message.uaid;

    if (uaidChanged) {
      pushLog.warn(
        '[AutoPush] Server reassigned the UAID; saved push endpoints require user-initiated repair',
      );
      this.subscriptionRepairRequired = true;
      // The saved channels belong to the old UAID. Reporting them as restored
      // would make the popup claim a healthy subscription while no endpoint
      // can deliver to this new session.
      this.channelIds = [];
      this.clearSessionTimers();
    }

    // Restore channelIds sent in sendHello
    if (
      !this.subscriptionRepairRequired &&
      this.pendingChannelIds &&
      this.pendingChannelIds.length > 0
    ) {
      this.channelIds = [...this.pendingChannelIds];
      pushLog.debug('[AutoPush] Restored channel IDs from HELLO:', this.channelIds);
    }
    // Cleanup
    this.pendingChannelIds = undefined;

    // Send initial PING after HELLO completion (bound to this socket so a
    // stale timer cannot ping a replacement connection)
    const helloSocket = this.ws;
    setTimeout(() => {
      if (this.isConnected && this.ws === helloSocket) {
        pushLog.debug('[AutoPush] Sending initial PING to activate connection');
        this.sendPing();
      }
    }, 1000);

    // Consider the connection stable only after successful HELLO
    this.reconnectAttempts = 0;

    // Watch the fresh session for routing desync
    if (!this.subscriptionRepairRequired) {
      this.startCanaryProbeTimer();
    }

    // Test: auto-close WebSocket after configured delay
    if (this.testAutoCloseMs) {
      if (this.testAutoCloseTimer) {
        clearTimeout(this.testAutoCloseTimer);
        this.testAutoCloseTimer = undefined;
      }
      this.testAutoCloseTimer = setTimeout(() => {
        pushLog.debug(
          `
[AutoPush][TEST] Auto-closing WebSocket after ${this.testAutoCloseMs}ms (post-HELLO)`,
        );
        try {
          this.ws?.close(1000, 'Test auto-close');
        } catch (e) {
          pushLog.error('[AutoPush][TEST] Failed to auto-close WebSocket:', e);
        }
      }, this.testAutoCloseMs);
    }

    pushLog.debug('[AutoPush] Hello successful');
    pushLog.debug('  UAID:', this.uaid);
    pushLog.debug('  use_webpush:', message.use_webpush);
  }

  /**
   * Process Register response
   */
  private handleRegister(message: RegisterResponse): void {
    pushLog.debug('[AutoPush] Register response received:');
    pushLog.debug('  Status:', message.status);
    pushLog.debug('  Channel ID:', message.channelID);
    pushLog.debug('  Push Endpoint:', message.pushEndpoint);
    pushLog.debug('  Full response:', JSON.stringify(message));

    const channelId = message.channelID;
    const operationKey = `register_${channelId}`;

    pushDiagnostics.record('register_result', {
      status: message.status,
      channelId,
      hasEndpoint: !!message.pushEndpoint,
    });

    if (message.status === 200 && message.pushEndpoint) {
      // Add to local channel list
      if (!this.channelIds.includes(channelId)) {
        this.channelIds.push(channelId);
      }
      pushLog.debug('[AutoPush] Registration successful');
      pushLog.debug('[AutoPush] Current channel IDs:', this.channelIds);

      // Resolve the pending promise
      const operation = this.pendingOperations.get(operationKey);
      if (operation) {
        operation.resolve(message);
        this.pendingOperations.delete(operationKey);
      }
    } else {
      pushLog.error('[AutoPush] Registration failed:', message);
      // Reject the pending promise
      const operation = this.pendingOperations.get(operationKey);
      if (operation) {
        operation.reject(new Error(`Registration failed: ${message.status}`));
        this.pendingOperations.delete(operationKey);
      }
    }
  }

  /**
   * Process notification message
   */
  private handleNotification(message: NotificationMessage): void {
    if (this.canaryChannelId && message.channelID === this.canaryChannelId) {
      this.handleCanaryNotification(message);
      return;
    }

    pushDiagnostics.record('socket_received', {
      channelId: message.channelID,
      version: shortVersion(message.version),
      dataLength: message.data?.length ?? 0,
    });

    pushLog.debug('[AutoPush] 📬 Notification received:');
    pushLog.debug('  Channel ID:', message.channelID);
    pushLog.debug('  Version:', message.version);
    pushLog.debug('  Data:', message.data);
    pushLog.debug('  Headers:', message.headers);
    pushLog.debug('  Full message:', JSON.stringify(message));
    pushLog.debug('  Timestamp:', new Date().toISOString());

    // If there's encrypted data
    if (message.data) {
      pushLog.debug('[AutoPush] Encrypted data present, length:', message.data.length);
      pushLog.debug('[AutoPush] Data (base64):', message.data);
      // TODO: Data decryption processing
    }

    // Log header information in detail
    if (message.headers) {
      pushLog.debug('[AutoPush] Headers detail:');
      Object.keys(message.headers).forEach((key) => {
        pushLog.debug(`  ${key}: ${message.headers![key]}`);
      });
    }

    // Send ACK
    if (this.isConnected) {
      const ack = {
        messageType: 'ack',
        updates: [
          {
            channelID: message.channelID,
            version: message.version,
          },
        ],
      };
      pushLog.debug('[AutoPush] Sending ACK for notification');
      this.sendMessage(ack, 'ACK');
      pushDiagnostics.record('ack_sent', {
        channelId: message.channelID,
        version: shortVersion(message.version),
      });
    }
  }

  /**
   * Process Ping message
   */
  private handlePing(): void {
    pushLog.debug('[AutoPush] 🏓 PING received at', new Date().toISOString());
    if (this.isConnected) {
      // Send Pong message (empty JSON object)
      this.sendMessage({}, 'PONG');
    }
  }

  /**
   * Process Pong message (response to PING)
   */
  private handlePong(): void {
    pushLog.debug('[AutoPush] 🏓 PONG received at', new Date().toISOString());
    pushLog.debug('[AutoPush] Connection is alive and responsive');
  }

  // ==================== Private Methods (Connection Management) ====================

  /**
   * Check and enforce connect rate limiting
   * @throws Error if connect rate limit is exceeded
   */
  private checkAndEnforceConnectRateLimit(): void {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Remove timestamps older than 1 hour
    const oldCount = this.connectCallTimestamps.length;
    this.connectCallTimestamps = this.connectCallTimestamps.filter((ts) => ts > oneHourAgo);
    const removedCount = oldCount - this.connectCallTimestamps.length;

    // Add current timestamp
    this.connectCallTimestamps.push(now);

    // Debug logging
    pushLog.debug(
      `[AutoPush] Connect rate limit check: ${this.connectCallTimestamps.length}/${this.maxConnectCallsPerHour} connect attempts in the last hour`,
    );
    if (removedCount > 0) {
      pushLog.debug(
        `[AutoPush] Cleaned up ${removedCount} old timestamp(s) from connect rate limit tracker`,
      );
    }

    // Check if exceeding connect rate limit
    if (this.connectCallTimestamps.length > this.maxConnectCallsPerHour) {
      const errorMessage = `[AutoPush] Connect rate limit exceeded: More than ${this.maxConnectCallsPerHour} connect attempts in 1 hour`;
      pushLog.error(errorMessage);
      pushDiagnostics.record('reconnect_giveup', {
        reason: 'rate_limit',
        attemptsInLastHour: this.connectCallTimestamps.length,
      });
      throw new Error(errorMessage);
    }
  }

  /**
   * Detect half-open (zombie) connections.
   * readyState can stay OPEN long after the peer is gone; field data showed
   * such connections silently dropping every push for up to 20 minutes.
   * After idlePingThresholdMs without inbound traffic, send an
   * application-level PING; without any reply within pongTimeoutMs, drop the
   * socket and reconnect.
   */
  private checkLiveness(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.uaid) {
      return;
    }
    if (this.pongTimer) {
      return; // Ping already in flight
    }
    const idleMs = Date.now() - this.lastActivityAt;
    if (idleMs < this.idlePingThresholdMs) {
      return;
    }
    if (Date.now() - this.lastLivenessPingAt < this.minLivenessPingIntervalMs) {
      return;
    }

    this.lastLivenessPingAt = Date.now();
    pushLog.debug(`[AutoPush] Liveness ping after ${Math.round(idleMs / 1000)}s of silence`);
    pushDiagnostics.record('liveness_ping', { idleSeconds: Math.round(idleMs / 1000) });
    this.sendMessage({}, 'PING');

    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      pushLog.error('[AutoPush] Liveness ping timed out, dropping zombie connection');
      pushDiagnostics.record('liveness_reconnect', {
        idleSeconds: Math.round((Date.now() - this.lastActivityAt) / 1000),
      });
      this.forceReconnect();
    }, this.pongTimeoutMs);
  }

  /**
   * Start the periodic canary probe for the current session
   * (no-op until configureCanaryProbe provides a channel)
   */
  private startCanaryProbeTimer(): void {
    if (this.subscriptionRepairRequired || !this.canaryChannelId || !this.canaryEndpoint) {
      return;
    }
    clearInterval(this.probeTicker);
    this.probeTicker = setInterval(() => {
      void this.runCanaryProbe();
    }, this.canaryProbeIntervalMs);
  }

  /**
   * Send one canary probe: POST a TTL:0 empty-body push to the canary
   * endpoint and expect it back as a notification on this socket within
   * canaryProbeTimeoutMs. One immediate retry guards against a transient
   * hiccup; a second silence means the server-side routing entry is gone
   * (session desync), so drop the socket and reconnect - the new HELLO
   * rewrites the routing entry.
   */
  private async runCanaryProbe(attempt = 1): Promise<void> {
    if (
      this.subscriptionRepairRequired ||
      !this.canaryEndpoint ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.uaid
    ) {
      return;
    }
    if (attempt === 1 && this.pendingProbe) {
      return; // Previous probe still awaiting its notification
    }

    // Capture the socket so late completions cannot hit a replacement session
    const probeSocket = this.ws;
    const sentAt = Date.now();
    const controller = new AbortController();
    this.pendingProbe = { sentAt, attempt, controller };
    pushLog.debug(`[AutoPush] Canary probe POST (attempt ${attempt})`);

    // The deadline covers the whole POST-to-notification round trip and is
    // armed BEFORE the fetch: a hanging HTTP request must not be able to
    // wedge the probe forever, so the deadline also aborts it
    this.probeTimeoutTimer = setTimeout(() => {
      this.probeTimeoutTimer = undefined;
      controller.abort();
      if (this.ws !== probeSocket || this.pendingProbe?.sentAt !== sentAt) {
        return;
      }
      this.pendingProbe = undefined;
      if (attempt < this.maxCanaryProbeAttempts) {
        pushLog.warn('[AutoPush] Canary probe unanswered, retrying immediately');
        void this.runCanaryProbe(attempt + 1);
        return;
      }
      if (Date.now() - this.lastProbeMissReconnectAt < this.probeMissReconnectCooldownMs) {
        // Failure budget: repeated misses right after a probe-triggered
        // reconnect must not become a reconnect storm; polling remains the
        // safety net until the cooldown passes
        pushLog.error('[AutoPush] Canary probe missed again within cooldown, not reconnecting');
        pushDiagnostics.record('probe_miss', { attempts: attempt, suppressed: true });
        return;
      }
      this.lastProbeMissReconnectAt = Date.now();
      pushLog.error('[AutoPush] Canary probe unanswered twice: session desync, reconnecting');
      pushDiagnostics.record('probe_miss', { attempts: attempt });
      this.forceReconnect();
    }, this.canaryProbeTimeoutMs);

    let status: number;
    try {
      const response = await fetch(this.canaryEndpoint, {
        method: 'POST',
        headers: { TTL: '0' },
        signal: controller.signal,
      });
      status = response.status;
    } catch (error) {
      if (controller.signal.aborted) {
        return; // The deadline or session cleanup owns this probe's outcome
      }
      // A failed POST proves nothing about this socket's delivery path
      pushLog.warn('[AutoPush] Canary probe POST failed:', error);
      pushDiagnostics.record('probe_error', { error: (error as Error).message, attempt });
      if (this.pendingProbe?.sentAt === sentAt) {
        this.pendingProbe = undefined;
        clearTimeout(this.probeTimeoutTimer);
        this.probeTimeoutTimer = undefined;
      }
      return;
    }

    if (this.pendingProbe?.sentAt !== sentAt || this.ws !== probeSocket) {
      return; // Already answered by an early notification, or superseded
    }

    if (status < 200 || status >= 300) {
      // A rejected POST cannot produce a notification; cancel the deadline
      pushLog.warn('[AutoPush] Canary probe POST rejected, status:', status);
      pushDiagnostics.record('probe_error', { status, attempt });
      this.pendingProbe = undefined;
      clearTimeout(this.probeTimeoutTimer);
      this.probeTimeoutTimer = undefined;
    }
    // On 2xx the already-armed deadline now awaits the notification
  }

  /**
   * A canary notification proves the per-user delivery path is intact.
   * ACK it like any push, resolve the pending probe, and keep it out of
   * both the push pipeline and the per-message diagnostics.
   */
  private handleCanaryNotification(message: NotificationMessage): void {
    if (this.isConnected) {
      const ack = {
        messageType: 'ack',
        updates: [{ channelID: message.channelID, version: message.version }],
      };
      this.sendMessage(ack, 'ACK');
    }
    if (this.pendingProbe) {
      const latencyMs = Date.now() - this.pendingProbe.sentAt;
      pushLog.debug(`[AutoPush] Canary probe answered in ${latencyMs}ms`);
      pushDiagnostics.record('probe_ok', { latencyMs, attempt: this.pendingProbe.attempt });
      // Settle the POST if it is still in flight; the notification can
      // outrun the HTTP response
      this.pendingProbe.controller.abort();
      this.pendingProbe = undefined;
    }
    clearTimeout(this.probeTimeoutTimer);
    this.probeTimeoutTimer = undefined;
  }

  /**
   * Clear the timers scoped to the current connection session
   */
  private clearSessionTimers(): void {
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    clearInterval(this.probeTicker);
    this.probeTicker = undefined;
    clearTimeout(this.probeTimeoutTimer);
    this.probeTimeoutTimer = undefined;
    // Settle a probe POST still in flight so it cannot outlive its session
    this.pendingProbe?.controller.abort();
    this.pendingProbe = undefined;
  }

  /**
   * Drop the current socket immediately (without waiting for its close
   * event, which can take many minutes on a half-open connection) and
   * reconnect. Session timer cleanup happens in handleDisconnect, which
   * runs synchronously below.
   */
  private forceReconnect(): void {
    const staleWs = this.ws;
    if (staleWs) {
      // Detach handlers so a late close event on the dead socket cannot
      // trigger a second reconnection path
      staleWs.onopen = null;
      staleWs.onmessage = null;
      staleWs.onerror = null;
      staleWs.onclose = null;
      try {
        staleWs.close();
      } catch (e) {
        pushLog.error('[AutoPush] Failed to close stale WebSocket:', e);
      }
    }
    this.ws = undefined;
    this.isConnected = false;
    this.handleDisconnect();
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    // Session-scoped timers belong to the connection that just ended; a
    // stale pong timeout firing later must never be able to tear down the
    // next connection
    this.clearSessionTimers();

    // Don't reconnect for intentional disconnections
    if (this.intentionalDisconnect) {
      pushLog.debug('[AutoPush] Intentional disconnect, skipping reconnection');
      this.intentionalDisconnect = false;
      return;
    }

    // Idempotent: a connect failure can reach here twice for the same
    // socket (the onerror-driven reject path and the close event); the
    // first caller wins and later ones must not add attempts or timers
    if (this.reconnectTimer) {
      pushLog.debug('[AutoPush] Reconnection already scheduled, skipping');
      return;
    }

    // Save current state before reconnection (for restoration after reconnection)
    const savedUaid = this.uaid;
    const savedChannelIds = [...this.channelIds];
    pushLog.debug('[AutoPush] Saving state for reconnection:', {
      uaid: savedUaid,
      channelIds: savedChannelIds,
    });

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const rawDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      const delay = Math.min(rawDelay, this.maxReconnectDelay);

      pushLog.debug(
        `[AutoPush] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
      );
      pushDiagnostics.record('reconnect_scheduled', {
        attempt: this.reconnectAttempts,
        delayMs: delay,
      });
      if (rawDelay !== delay) {
        pushLog.debug(
          `[AutoPush] Raw backoff ${rawDelay}ms exceeded cap, using maxReconnectDelay ${this.maxReconnectDelay}ms`,
        );
      }

      this.reconnectTimer = setTimeout(async () => {
        // Mark this attempt as running so a failure can schedule the next one
        this.reconnectTimer = undefined;
        try {
          // If another path already restored an authenticated session,
          // leave it alone: a second HELLO on the same connection is a
          // protocol error and would get the socket closed
          if (this.isConnectionOpen() && this.uaid) {
            pushLog.debug('[AutoPush] Session already restored, skipping reconnect attempt');
            return;
          }

          await this.connect();
          // The socket this attempt established; if it goes away, a newer
          // attempt owns the session and this attempt must not touch it
          const attemptSocket = this.ws;

          // After successful reconnection, send HELLO with saved state
          if (this.isConnected && (savedUaid || savedChannelIds.length > 0)) {
            pushLog.debug('[AutoPush] Reconnected, restoring session with HELLO');
            try {
              const helloResponse = await this.sendHello(savedUaid, savedChannelIds);
              pushLog.debug('[AutoPush] Session restored:', helloResponse);

              // Check if channel ID has been restored
              if (this.channelIds.length === 0 && savedChannelIds.length > 0) {
                pushLog.debug('[AutoPush] Channel IDs not restored, manually restoring');
                this.channelIds = savedChannelIds;
              }
            } catch (helloError) {
              // Unauthenticated connections receive no pushes; drop the
              // socket and retry instead of waiting for a server close.
              // Only if this attempt still owns the current socket: its
              // HELLO timeout can fire long after the socket closed and a
              // newer attempt authenticated a replacement, which must not
              // be torn down (review finding)
              pushLog.error('[AutoPush] Failed to restore session:', helloError);
              if (this.ws === attemptSocket) {
                this.forceReconnect();
              }
              return;
            }
          }
        } catch (error) {
          // Keep the reconnection chain alive. Failures thrown before a
          // socket exists (e.g. the connect rate limit) produce no close
          // event, so without rescheduling here the chain would end
          // permanently. Double-scheduling is prevented by handleDisconnect
          // skipping while a reconnect is pending (this callback cleared
          // its own timer handle on entry).
          pushLog.error('[AutoPush] Reconnection failed:', error);
          this.handleDisconnect();
        }
      }, delay);
    } else {
      pushLog.error('[AutoPush] Max reconnection attempts reached');
      pushDiagnostics.record('reconnect_giveup', {
        reason: 'max_attempts',
        attempt: this.reconnectAttempts,
      });
      // No further reconnection will happen; stop the state check loop
      if (this.stateCheckInterval) {
        clearInterval(this.stateCheckInterval);
        this.stateCheckInterval = undefined;
      }
    }
  }
}
