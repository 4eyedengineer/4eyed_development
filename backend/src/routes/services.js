import { generateWebhookSecret } from '../services/encryption.js';
import { deleteDeployment, deleteService, deleteIngress, deletePVC, getDeployment, scaleDeployment } from '../services/kubernetes.js';
import { getLatestCommit } from '../services/github.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { runBuildPipeline } from '../services/buildPipeline.js';
import {
  validateServiceName,
  validateEnvVarKey,
  computeSubdomain,
  computeServiceUrl,
  computeWebhookUrl,
  computeNamespace,
  verifyProjectOwnership,
  verifyServiceOwnership,
  serviceParamsSchema,
  projectParamsSchema,
} from './_helpers.js';

export default async function serviceRoutes(fastify, options) {
  const createServiceSchema = {
    body: {
      type: 'object',
      required: ['name', 'port'],
      properties: {
        name: { type: 'string' },
        repo_url: { type: 'string' },
        image: { type: 'string' },
        branch: { type: 'string', default: 'main' },
        dockerfile_path: { type: 'string', default: 'Dockerfile' },
        build_context: { type: 'string' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        replicas: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        storage_gb: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
        health_check_path: { type: 'string' },
      },
    },
  };

  const updateServiceSchema = {
    body: {
      type: 'object',
      properties: {
        branch: { type: 'string' },
        dockerfile_path: { type: 'string' },
        build_context: { type: 'string' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        replicas: { type: 'integer', minimum: 1, maximum: 3 },
        storage_gb: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
        health_check_path: { type: 'string' },
      },
      additionalProperties: false,
    },
  };

  /**
   * POST /projects/:projectId/services
   * Create a new service
   */
  fastify.post('/projects/:projectId/services', {
    schema: { ...projectParamsSchema, ...createServiceSchema },
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const projectId = request.params.projectId;

    // Verify project ownership
    const ownershipCheck = await verifyProjectOwnership(fastify.db, projectId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    const { project } = ownershipCheck;

    // Validate service name
    const validation = validateServiceName(request.body.name);
    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: validation.error,
      });
    }

    const serviceName = validation.name;
    const {
      repo_url,
      image,
      branch = 'main',
      dockerfile_path = 'Dockerfile',
      build_context,
      port,
      replicas = 1,
      storage_gb,
      health_check_path,
    } = request.body;

    // Validate that either repo_url or image is provided
    if (!repo_url && !image) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Either repo_url or image must be provided',
      });
    }

    try {
      // Check if service name already exists for this project
      const existing = await fastify.db.query(
        'SELECT id FROM services WHERE project_id = $1 AND name = $2',
        [projectId, serviceName]
      );

      if (existing.rows.length > 0) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'A service with this name already exists in this project',
        });
      }

      // Generate webhook secret
      const webhookSecret = generateWebhookSecret();

      // Insert into database
      const result = await fastify.db.query(
        `INSERT INTO services (project_id, name, repo_url, image, branch, dockerfile_path, build_context, port, replicas, storage_gb, health_check_path, webhook_secret)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, name, repo_url, image, branch, dockerfile_path, build_context, port, replicas, storage_gb, health_check_path, created_at`,
        [projectId, serviceName, repo_url || null, image || null, branch, dockerfile_path, build_context || null, port, replicas, storage_gb || null, health_check_path || null, webhookSecret]
      );

      const service = result.rows[0];
      const subdomain = computeSubdomain(project.name, serviceName);
      const webhookUrl = computeWebhookUrl(service.id);

      fastify.log.info(`Created service: ${serviceName} (${service.id}) in project ${projectId}`);

      return reply.code(201).send({
        ...service,
        subdomain,
        webhook_url: webhookUrl,
      });
    } catch (err) {
      fastify.log.error(`Failed to create service: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create service',
      });
    }
  });

  /**
   * POST /projects/:projectId/services/batch
   * Create multiple services at once (for importing from docker-compose)
   */
  fastify.post('/projects/:projectId/services/batch', {
    schema: {
      params: projectParamsSchema.params,
      body: {
        type: 'object',
        required: ['services'],
        properties: {
          services: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              required: ['name', 'port'],
              properties: {
                name: { type: 'string' },
                repo_url: { type: 'string' },
                branch: { type: 'string', default: 'main' },
                dockerfile_path: { type: 'string', default: 'Dockerfile' },
                build_context: { type: 'string' },
                image: { type: 'string' },
                port: { type: 'integer', minimum: 1, maximum: 65535 },
                replicas: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
                storage_gb: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
                health_check_path: { type: 'string' },
                env_vars: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['key', 'value'],
                    properties: {
                      key: { type: 'string' },
                      value: { type: 'string' }
                    }
                  }
                },
                // For AI-generated Dockerfiles
                generated_dockerfile: {
                  type: 'object',
                  properties: {
                    dockerfile: { type: 'string' },
                    dockerignore: { type: 'string' },
                    framework: {
                      type: 'object',
                      properties: {
                        language: { type: 'string' },
                        framework: { type: 'string' },
                        explanation: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const projectId = request.params.projectId;
    const { services } = request.body;

    // Verify project ownership
    const ownershipCheck = await verifyProjectOwnership(fastify.db, projectId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    // Check for duplicate service names in the request (after normalization)
    const normalizedNames = services.map(svc => validateServiceName(svc.name).name);
    const seenNames = new Set();
    for (let i = 0; i < normalizedNames.length; i++) {
      const name = normalizedNames[i];
      if (seenNames.has(name)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Duplicate service name "${name}" in request`
        });
      }
      seenNames.add(name);
    }

    // Validate all service names and env vars upfront
    for (const svc of services) {
      const validation = validateServiceName(svc.name);
      if (!validation.valid) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Invalid service name "${svc.name}": ${validation.error}`
        });
      }

      // Ensure either repo_url or image is provided
      if (!svc.repo_url && !svc.image) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Service "${svc.name}" must have either repo_url or image`
        });
      }

      // Validate environment variable keys if provided
      if (svc.env_vars && svc.env_vars.length > 0) {
        const seenKeys = new Set();
        for (const env of svc.env_vars) {
          const upperKey = env.key.toUpperCase();

          // Check for duplicate keys within this service
          if (seenKeys.has(upperKey)) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `Duplicate env var key "${env.key}" in service "${svc.name}"`
            });
          }
          seenKeys.add(upperKey);

          // Validate key format
          const keyValidation = validateEnvVarKey(upperKey);
          if (!keyValidation.valid) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `Invalid env var key "${env.key}" in service "${svc.name}": ${keyValidation.error}`
            });
          }
        }
      }
    }

    const createdServices = [];
    const errors = [];

    // Use transaction for atomic batch creation
    const client = await fastify.db.pool.connect();

    try {
      await client.query('BEGIN');

      for (const svc of services) {
        const serviceName = validateServiceName(svc.name).name;

        // Check for existing service
        const existing = await client.query(
          'SELECT id FROM services WHERE project_id = $1 AND name = $2',
          [projectId, serviceName]
        );

        if (existing.rows.length > 0) {
          errors.push({
            name: svc.name,
            error: 'Service already exists'
          });
          continue;
        }

        // Generate webhook secret
        const webhookSecret = generateWebhookSecret();

        // Apply defaults explicitly (Fastify schema defaults are for validation/docs only)
        const branch = svc.branch || 'main';
        const dockerfilePath = svc.dockerfile_path || 'Dockerfile';
        const replicas = svc.replicas ?? 1;

        const result = await client.query(
          `INSERT INTO services (
            project_id, name, repo_url, branch, dockerfile_path,
            build_context, image, port, replicas, storage_gb,
            health_check_path, webhook_secret
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING id, name, repo_url, branch, dockerfile_path, build_context, image, port, replicas, storage_gb, health_check_path, created_at`,
          [
            projectId,
            serviceName,
            svc.repo_url || null,
            branch,
            dockerfilePath,
            svc.build_context || null,
            svc.image || null,
            svc.port,
            replicas,
            svc.storage_gb || null,
            svc.health_check_path || null,
            webhookSecret
          ]
        );

        const service = result.rows[0];

        // Create environment variables if provided
        if (svc.env_vars && svc.env_vars.length > 0) {
          for (const env of svc.env_vars) {
            const encryptedValue = encrypt(env.value);
            await client.query(
              'INSERT INTO env_vars (service_id, key, value) VALUES ($1, $2, $3)',
              [service.id, env.key.toUpperCase(), encryptedValue]
            );
          }
        }

        // Store generated Dockerfile if provided
        if (svc.generated_dockerfile?.dockerfile) {
          const detectedFramework = svc.generated_dockerfile.framework || {};
          await client.query(
            `INSERT INTO generated_files (service_id, file_type, content, llm_model, detected_framework)
             VALUES ($1, 'dockerfile', $2, $3, $4)`,
            [
              service.id,
              svc.generated_dockerfile.dockerfile,
              'claude-3-5-haiku-20241022',
              JSON.stringify(detectedFramework)
            ]
          );

          // Also store dockerignore if provided
          if (svc.generated_dockerfile.dockerignore) {
            await client.query(
              `INSERT INTO generated_files (service_id, file_type, content, llm_model, detected_framework)
               VALUES ($1, 'dockerignore', $2, $3, $4)`,
              [
                service.id,
                svc.generated_dockerfile.dockerignore,
                'claude-3-5-haiku-20241022',
                JSON.stringify(detectedFramework)
              ]
            );
          }

          fastify.log.info(`Stored generated Dockerfile for service ${service.name}`);
        }

        createdServices.push({
          ...service,
          subdomain: computeSubdomain(ownershipCheck.project.name, serviceName),
          webhook_url: computeWebhookUrl(service.id),
          has_generated_dockerfile: !!svc.generated_dockerfile?.dockerfile
        });
      }

      await client.query('COMMIT');

      fastify.log.info(`Batch created ${createdServices.length} services in project ${projectId}`);

      return reply.code(201).send({
        created: createdServices,
        errors: errors.length > 0 ? errors : undefined,
        summary: {
          requested: services.length,
          created: createdServices.length,
          failed: errors.length
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      fastify.log.error(`Batch create failed: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create services'
      });
    } finally {
      client.release();
    }
  });

  /**
   * GET /services/:id
   * Get service details
   */
  fastify.get('/services/:id', { schema: serviceParamsSchema }, async (request, reply) => {
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

    try {
      // Get latest deployment status
      const deploymentResult = await fastify.db.query(
        `SELECT id, status, commit_sha, created_at
         FROM deployments
         WHERE service_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [serviceId]
      );

      const latestDeployment = deploymentResult.rows[0] || null;
      const subdomain = computeSubdomain(service.project_name, service.name);
      const webhookUrl = computeWebhookUrl(serviceId);
      const serviceUrl = computeServiceUrl(subdomain);

      // Check for port mismatch
      const hasMismatch = service.detected_port !== null && service.detected_port !== service.port;

      return {
        id: service.id,
        project_id: service.project_id,
        name: service.name,
        repo_url: service.repo_url,
        image: service.image,
        branch: service.branch,
        dockerfile_path: service.dockerfile_path,
        build_context: service.build_context,
        port: service.port,
        detected_port: service.detected_port,
        port_mismatch: hasMismatch,
        replicas: service.replicas,
        storage_gb: service.storage_gb,
        health_check_path: service.health_check_path,
        created_at: service.created_at,
        subdomain,
        url: serviceUrl,
        webhook_url: webhookUrl,
        latest_deployment: latestDeployment,
      };
    } catch (err) {
      fastify.log.error(`Failed to get service: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get service',
      });
    }
  });

  /**
   * PATCH /services/:id
   * Update service configuration
   */
  fastify.patch('/services/:id', {
    schema: { ...serviceParamsSchema, ...updateServiceSchema },
  }, async (request, reply) => {
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

    const allowedFields = ['branch', 'dockerfile_path', 'build_context', 'port', 'replicas', 'storage_gb', 'health_check_path'];
    const updates = {};

    for (const field of allowedFields) {
      if (request.body[field] !== undefined) {
        updates[field] = request.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'No valid fields to update',
      });
    }

    try {
      // Build dynamic update query
      const setClauses = [];
      const values = [];
      let paramIndex = 1;

      for (const [field, value] of Object.entries(updates)) {
        setClauses.push(`${field} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }

      values.push(serviceId);

      const result = await fastify.db.query(
        `UPDATE services
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, name, repo_url, image, branch, dockerfile_path, build_context, port, replicas, storage_gb, health_check_path, created_at`,
        values
      );

      const service = result.rows[0];

      fastify.log.info(`Updated service: ${service.name} (${serviceId})`);

      // Return consistent format with GET endpoint (include computed fields)
      return {
        ...service,
        subdomain: computeSubdomain(ownershipCheck.service.project_name, service.name),
        webhook_url: computeWebhookUrl(serviceId),
      };
    } catch (err) {
      fastify.log.error(`Failed to update service: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update service',
      });
    }
  });

  /**
   * DELETE /services/:id
   * Delete a service and its K8s resources
   */
  fastify.delete('/services/:id', { schema: serviceParamsSchema }, async (request, reply) => {
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
      // Delete K8s resources (ignore 404 errors)
      const k8sDeletes = [
        { name: 'deployment', fn: () => deleteDeployment(namespace, service.name) },
        { name: 'service', fn: () => deleteService(namespace, service.name) },
        { name: 'ingress', fn: () => deleteIngress(namespace, service.name) },
      ];

      // Only delete PVC if storage was configured
      if (service.storage_gb) {
        k8sDeletes.push({ name: 'pvc', fn: () => deletePVC(namespace, `${service.name}-pvc`) });
      }

      for (const resource of k8sDeletes) {
        try {
          await resource.fn();
          fastify.log.info(`Deleted K8s ${resource.name}: ${service.name} in ${namespace}`);
        } catch (k8sErr) {
          if (k8sErr.status !== 404) {
            fastify.log.warn(`Failed to delete K8s ${resource.name}: ${k8sErr.message}`);
          }
        }
      }

      // Delete from database (cascades env_vars, deployments)
      await fastify.db.query('DELETE FROM services WHERE id = $1', [serviceId]);

      fastify.log.info(`Deleted service: ${service.name} (${serviceId})`);

      return { success: true, message: 'Service deleted successfully' };
    } catch (err) {
      fastify.log.error(`Failed to delete service: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete service',
      });
    }
  });

  /**
   * POST /services/:id/clone
   * Clone an existing service with a new name
   */
  fastify.post('/services/:id/clone', {
    schema: {
      ...serviceParamsSchema,
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          project_id: { type: 'string', format: 'uuid' },
          include_env: { type: 'boolean', default: false },
          auto_deploy: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const sourceId = request.params.id;
    const { name, project_id, include_env = false, auto_deploy = false } = request.body;

    // Verify ownership of source service
    const sourceCheck = await verifyServiceOwnership(fastify.db, sourceId, userId);
    if (sourceCheck.error) {
      return reply.code(sourceCheck.status).send({
        error: sourceCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: sourceCheck.error,
      });
    }

    const sourceService = sourceCheck.service;

    // Validate new service name
    const validation = validateServiceName(name);
    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: validation.error,
      });
    }

    const newServiceName = validation.name;

    // Determine target project (default to same project)
    const targetProjectId = project_id || sourceService.project_id;
    let targetProjectName;

    // If cloning to different project, verify ownership and get name
    if (targetProjectId !== sourceService.project_id) {
      const targetCheck = await verifyProjectOwnership(fastify.db, targetProjectId, userId);
      if (targetCheck.error) {
        return reply.code(targetCheck.status).send({
          error: targetCheck.status === 404 ? 'Not Found' : 'Forbidden',
          message: targetCheck.error,
        });
      }
      targetProjectName = targetCheck.project.name;
    } else {
      targetProjectName = sourceService.project_name;
    }

    try {
      // Check if service name already exists in target project
      const existing = await fastify.db.query(
        'SELECT id FROM services WHERE project_id = $1 AND name = $2',
        [targetProjectId, newServiceName]
      );

      if (existing.rows.length > 0) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Service name already exists in target project',
        });
      }

      // Generate new webhook secret
      const webhookSecret = generateWebhookSecret();

      // Clone service
      const result = await fastify.db.query(
        `INSERT INTO services (
          name, project_id, repo_url, image, branch, dockerfile_path,
          build_context, port, replicas, storage_gb, health_check_path, webhook_secret
        )
        SELECT
          $1, $2, repo_url, image, branch, dockerfile_path,
          build_context, port, replicas, storage_gb, health_check_path, $3
        FROM services WHERE id = $4
        RETURNING *`,
        [newServiceName, targetProjectId, webhookSecret, sourceId]
      );

      const newService = result.rows[0];

      // Clone environment variables if requested
      if (include_env) {
        await fastify.db.query(
          `INSERT INTO env_vars (service_id, key, value)
           SELECT $1, key, value
           FROM env_vars WHERE service_id = $2`,
          [newService.id, sourceId]
        );
      }

      const subdomain = computeSubdomain(targetProjectName, newServiceName);
      const webhookUrl = computeWebhookUrl(newService.id);

      fastify.log.info(`Cloned service ${sourceService.name} (${sourceId}) to ${newServiceName} (${newService.id})`);

      // Trigger deployment if requested
      let deployment = null;
      if (auto_deploy) {
        // Create deployment record
        const deployResult = await fastify.db.query(
          `INSERT INTO deployments (service_id, commit_sha, status)
           VALUES ($1, $2, 'pending')
           RETURNING id, service_id, commit_sha, status, created_at`,
          [newService.id, 'clone-deploy']
        );
        deployment = deployResult.rows[0];

        // Use already-resolved target project name for namespace
        const namespace = computeNamespace(targetProjectName);

        // Get GitHub token if needed for repo-based service
        let githubToken = null;
        let commitSha = null;
        if (newService.repo_url) {
          const userResult = await fastify.db.query(
            'SELECT github_access_token FROM users WHERE id = $1',
            [userId]
          );
          if (userResult.rows[0]?.github_access_token) {
            githubToken = decrypt(userResult.rows[0].github_access_token);
            const commit = await getLatestCommit(githubToken, newService.repo_url, newService.branch);
            commitSha = commit.sha;
            // Update deployment with actual commit sha
            await fastify.db.query(
              'UPDATE deployments SET commit_sha = $1 WHERE id = $2',
              [commitSha, deployment.id]
            );
            deployment.commit_sha = commitSha;
          }
        }

        // Construct project object for notifications
        const project = {
          id: targetProjectId,
          name: targetProjectName,
          user_id: userId,
        };

        // Trigger build pipeline asynchronously
        runBuildPipeline(
          fastify.db,
          newService,
          deployment,
          commitSha || 'clone-deploy',
          githubToken,
          namespace,
          targetProjectName,
          userHash,
          project
        ).catch(err => {
          fastify.log.error(`Build pipeline failed for cloned service ${newService.id}: ${err.message}`);
        });
      }

      return reply.code(201).send({
        service: {
          ...newService,
          subdomain,
          webhook_url: webhookUrl,
        },
        deployment,
        cloned_from: sourceId,
        env_vars_copied: include_env,
      });
    } catch (err) {
      fastify.log.error(`Failed to clone service: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to clone service',
      });
    }
  });

  /**
   * PATCH /services/:id/state
   * Start or stop a service
   * Body: { state: 'running' | 'stopped' }
   */
  fastify.patch('/services/:id/state', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['running', 'stopped'] }
        },
        required: ['state']
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.id;
    const { state } = request.body;

    // Verify service ownership
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
      let currentReplicas = 0;
      let targetReplicas = 0;
      let deploymentExists = true;

      // Get current deployment state
      try {
        const deployment = await getDeployment(namespace, service.name);
        currentReplicas = deployment.spec?.replicas || 0;
      } catch (getErr) {
        // Deployment may not exist yet
        if (getErr.status === 404) {
          deploymentExists = false;
        } else {
          throw getErr;
        }
      }

      // If deployment doesn't exist, we can't start/stop it
      if (!deploymentExists) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Service has not been deployed yet. Deploy it first before starting/stopping.',
        });
      }

      if (state === 'stopped') {
        // Scale to 0 replicas
        targetReplicas = 0;
        await scaleDeployment(namespace, service.name, 0);
      } else {
        // Scale to configured replicas (or 1 if not set)
        targetReplicas = service.replicas || 1;
        await scaleDeployment(namespace, service.name, targetReplicas);
      }

      fastify.log.info(`Service ${service.name} state changed to ${state}`, {
        namespace,
        previousReplicas: currentReplicas,
        targetReplicas
      });

      return {
        service: service.name,
        state,
        replicas: targetReplicas,
        previousReplicas: currentReplicas
      };
    } catch (err) {
      fastify.log.error(`Failed to change service state: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to change service state',
      });
    }
  });
}
