/**
 * WebSocket Manager Singleton
 * Manages a single WebSocket connection with automatic reconnection,
 * subscription management, and cross-tab coordination.
 */
class WebSocketManager {
  static instance = null;

  constructor() {
    this.socket = null;
    this.subscriptions = new Map(); // channel -> Set<callback>
    this.pendingSubscriptions = new Set(); // channels to subscribe after connect
    this.connectionState = 'disconnected';
    this.stateListeners = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimeout = null;
    this.pingInterval = null;
    this.lastPong = null;
    // Dedup server-side error messages to prevent console spam
    // (e.g. repeated auth rejections across many channels). Tracks
    // "<channel>::<message>" strings already logged this session.
    this.loggedErrors = new Set();

    // Cross-tab coordination
    this.broadcastChannel = null;
    this.isLeader = false;
    this.tabId = Math.random().toString(36).substring(7);

    this.initBroadcastChannel();
  }

  static getInstance() {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  /**
   * Initialize BroadcastChannel for cross-tab coordination
   */
  initBroadcastChannel() {
    if (typeof BroadcastChannel === 'undefined') return;

    try {
      this.broadcastChannel = new BroadcastChannel('dangus-websocket');

      this.broadcastChannel.onmessage = (event) => {
        const { type, tabId, data } = event.data;

        switch (type) {
          case 'leader-announce':
            // Another tab is the leader
            if (tabId !== this.tabId) {
              this.isLeader = false;
            }
            break;
          case 'event':
            // Receive events from leader tab
            if (!this.isLeader && data.channel) {
              this.dispatchEvent(data.channel, data.payload);
            }
            break;
          case 'leader-resign':
            // Leader is closing, try to become leader
            this.tryBecomeLeader();
            break;
        }
      };

      // Try to become leader on init
      this.tryBecomeLeader();

      // Resign leadership on page unload
      window.addEventListener('beforeunload', () => {
        if (this.isLeader) {
          this.broadcastChannel?.postMessage({
            type: 'leader-resign',
            tabId: this.tabId
          });
        }
      });
    } catch (err) {
      console.warn('BroadcastChannel not available:', err);
    }
  }

  /**
   * Try to become the leader tab
   */
  tryBecomeLeader() {
    this.isLeader = true;
    this.broadcastChannel?.postMessage({
      type: 'leader-announce',
      tabId: this.tabId
    });
  }

  /**
   * Connect to the WebSocket server
   */
  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    // Only leader tab maintains the connection
    if (this.broadcastChannel && !this.isLeader) {
      return;
    }

    this.setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const backendUrl = import.meta.env.VITE_BACKEND_URL;
    const host = backendUrl?.replace(/^https?:\/\//, '') || window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    try {
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
        console.log('[WebSocket] Connected');
        this.setConnectionState('connected');
        this.reconnectAttempts = 0;

        // Subscribe to pending channels
        for (const channel of this.pendingSubscriptions) {
          this.sendSubscribe(channel);
        }
        this.pendingSubscriptions.clear();

        // Re-subscribe to existing channels
        for (const channel of this.subscriptions.keys()) {
          this.sendSubscribe(channel);
        }

        // Start ping interval
        this.startPing();
      };

      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (err) {
          console.error('[WebSocket] Failed to parse message:', err);
        }
      };

      this.socket.onclose = (event) => {
        console.log('[WebSocket] Disconnected:', event.code, event.reason);
        this.cleanup();

        if (event.code !== 4001) { // Not auth error
          this.scheduleReconnect();
        } else {
          this.setConnectionState('disconnected');
        }
      };

      this.socket.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
      };
    } catch (err) {
      console.error('[WebSocket] Failed to connect:', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect() {
    this.cleanup();
    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }
    this.setConnectionState('disconnected');
  }

  /**
   * Clean up timers and state
   */
  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WebSocket] Max reconnect attempts reached');
      this.setConnectionState('failed');
      return;
    }

    this.setConnectionState('reconnecting');

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * Start ping interval to keep connection alive
   */
  startPing() {
    this.pingInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping', id: Date.now().toString() }));
      }
    }, 30000);
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(message) {
    const { type, channel, payload, timestamp } = message;

    switch (type) {
      case 'welcome':
        console.log('[WebSocket] Received welcome message');
        break;
      case 'subscribed':
        console.log('[WebSocket] Subscribed to:', channel);
        break;
      case 'unsubscribed':
        console.log('[WebSocket] Unsubscribed from:', channel);
        break;
      case 'event':
        this.dispatchEvent(channel, payload, timestamp);
        // Broadcast to other tabs
        this.broadcastChannel?.postMessage({
          type: 'event',
          tabId: this.tabId,
          data: { channel, payload, timestamp }
        });
        break;
      case 'pong':
        this.lastPong = Date.now();
        break;
      case 'error': {
        // Dedup repeated server errors (e.g. auth rejections fired once
        // per subscribed channel). Log each unique (channel, message)
        // pair once per session; silently drop repeats.
        const errKey = `${channel || '*'}::${message.error}`;
        if (!this.loggedErrors.has(errKey)) {
          this.loggedErrors.add(errKey);
          console.error('[WebSocket] Server error:', message.error,
            channel ? `(channel: ${channel})` : '');
        }
        break;
      }
    }
  }

  /**
   * Dispatch event to all subscribers
   */
  dispatchEvent(channel, payload, timestamp) {
    const callbacks = this.subscriptions.get(channel);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback({ channel, payload, timestamp });
        } catch (err) {
          console.error('[WebSocket] Callback error:', err);
        }
      }
    }
  }

  /**
   * Subscribe to a channel
   * @param {string} channel - Channel to subscribe to
   * @param {function} callback - Callback for events
   * @returns {function} Unsubscribe function
   */
  subscribe(channel, callback) {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel).add(callback);

    // Send subscribe message if connected
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(channel);
    } else {
      this.pendingSubscriptions.add(channel);
    }

    // Return unsubscribe function
    return () => {
      const callbacks = this.subscriptions.get(channel);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscriptions.delete(channel);
          this.sendUnsubscribe(channel);
        }
      }
    };
  }

  /**
   * Send subscribe message to server
   */
  sendSubscribe(channel) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'subscribe',
        id: Date.now().toString(),
        channel
      }));
    }
  }

  /**
   * Send unsubscribe message to server
   */
  sendUnsubscribe(channel) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'unsubscribe',
        id: Date.now().toString(),
        channel
      }));
    }
  }

  /**
   * Set connection state and notify listeners
   */
  setConnectionState(state) {
    if (this.connectionState === state) return;

    this.connectionState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[WebSocket] State listener error:', err);
      }
    }
  }

  /**
   * Add a connection state listener
   * @param {function} listener - Callback for state changes
   * @returns {function} Remove listener function
   */
  addStateListener(listener) {
    this.stateListeners.add(listener);
    // Immediately call with current state
    listener(this.connectionState);

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Get current connection state
   */
  getConnectionState() {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connectionState === 'connected';
  }
}

export default WebSocketManager;
export { WebSocketManager };
