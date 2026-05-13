import fp from 'fastify-plugin';
import wsManager from '../services/websocket-manager.js';
import appEvents from '../services/event-emitter.js';
import logger from '../services/logger.js';
import { registerService, unregisterService } from '../services/metricsCollector.js';

/**
 * WebSocket Hub Plugin
 * Provides a unified WebSocket endpoint for real-time updates.
 * Handles channel multiplexing and subscription management.
 */
async function websocketHubPlugin(fastify, options) {
  // Store database reference for authorization
  const db = fastify.db;

  /**
   * Authorize a subscription request
   * @param {string} userId - The user ID
   * @param {string} channel - The channel to subscribe to
   * @returns {Promise<boolean>} Whether authorized
   */
  async function authorizeSubscription(userId, channel) {
    const parts = channel.split(':');
    if (parts.length < 2) return false;

    const [resourceType, resourceId] = parts;

    try {
      switch (resourceType) {
        case 'deployment': {
          // Verify user owns the deployment's service's project
          const result = await db.query(
            `SELECT 1 FROM deployments d
             JOIN services s ON d.service_id = s.id
             JOIN projects p ON s.project_id = p.id
             WHERE d.id = $1 AND p.user_id = $2`,
            [resourceId, userId]
          );
          return result.rows.length > 0;
        }

        case 'service': {
          // Verify user owns the service's project
          const result = await db.query(
            `SELECT 1 FROM services s
             JOIN projects p ON s.project_id = p.id
             WHERE s.id = $1 AND p.user_id = $2`,
            [resourceId, userId]
          );
          return result.rows.length > 0;
        }

        case 'project': {
          // Verify user owns the project
          const result = await db.query(
            `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2`,
            [resourceId, userId]
          );
          return result.rows.length > 0;
        }

        case 'domain': {
          // Verify user owns the domain's service's project
          const result = await db.query(
            `SELECT 1 FROM domains d
             JOIN services s ON d.service_id = s.id
             JOIN projects p ON s.project_id = p.id
             WHERE d.id = $1 AND p.user_id = $2`,
            [resourceId, userId]
          );
          return result.rows.length > 0;
        }

        case 'user': {
          // Can only subscribe to own notifications
          return resourceId === userId;
        }

        case 'debug': {
          // Verify user owns the debug session's service's project
          const result = await db.query(
            `SELECT 1 FROM debug_sessions ds
             JOIN services s ON ds.service_id = s.id
             JOIN projects p ON s.project_id = p.id
             WHERE ds.id = $1 AND p.user_id = $2`,
            [resourceId, userId]
          );
          return result.rows.length > 0;
        }

        default:
          return false;
      }
    } catch (err) {
      logger.error('Authorization check failed', { userId, channel, error: err.message });
      return false;
    }
  }

  /**
   * Handle incoming WebSocket messages
   * @param {WebSocket} socket - The WebSocket connection
   * @param {object} message - Parsed message object
   * @param {string} userId - The authenticated user ID
   */
  async function handleMessage(socket, message, userId) {
    const { type, id, channel } = message;

    switch (type) {
      case 'subscribe': {
        if (!channel) {
          wsManager.send(socket, {
            type: 'error',
            id,
            error: 'Channel is required'
          });
          return;
        }

        const authorized = await authorizeSubscription(userId, channel);
        if (!authorized) {
          wsManager.send(socket, {
            type: 'error',
            id,
            channel,
            error: 'Not authorized to subscribe to this channel'
          });
          return;
        }

        wsManager.subscribe(socket, channel);

        // Register service for metrics collection when subscribing to metrics/health channels
        const channelParts = channel.split(':');
        if (channelParts[0] === 'service' && (channelParts[2] === 'metrics' || channelParts[2] === 'health')) {
          const serviceId = channelParts[1];
          try {
            // Get service details for metrics collection
            const serviceResult = await db.query(
              `SELECT s.id, s.name, p.name as project_name
               FROM services s
               JOIN projects p ON s.project_id = p.id
               WHERE s.id = $1`,
              [serviceId]
            );
            if (serviceResult.rows.length > 0) {
              const svc = serviceResult.rows[0];
              // Namespace is just the project name now
              registerService(serviceId, svc.project_name, svc.name, svc.project_name);
              logger.debug(`Registered service for metrics collection`, {
                serviceId,
                namespace: svc.project_name,
                serviceName: svc.name
              });
            }
          } catch (err) {
            logger.warn(`Failed to register service for metrics`, { serviceId, error: err.message });
          }
        }

        wsManager.send(socket, {
          type: 'subscribed',
          id,
          channel,
          timestamp: new Date().toISOString()
        });
        break;
      }

      case 'unsubscribe': {
        if (!channel) {
          wsManager.send(socket, {
            type: 'error',
            id,
            error: 'Channel is required'
          });
          return;
        }

        wsManager.unsubscribe(socket, channel);

        // Check if we should unregister service from metrics collection
        // Only unregister if no other subscribers for this service
        const channelParts = channel.split(':');
        if (channelParts[0] === 'service' && (channelParts[2] === 'metrics' || channelParts[2] === 'health')) {
          const serviceId = channelParts[1];
          // Check if any other clients are subscribed to this service's metrics/health
          const metricsChannel = `service:${serviceId}:metrics`;
          const healthChannel = `service:${serviceId}:health`;
          const metricsCount = wsManager.getChannelSubscriberCount(metricsChannel);
          const healthCount = wsManager.getChannelSubscriberCount(healthChannel);
          if (metricsCount === 0 && healthCount === 0) {
            unregisterService(serviceId);
            logger.debug(`Unregistered service from metrics collection`, { serviceId });
          }
        }

        wsManager.send(socket, {
          type: 'unsubscribed',
          id,
          channel,
          timestamp: new Date().toISOString()
        });
        break;
      }

      case 'ping': {
        wsManager.send(socket, {
          type: 'pong',
          id,
          timestamp: new Date().toISOString()
        });
        break;
      }

      default: {
        wsManager.send(socket, {
          type: 'error',
          id,
          error: `Unknown message type: ${type}`
        });
      }
    }
  }

  // Register WebSocket route
  fastify.get('/ws', { websocket: true }, async (connection, req) => {
    // @fastify/websocket v8 passes the raw WebSocket as first argument
    // but we name it 'connection' for clarity and get the socket
    const socket = connection.socket || connection;

    // Authenticate the connection
    // The user should already be authenticated via the session cookie
    const userId = req.user?.id;

    if (!userId) {
      try {
        socket.send(JSON.stringify({
          type: 'error',
          error: 'Authentication required',
          code: 4001
        }));
        socket.close(4001, 'Authentication required');
      } catch (err) {
        logger.error('Failed to send auth error to WebSocket', { error: err.message });
        socket.close(4001, 'Authentication required');
      }
      return;
    }

    // Register the connection
    wsManager.addConnection(socket, userId);

    // Send welcome message
    wsManager.send(socket, {
      type: 'welcome',
      timestamp: new Date().toISOString(),
      userId
    });

    // Handle incoming messages
    socket.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(socket, message, userId);
      } catch (err) {
        logger.error('Failed to parse WebSocket message', { error: err.message });
        wsManager.send(socket, {
          type: 'error',
          error: 'Invalid message format'
        });
      }
    });

    // Handle disconnection
    socket.on('close', () => {
      // Before removing connection, check if we need to unregister any services
      const channels = wsManager.getSocketChannels(socket);
      for (const channel of channels) {
        const channelParts = channel.split(':');
        if (channelParts[0] === 'service' && (channelParts[2] === 'metrics' || channelParts[2] === 'health')) {
          const serviceId = channelParts[1];
          // Check subscriber count AFTER this socket is removed
          // Subtract 1 since this socket is still in the count
          const metricsChannel = `service:${serviceId}:metrics`;
          const healthChannel = `service:${serviceId}:health`;
          const metricsCount = wsManager.getChannelSubscriberCount(metricsChannel) - (channel === metricsChannel ? 1 : 0);
          const healthCount = wsManager.getChannelSubscriberCount(healthChannel) - (channel === healthChannel ? 1 : 0);
          if (metricsCount <= 0 && healthCount <= 0) {
            unregisterService(serviceId);
            logger.debug('Unregistered service on socket close', { serviceId });
          }
        }
      }
      wsManager.removeConnection(socket);
    });

    // Handle errors - same cleanup as close
    socket.on('error', (err) => {
      logger.error('WebSocket error', { userId, error: err.message });
      // Unregister services before removing connection
      const channels = wsManager.getSocketChannels(socket);
      for (const channel of channels) {
        const channelParts = channel.split(':');
        if (channelParts[0] === 'service' && (channelParts[2] === 'metrics' || channelParts[2] === 'health')) {
          const serviceId = channelParts[1];
          const metricsChannel = `service:${serviceId}:metrics`;
          const healthChannel = `service:${serviceId}:health`;
          const metricsCount = wsManager.getChannelSubscriberCount(metricsChannel) - (channel === metricsChannel ? 1 : 0);
          const healthCount = wsManager.getChannelSubscriberCount(healthChannel) - (channel === healthChannel ? 1 : 0);
          if (metricsCount <= 0 && healthCount <= 0) {
            unregisterService(serviceId);
          }
        }
      }
      wsManager.removeConnection(socket);
    });
  });

  // Set up event listeners for broadcasting
  appEvents.on('deployment:status', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('service:metrics', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('service:health', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('project:status', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('domain:certificate', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('user:notifications', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('debug:status', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  appEvents.on('dockerfile_gen', (event) => {
    wsManager.broadcast(event.channel, {
      timestamp: event.timestamp,
      payload: event.payload
    });
  });

  // Expose WebSocket manager on fastify instance
  fastify.decorate('wsManager', wsManager);
  fastify.decorate('appEvents', appEvents);

  // Add stats endpoint for monitoring
  fastify.get('/ws/stats', async (req, reply) => {
    return wsManager.getStats();
  });

  logger.info('WebSocket hub plugin registered');
}

export default fp(websocketHubPlugin, {
  name: 'websocket-hub',
  dependencies: ['database', 'auth']
});
