import { rolloutRestart, deleteServicePods } from '../services/kubernetes.js';
import { getLatestCommit } from '../services/github.js';
import { decrypt } from '../services/encryption.js';
import { runBuildPipeline, deployService, getDecryptedEnvVars } from '../services/buildPipeline.js';
import {
  computeNamespace,
  verifyServiceOwnership,
  serviceParamsSchema,
} from './_helpers.js';

export default async function serviceDeploymentRoutes(fastify, options) {
  /**
   * POST /services/:id/deploy
   * Trigger a manual deployment
   */
  fastify.post('/services/:id/deploy', { schema: serviceParamsSchema }, async (request, reply) => {
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
      let deployment;
      let commitSha = null;
      let githubToken = null;

      // For image-only services (no repo_url), we don't need GitHub token or commit info
      if (service.image && !service.repo_url) {
        // Create deployment record for image-only service
        const result = await fastify.db.query(
          `INSERT INTO deployments (service_id, commit_sha, status)
           VALUES ($1, $2, 'pending')
           RETURNING id, service_id, commit_sha, status, created_at`,
          [serviceId, 'image-deploy']
        );

        deployment = result.rows[0];
        fastify.log.info(`Created image deployment ${deployment.id} for service ${serviceId} using ${service.image}`);
      } else {
        // For repo-based services, get GitHub token and commit info
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

        githubToken = decrypt(userResult.rows[0].github_access_token);

        // Get latest commit from the branch
        const commit = await getLatestCommit(githubToken, service.repo_url, service.branch);
        commitSha = commit.sha;

        // Create deployment record
        const result = await fastify.db.query(
          `INSERT INTO deployments (service_id, commit_sha, status)
           VALUES ($1, $2, 'pending')
           RETURNING id, service_id, commit_sha, status, created_at`,
          [serviceId, commitSha]
        );

        deployment = result.rows[0];
        fastify.log.info(`Created deployment ${deployment.id} for service ${serviceId} at commit ${commitSha}`);
      }

      // Construct project object for notifications
      const project = {
        id: service.project_id,
        name: service.project_name,
        user_id: service.user_id,
      };

      // Trigger build pipeline asynchronously (don't await - runs in background)
      runBuildPipeline(
        fastify.db,
        service,
        deployment,
        commitSha,
        githubToken,
        namespace,
        service.project_name,
        userHash,
        project
      ).catch(err => {
        fastify.log.error(`Build pipeline failed for deployment ${deployment.id}: ${err.message}`);
      });

      return reply.code(201).send({
        ...deployment,
        message: 'Deployment triggered',
      });
    } catch (err) {
      fastify.log.error(`Failed to trigger deployment: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to trigger deployment',
      });
    }
  });

  /**
   * POST /services/:id/rollback
   * Rollback to a previous successful deployment
   */
  fastify.post('/services/:id/rollback', {
    schema: {
      ...serviceParamsSchema,
      body: {
        type: 'object',
        required: ['deployment_id'],
        properties: {
          deployment_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;
    const { deployment_id: targetDeploymentId } = request.body;

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
      // Get target deployment
      const targetDeployment = await fastify.db.query(
        'SELECT * FROM deployments WHERE id = $1 AND service_id = $2',
        [targetDeploymentId, serviceId]
      );

      if (targetDeployment.rows.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Target deployment not found',
        });
      }

      const target = targetDeployment.rows[0];

      // Validate target deployment
      if (target.status !== 'live') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Can only rollback to successful (live) deployments',
        });
      }

      if (!target.image_tag) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Target deployment has no image tag (legacy deployment)',
        });
      }

      // Create new deployment record for the rollback
      const result = await fastify.db.query(
        `INSERT INTO deployments (service_id, commit_sha, status, image_tag, build_logs, rollback_to)
         VALUES ($1, $2, 'deploying', $3, 'Rollback deployment - skipping build', $4)
         RETURNING *`,
        [serviceId, target.commit_sha, target.image_tag, targetDeploymentId]
      );

      const newDeployment = result.rows[0];

      fastify.log.info(`Rollback initiated: deployment ${newDeployment.id} rolling back to ${targetDeploymentId}`);

      // Get env vars and deploy the old image (skip build)
      const envVars = await getDecryptedEnvVars(fastify.db, serviceId);

      // Deploy asynchronously (don't await - runs in background)
      deployService(
        fastify.db,
        service,
        newDeployment,
        target.image_tag,
        namespace,
        service.project_name,
        envVars
      ).catch(err => {
        fastify.log.error(`Rollback deployment failed for ${newDeployment.id}: ${err.message}`);
      });

      return reply.code(201).send({
        ...newDeployment,
        message: 'Rollback initiated',
        rollback_from: newDeployment.id,
        rollback_to: targetDeploymentId,
      });
    } catch (err) {
      fastify.log.error(`Failed to initiate rollback: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to initiate rollback',
      });
    }
  });

  /**
   * POST /services/:id/restart
   * Restart a service without triggering a full rebuild
   */
  fastify.post('/services/:id/restart', {
    schema: {
      ...serviceParamsSchema,
      body: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['rolling', 'hard'], default: 'rolling' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const userHash = request.user.hash;
    const serviceId = request.params.id;
    const { type = 'rolling' } = request.body || {};

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
      if (type === 'rolling') {
        await rolloutRestart(namespace, service.name);
        fastify.log.info(`Rolling restart initiated for service ${service.name} in ${namespace}`);
      } else {
        await deleteServicePods(namespace, service.name);
        fastify.log.info(`Hard restart initiated for service ${service.name} in ${namespace}`);
      }

      return {
        success: true,
        message: 'Service restart initiated',
        type
      };
    } catch (err) {
      fastify.log.error(`Failed to restart service: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to restart service',
      });
    }
  });
}
