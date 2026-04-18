import { getPodMetrics, getDeployment, getPodHealth, getPodEvents } from '../services/kubernetes.js';
import { performHealthCheck, getHealthHistory } from '../services/healthChecker.js';
import {
  computeNamespace,
  computeSubdomain,
  computeWebhookUrl,
  parseResourceQuantity,
  verifyServiceOwnership,
  serviceParamsSchema,
} from './_helpers.js';

export default async function serviceMetricRoutes(fastify, options) {
  /**
   * GET /services/:id/metrics
   * Get real-time CPU and memory metrics for a service
   */
  fastify.get('/services/:id/metrics', { schema: serviceParamsSchema }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;

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
      // Get pod metrics from metrics-server
      let podMetrics;
      try {
        podMetrics = await getPodMetrics(namespace, `app=${service.name}`);
      } catch (metricsErr) {
        // Metrics server unavailable or no metrics yet
        fastify.log.warn(`Metrics unavailable for ${service.name}: ${metricsErr.message}`);
        return {
          pods: [],
          aggregated: {
            totalCpuMillicores: 0,
            totalMemoryBytes: 0,
            podCount: 0
          },
          limits: null,
          available: false,
          message: 'Metrics not available. Service may not be running or metrics-server may be unavailable.'
        };
      }

      // Get resource limits from deployment
      let limits = null;
      try {
        const deployment = await getDeployment(namespace, service.name);
        const containerLimits = deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits;
        if (containerLimits) {
          limits = {
            cpuMillicores: parseResourceQuantity(containerLimits.cpu),
            memoryBytes: parseResourceQuantity(containerLimits.memory)
          };
        }
      } catch (deployErr) {
        fastify.log.warn(`Could not get deployment limits for ${service.name}: ${deployErr.message}`);
      }

      // Parse and aggregate metrics
      const parsedPods = podMetrics.map(pod => {
        const container = pod.containers[0] || {};
        const cpuMillicores = parseResourceQuantity(container.cpu || '0');
        const memoryBytes = parseResourceQuantity(container.memory || '0');

        return {
          name: pod.name,
          cpu: {
            usage: container.cpu || '0',
            usageMillicores: cpuMillicores,
            limitMillicores: limits?.cpuMillicores || null,
            percentUsed: limits?.cpuMillicores ? Math.round((cpuMillicores / limits.cpuMillicores) * 100) : null
          },
          memory: {
            usage: container.memory || '0',
            usageBytes: memoryBytes,
            limitBytes: limits?.memoryBytes || null,
            percentUsed: limits?.memoryBytes ? Math.round((memoryBytes / limits.memoryBytes) * 100) : null
          }
        };
      });

      // Aggregate metrics across all pods
      const aggregated = {
        totalCpuMillicores: parsedPods.reduce((sum, pod) => sum + pod.cpu.usageMillicores, 0),
        totalMemoryBytes: parsedPods.reduce((sum, pod) => sum + pod.memory.usageBytes, 0),
        podCount: parsedPods.length
      };

      return {
        pods: parsedPods,
        aggregated,
        limits,
        available: true
      };
    } catch (err) {
      fastify.log.error(`Failed to get metrics: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get service metrics',
      });
    }
  });

  /**
   * GET /services/:id/health
   * Get health check status for a service
   */
  fastify.get('/services/:id/health', { schema: serviceParamsSchema }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;

    // Verify ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    const { service } = ownershipCheck;

    // Check if health check is configured
    if (!service.health_check_path) {
      return {
        configured: false,
        message: 'No health check path configured for this service'
      };
    }

    const namespace = computeNamespace(service.project_name);
    const subdomain = computeSubdomain(service.project_name, service.name);

    try {
      // Get pod health from Kubernetes
      let podHealth = [];
      let events = [];
      try {
        podHealth = await getPodHealth(namespace, `app=${service.name}`);
        events = await getPodEvents(namespace, `app=${service.name}`);
      } catch (k8sErr) {
        fastify.log.warn(`Could not get pod health for ${service.name}: ${k8sErr.message}`);
      }

      // Perform active health check
      let activeCheck = null;
      try {
        activeCheck = await performHealthCheck(subdomain, service.health_check_path, service.port);
      } catch (healthErr) {
        fastify.log.warn(`Active health check failed for ${service.name}: ${healthErr.message}`);
        activeCheck = {
          status: 'unhealthy',
          error: healthErr.message,
          lastCheck: new Date().toISOString()
        };
      }

      // Get health check history
      let history = [];
      try {
        history = await getHealthHistory(fastify.db, serviceId, 20);
      } catch (historyErr) {
        fastify.log.warn(`Could not get health history for ${service.name}: ${historyErr.message}`);
      }

      // Calculate overall health status
      const allPodsReady = podHealth.length > 0 && podHealth.every(p => p.ready);
      const activeHealthy = activeCheck?.status === 'healthy';
      const overallStatus = (allPodsReady && activeHealthy) ? 'healthy' : 'unhealthy';

      return {
        configured: true,
        path: service.health_check_path,
        status: overallStatus,
        pods: podHealth,
        activeCheck,
        history,
        events: events.slice(0, 10) // Last 10 relevant events
      };
    } catch (err) {
      fastify.log.error(`Failed to get health status: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get health status',
      });
    }
  });

  /**
   * GET /services/:id/webhook-secret
   * Reveal the webhook secret for a service
   */
  fastify.get('/services/:id/webhook-secret', { schema: serviceParamsSchema }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.id;

    // Verify ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    try {
      const result = await fastify.db.query(
        'SELECT webhook_secret FROM services WHERE id = $1',
        [serviceId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Service not found',
        });
      }

      const webhookUrl = computeWebhookUrl(serviceId);

      return {
        webhook_secret: result.rows[0].webhook_secret,
        webhook_url: webhookUrl,
      };
    } catch (err) {
      fastify.log.error(`Failed to get webhook secret: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get webhook secret',
      });
    }
  });
}
