import { patchService, patchDeployment, patchIngress } from '../services/kubernetes.js';
import { getFileContent, getDockerfileExposedPort } from '../services/github.js';
import { decrypt } from '../services/encryption.js';
import { validateDockerfile } from '../services/dockerfileValidator.js';
import {
  computeSubdomain,
  computeNamespace,
  verifyServiceOwnership,
  serviceParamsSchema,
  BASE_DOMAIN,
} from './_helpers.js';

export default async function serviceDockerfileRoutes(fastify, options) {
  /**
   * POST /services/:id/validate-dockerfile
   * Validate the Dockerfile for a service before building
   */
  fastify.post('/services/:id/validate-dockerfile', { schema: serviceParamsSchema }, async (request, reply) => {
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

    const { service } = ownershipCheck;

    // Cannot validate if no repo_url (image-only services)
    if (!service.repo_url) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Cannot validate Dockerfile for image-only services',
      });
    }

    try {
      // Get user's GitHub token
      const userResult = await fastify.db.query(
        'SELECT github_access_token FROM users WHERE id = $1',
        [userId]
      );

      if (!userResult.rows[0]?.github_access_token) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'GitHub token not configured',
        });
      }

      const githubToken = decrypt(userResult.rows[0].github_access_token);

      // Fetch Dockerfile content from GitHub
      const dockerfilePath = service.dockerfile_path || 'Dockerfile';
      const fileResult = await getFileContent(
        githubToken,
        service.repo_url,
        dockerfilePath,
        service.branch
      );

      if (!fileResult) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Dockerfile not found at ${dockerfilePath}`,
        });
      }

      // Validate the Dockerfile
      const validationResult = validateDockerfile(fileResult.content);

      fastify.log.info(`Validated Dockerfile for service ${serviceId}: ${validationResult.summary.errorCount} errors, ${validationResult.summary.warningCount} warnings`);

      return {
        ...validationResult,
        dockerfile_path: dockerfilePath,
      };
    } catch (err) {
      fastify.log.error(`Failed to validate Dockerfile: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to validate Dockerfile',
      });
    }
  });

  /**
   * GET /services/:id/suggested-port
   * Get the suggested port from Dockerfile EXPOSE directive
   */
  fastify.get('/services/:id/suggested-port', { schema: serviceParamsSchema }, async (request, reply) => {
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

    const { service } = ownershipCheck;

    // Cannot get suggested port for image-only services
    if (!service.repo_url) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Cannot detect port for image-only services',
      });
    }

    try {
      // Get user's GitHub token
      const userResult = await fastify.db.query(
        'SELECT github_access_token FROM users WHERE id = $1',
        [userId]
      );

      if (!userResult.rows[0]?.github_access_token) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'GitHub token not configured',
        });
      }

      const githubToken = decrypt(userResult.rows[0].github_access_token);

      // Build the full Dockerfile path considering build_context
      let dockerfilePath = service.dockerfile_path || 'Dockerfile';
      if (service.build_context) {
        const context = service.build_context.replace(/^\.\//, '').replace(/\/$/, '');
        dockerfilePath = `${context}/${dockerfilePath}`;
      }

      // Fetch and parse Dockerfile
      const { port: detectedPort } = await getDockerfileExposedPort(
        githubToken,
        service.repo_url,
        dockerfilePath,
        service.branch
      );

      // Update the detected_port in the database
      if (detectedPort !== null) {
        await fastify.db.query(
          'UPDATE services SET detected_port = $1 WHERE id = $2',
          [detectedPort, serviceId]
        );
      }

      const hasMismatch = detectedPort !== null && detectedPort !== service.port;

      return {
        detected_port: detectedPort,
        configured_port: service.port,
        has_mismatch: hasMismatch,
        dockerfile_path: dockerfilePath,
      };
    } catch (err) {
      fastify.log.error(`Failed to get suggested port: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to detect port from Dockerfile',
      });
    }
  });

  /**
   * POST /services/:id/fix-port
   * Update the service port to match the Dockerfile EXPOSE directive
   * Updates both the database and Kubernetes resources without rebuild
   */
  fastify.post('/services/:id/fix-port', {
    schema: {
      ...serviceParamsSchema,
      body: {
        type: 'object',
        properties: {
          port: { type: 'integer', minimum: 1, maximum: 65535 }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;
    const { port: newPort } = request.body || {};

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

    // Determine the target port - use provided port or detected_port
    let targetPort = newPort;
    if (!targetPort) {
      // Try to get detected port from database
      const detectedResult = await fastify.db.query(
        'SELECT detected_port FROM services WHERE id = $1',
        [serviceId]
      );
      targetPort = detectedResult.rows[0]?.detected_port;
    }

    if (!targetPort) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'No port specified and no detected port available. Run suggested-port first or specify a port.',
      });
    }

    if (targetPort === service.port) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Port is already set to the specified value',
      });
    }

    try {
      // Update database first
      await fastify.db.query(
        'UPDATE services SET port = $1 WHERE id = $2',
        [targetPort, serviceId]
      );

      // Update Kubernetes Service
      try {
        await patchService(namespace, service.name, {
          spec: {
            ports: [{
              port: targetPort,
              targetPort: targetPort,
              protocol: 'TCP'
            }]
          }
        });
        fastify.log.info(`Patched K8s Service port for ${service.name} to ${targetPort}`);
      } catch (k8sErr) {
        if (k8sErr.status !== 404) {
          fastify.log.warn(`Failed to patch K8s Service: ${k8sErr.message}`);
        }
      }

      // Update Kubernetes Deployment container port
      try {
        await patchDeployment(namespace, service.name, {
          spec: {
            template: {
              spec: {
                containers: [{
                  name: service.name,
                  ports: [{
                    containerPort: targetPort,
                    protocol: 'TCP'
                  }]
                }]
              }
            }
          }
        });
        fastify.log.info(`Patched K8s Deployment port for ${service.name} to ${targetPort}`);
      } catch (k8sErr) {
        if (k8sErr.status !== 404) {
          fastify.log.warn(`Failed to patch K8s Deployment: ${k8sErr.message}`);
        }
      }

      // Update Kubernetes Ingress backend port
      try {
        const subdomain = computeSubdomain(service.project_name, service.name);
        await patchIngress(namespace, service.name, {
          spec: {
            rules: [{
              host: `${subdomain}.${BASE_DOMAIN}`,
              http: {
                paths: [{
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: service.name,
                      port: {
                        number: targetPort
                      }
                    }
                  }
                }]
              }
            }]
          }
        });
        fastify.log.info(`Patched K8s Ingress port for ${service.name} to ${targetPort}`);
      } catch (k8sErr) {
        if (k8sErr.status !== 404) {
          fastify.log.warn(`Failed to patch K8s Ingress: ${k8sErr.message}`);
        }
      }

      fastify.log.info(`Fixed port mismatch for service ${serviceId}: ${service.port} -> ${targetPort}`);

      return {
        success: true,
        message: 'Port updated successfully',
        previous_port: service.port,
        new_port: targetPort,
      };
    } catch (err) {
      fastify.log.error(`Failed to fix port: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update port',
      });
    }
  });
}
