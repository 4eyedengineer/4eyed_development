import { getPodsByLabel, getPodLogs, streamPodLogs } from '../services/kubernetes.js';
import {
  computeNamespace,
  verifyServiceOwnership,
  serviceParamsSchema,
} from './_helpers.js';

export default async function serviceLogRoutes(fastify, options) {
  /**
   * GET /services/:id/logs
   * Get container logs for a service
   */
  fastify.get('/services/:id/logs', {
    schema: {
      ...serviceParamsSchema,
      querystring: {
        type: 'object',
        properties: {
          tailLines: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
          sinceSeconds: { type: 'integer', minimum: 1 },
          pod: { type: 'string' },
          container: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;
    const { tailLines = 100, sinceSeconds, pod, container } = request.query;

    // Verify ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    const { service } = ownershipCheck;
    const namespace = computeNamespace(service.project_name);

    try {
      // Get all pods for this service
      const podsResult = await getPodsByLabel(namespace, `app=${service.name}`);
      const allPods = podsResult.items || [];

      if (allPods.length === 0) {
        return { pods: [], message: 'No running pods found' };
      }

      // Filter to specific pod if requested, otherwise get all
      const targetPods = pod
        ? allPods.filter(p => p.metadata.name === pod)
        : allPods;

      if (targetPods.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Pod "${pod}" not found`
        });
      }

      // Get logs for each pod
      const results = await Promise.all(
        targetPods.map(async (p) => {
          const podName = p.metadata.name;
          const containers = p.spec.containers.map(c => c.name);
          const targetContainer = container || containers[0];

          try {
            const logs = await getPodLogs(namespace, podName, {
              tailLines,
              sinceSeconds,
              container: targetContainer
            });
            return {
              name: podName,
              containers,
              logs,
              status: p.status.phase
            };
          } catch (logErr) {
            fastify.log.warn(`Failed to get logs for pod ${podName}: ${logErr.message}`);
            return {
              name: podName,
              containers,
              logs: '',
              error: logErr.message,
              status: p.status.phase
            };
          }
        })
      );

      return { pods: results };
    } catch (err) {
      fastify.log.error(`Failed to get container logs: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get container logs',
      });
    }
  });

  /**
   * GET /services/:id/logs/stream (WebSocket)
   * Stream container logs in real-time
   */
  fastify.get('/services/:id/logs/stream', {
    websocket: true,
    schema: serviceParamsSchema
  }, async (connection, request) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;
    const { pod, container, tailLines = 50 } = request.query;

    // Verify ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      connection.socket.send(JSON.stringify({
        type: 'error',
        message: ownershipCheck.error
      }));
      connection.socket.close();
      return;
    }

    const { service } = ownershipCheck;
    const namespace = computeNamespace(service.project_name);

    try {
      // Get pods if no specific pod requested
      let targetPod = pod;
      if (!targetPod) {
        const podsResult = await getPodsByLabel(namespace, `app=${service.name}`);
        const allPods = podsResult.items || [];
        if (allPods.length === 0) {
          connection.socket.send(JSON.stringify({
            type: 'error',
            message: 'No running pods found'
          }));
          connection.socket.close();
          return;
        }
        // Use first pod if not specified
        targetPod = allPods[0].metadata.name;

        // Send pod list to client
        connection.socket.send(JSON.stringify({
          type: 'pods',
          pods: allPods.map(p => ({
            name: p.metadata.name,
            containers: p.spec.containers.map(c => c.name),
            status: p.status.phase
          }))
        }));
      }

      // Start streaming logs
      const logStream = streamPodLogs(namespace, targetPod, {
        container,
        tailLines: parseInt(tailLines, 10)
      });

      connection.socket.send(JSON.stringify({
        type: 'connected',
        pod: targetPod,
        container: container || 'default'
      }));

      logStream.on('data', (chunk) => {
        connection.socket.send(JSON.stringify({
          type: 'log',
          data: chunk
        }));
      });

      logStream.on('error', (err) => {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: err.message
        }));
      });

      logStream.on('end', () => {
        connection.socket.send(JSON.stringify({
          type: 'end',
          message: 'Log stream ended'
        }));
      });

      // Cleanup on socket close
      connection.socket.on('close', () => {
        logStream.destroy();
      });

    } catch (err) {
      fastify.log.error(`Failed to stream container logs: ${err.message}`);
      connection.socket.send(JSON.stringify({
        type: 'error',
        message: 'Failed to stream logs'
      }));
      connection.socket.close();
    }
  });
}
