import { decrypt } from '../services/encryption.js';
import {
  generateForRepo,
  getGeneratedFile,
  DockerfileValidationError,
} from '../services/dockerfileGenerator.js';
import { createJob, getJob } from '../services/dockerfileGenerationJobs.js';
import { isLLMAvailable, DEFAULT_MODEL } from '../services/llmClient.js';
import logger from '../services/logger.js';

/**
 * Helper to get decrypted GitHub token for the current user
 */
async function getGitHubToken(fastify, userId) {
  const result = await fastify.db.query(
    'SELECT github_access_token FROM users WHERE id = $1',
    [userId]
  );

  if (!result.rows[0]?.github_access_token) {
    return null;
  }

  return decrypt(result.rows[0].github_access_token);
}

export default async function dockerfileRoutes(fastify, options) {
  /**
   * GET /dockerfile/status
   * Check if LLM-powered Dockerfile generation is available
   */
  fastify.get('/dockerfile/status', async (request, reply) => {
    return {
      available: isLLMAvailable(),
      model: DEFAULT_MODEL
    };
  });

  /**
   * POST /dockerfile/generate
   * Generate a Dockerfile for a repository using LLM
   * This is used during project creation when no Dockerfile exists
   */
  fastify.post('/dockerfile/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['repoUrl'],
        properties: {
          repoUrl: { type: 'string' },
          branch: { type: 'string', default: 'main' },
          // Optional subdir inside the repo to deploy from (monorepo support).
          // Empty/missing = build from repo root.
          workdir: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const { repoUrl, branch, workdir } = request.body;

    try {
      // Check if LLM is available
      if (!isLLMAvailable()) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Dockerfile generation is not configured. ANTHROPIC_API_KEY is missing.'
        });
      }

      // Get GitHub token
      const githubToken = await getGitHubToken(fastify, userId);
      if (!githubToken) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'GitHub token not configured'
        });
      }

      logger.info({ userId, repoUrl, branch, workdir }, 'Generating Dockerfile for repo');

      // Generate Dockerfile
      const result = await generateForRepo(githubToken, repoUrl, branch, { workdir });

      logger.info({
        userId,
        repoUrl,
        language: result.framework.language,
        framework: result.framework.framework,
        port: result.detectedPort
      }, 'Dockerfile generated successfully');

      return {
        success: true,
        dockerfile: result.dockerfile,
        dockerignore: result.dockerignore,
        detectedPort: result.detectedPort,
        framework: result.framework,
        tokensUsed: result.tokensUsed
      };
    } catch (error) {
      // Validation failure — the agent tried to build the repo and failed. Surface
      // it loudly with structured details so the UI can render the user-facing
      // fix rather than dropping into a generic 500.
      if (error instanceof DockerfileValidationError) {
        logger.warn({
          repoUrl,
          reason: error.reason,
          stage: error.stage,
        }, 'Dockerfile validation failed');
        return reply.code(422).send({
          error: 'Validation Failed',
          message: error.reason,
          stage: error.stage,
          suggestedUserActions: error.suggestedUserActions,
          buildOutput: error.buildOutput,
        });
      }

      logger.error({ error: error.message, repoUrl }, 'Dockerfile generation failed');

      // Handle specific error types
      if (error.message.includes('not found')) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message
        });
      }

      if (error.message.includes('rate limit')) {
        return reply.code(429).send({
          error: 'Too Many Requests',
          message: 'LLM rate limit exceeded. Please try again later.'
        });
      }

      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to generate Dockerfile',
        details: error.message
      });
    }
  });

  /**
   * POST /dockerfile/generate-async
   * Kick off a background validation job. Returns 202 + {jobId}.
   * Client subscribes to WS channel `dockerfile_gen:<jobId>` for live
   * tool calls + final result.
   */
  fastify.post('/dockerfile/generate-async', {
    schema: {
      body: {
        type: 'object',
        required: ['repoUrl'],
        properties: {
          repoUrl: { type: 'string' },
          branch: { type: 'string', default: 'main' },
          workdir: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const { repoUrl, branch, workdir } = request.body;

    if (!isLLMAvailable()) {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Dockerfile generation is not configured. ANTHROPIC_API_KEY is missing.'
      });
    }

    // Confirm the user has a token before kicking off — saves a failure-mode round trip.
    const githubToken = await getGitHubToken(fastify, userId);
    if (!githubToken) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'GitHub token not configured'
      });
    }

    try {
      const job = await createJob(fastify.db, userId, { repoUrl, branch, workdir, githubToken });
      return reply.code(202).send({
        jobId: job.id,
        channel: `dockerfile_gen:${job.id}`,
        status: job.status,
      });
    } catch (err) {
      logger.error({ err: err.message, userId, repoUrl }, 'Failed to create gen job');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to start Dockerfile generation',
      });
    }
  });

  /**
   * GET /dockerfile/jobs/:jobId
   * Fallback for clients that miss WS events — returns the full job state
   * including the tool_events log and result.
   */
  fastify.get('/dockerfile/jobs/:jobId', {
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    const job = await getJob(fastify.db, request.params.jobId, request.user.id);
    if (!job) return reply.code(404).send({ error: 'Not Found', message: 'Job not found' });
    return {
      id: job.id,
      status: job.status,
      repoUrl: job.repo_url,
      branch: job.branch,
      workdir: job.workdir,
      toolEvents: job.tool_events,
      result: job.result,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      completedAt: job.completed_at,
    };
  });

  /**
   * GET /services/:serviceId/generated-dockerfile
   * Get the generated Dockerfile for a service
   */
  fastify.get('/services/:serviceId/generated-dockerfile', {
    schema: {
      params: {
        type: 'object',
        required: ['serviceId'],
        properties: {
          serviceId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { serviceId } = request.params;

    try {
      // Verify the user owns this service
      const serviceResult = await fastify.db.query(`
        SELECT s.id FROM services s
        JOIN projects p ON s.project_id = p.id
        WHERE s.id = $1 AND p.user_id = $2
      `, [serviceId, request.user.id]);

      if (serviceResult.rows.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Service not found'
        });
      }

      // Get generated Dockerfile
      const dockerfile = await getGeneratedFile(fastify.db, serviceId, 'dockerfile');

      if (!dockerfile) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'No generated Dockerfile found for this service'
        });
      }

      return {
        content: dockerfile.content,
        detectedFramework: dockerfile.detectedFramework,
        createdAt: dockerfile.createdAt,
        updatedAt: dockerfile.updatedAt
      };
    } catch (error) {
      logger.error({ error: error.message, serviceId }, 'Failed to get generated Dockerfile');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to retrieve generated Dockerfile'
      });
    }
  });
}
