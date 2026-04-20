import {
  startDebugSession,
  runDebugLoop,
  cancelDebugSession,
  rollbackDebugSession,
  getDebugSession,
  getDebugSessionByDeployment,
  getActiveDebugSession,
  getDebugAttempts,
} from '../services/debugAgent.js';
import { decrypt } from '../services/encryption.js';

// Rate limit constants
const MAX_CONCURRENT_SESSIONS = 3;
const MAX_SESSIONS_PER_HOUR = 10;

export default async function debugRoutes(fastify, options) {
  /**
   * Check rate limits for debug session creation
   * Returns { allowed: true } or { allowed: false, error: string }
   */
  async function checkRateLimits(userId) {
    // Check concurrent running sessions
    const concurrentResult = await fastify.db.query(
      `SELECT COUNT(*) FROM debug_sessions
       WHERE service_id IN (
         SELECT id FROM services WHERE project_id IN (
           SELECT id FROM projects WHERE user_id = $1
         )
       ) AND status = 'running'`,
      [userId]
    );

    const concurrentCount = parseInt(concurrentResult.rows[0].count);
    if (concurrentCount >= MAX_CONCURRENT_SESSIONS) {
      return {
        allowed: false,
        error: `Too many concurrent debug sessions (max ${MAX_CONCURRENT_SESSIONS})`,
        currentConcurrent: concurrentCount,
        maxConcurrent: MAX_CONCURRENT_SESSIONS,
      };
    }

    // Check hourly rate limit
    const hourlyResult = await fastify.db.query(
      `SELECT COUNT(*) FROM debug_sessions
       WHERE service_id IN (
         SELECT id FROM services WHERE project_id IN (
           SELECT id FROM projects WHERE user_id = $1
         )
       ) AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId]
    );

    const hourlyCount = parseInt(hourlyResult.rows[0].count);
    if (hourlyCount >= MAX_SESSIONS_PER_HOUR) {
      return {
        allowed: false,
        error: `Rate limit exceeded (max ${MAX_SESSIONS_PER_HOUR} sessions per hour)`,
        currentHourly: hourlyCount,
        maxHourly: MAX_SESSIONS_PER_HOUR,
      };
    }

    return { allowed: true, currentConcurrent: concurrentCount, currentHourly: hourlyCount };
  }

  const deploymentParamsSchema = {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', format: 'uuid' },
      },
    },
  };

  const sessionParamsSchema = {
    params: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', format: 'uuid' },
      },
    },
  };

  /**
   * Helper function to verify deployment ownership
   */
  async function verifyDeploymentOwnership(deploymentId, userId) {
    const result = await fastify.db.query(
      `SELECT d.*, s.id as service_id, s.name as service_name, s.repo_url, s.branch,
              p.user_id, p.name as project_name, u.github_access_token
       FROM deployments d
       JOIN services s ON d.service_id = s.id
       JOIN projects p ON s.project_id = p.id
       JOIN users u ON p.user_id = u.id
       WHERE d.id = $1`,
      [deploymentId]
    );

    if (result.rows.length === 0) {
      return { error: 'Deployment not found', status: 404 };
    }

    const deployment = result.rows[0];
    if (deployment.user_id !== userId) {
      return { error: 'Access denied', status: 403 };
    }

    return { deployment };
  }

  /**
   * Helper function to verify debug session ownership
   */
  async function verifySessionOwnership(sessionId, userId) {
    const result = await fastify.db.query(
      `SELECT ds.*, s.name as service_name, s.repo_url, s.branch,
              p.user_id, p.name as project_name, u.github_access_token
       FROM debug_sessions ds
       JOIN services s ON ds.service_id = s.id
       JOIN projects p ON s.project_id = p.id
       JOIN users u ON p.user_id = u.id
       WHERE ds.id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return { error: 'Debug session not found', status: 404 };
    }

    const session = result.rows[0];
    if (session.user_id !== userId) {
      return { error: 'Access denied', status: 403 };
    }

    return { session };
  }

  /**
   * POST /deployments/:id/debug
   * Start a new debug session for a failed deployment
   */
  fastify.post('/deployments/:id/debug', {
    schema: deploymentParamsSchema,
  }, async (request, reply) => {
    const userId = request.user.id;
    const deploymentId = request.params.id;

    // Check rate limits first
    const rateLimitCheck = await checkRateLimits(userId);
    if (!rateLimitCheck.allowed) {
      return reply.code(429).send({
        error: rateLimitCheck.error,
        currentConcurrent: rateLimitCheck.currentConcurrent,
        maxConcurrent: rateLimitCheck.maxConcurrent,
        currentHourly: rateLimitCheck.currentHourly,
        maxHourly: rateLimitCheck.maxHourly,
      });
    }

    // Verify ownership and get full deployment info
    const ownershipCheck = await verifyDeploymentOwnership(deploymentId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({ error: ownershipCheck.error });
    }

    const { deployment } = ownershipCheck;

    // Check deployment is in a debuggable state (failed build or runtime issues)
    // Allow: 'failed' (build failure), 'running' (runtime crash), 'deployed' (health issues)
    const debuggableStatuses = ['failed', 'running', 'deployed'];
    if (!debuggableStatuses.includes(deployment.status)) {
      return reply.code(400).send({
        error: 'Can only debug failed or running deployments with issues',
        currentStatus: deployment.status,
      });
    }

    // Check for existing active session
    const existingSession = await getActiveDebugSession(fastify.db, deployment.service_id);
    if (existingSession) {
      return reply.code(409).send({
        error: 'An active debug session already exists',
        sessionId: existingSession.id,
      });
    }

    try {
      // Create the debug session
      const session = await startDebugSession(
        fastify.db,
        deploymentId,
        deployment.service_id
      );

      // Get service info for the debug loop
      const serviceResult = await fastify.db.query(
        'SELECT * FROM services WHERE id = $1',
        [deployment.service_id]
      );
      const service = serviceResult.rows[0];

      // Decrypt GitHub token
      const githubToken = decrypt(deployment.github_access_token);

      // Run debug loop asynchronously (don't await)
      runDebugLoop(
        fastify.db,
        session,
        service,
        deployment,
        githubToken,
        deployment.project_name,
        deployment.project_name
      ).catch(err => {
        fastify.log.error({ sessionId: session.id, error: err.message }, 'Debug loop error');
      });

      return reply.code(201).send({
        sessionId: session.id,
        status: 'running',
        message: 'Debug session started',
      });

    } catch (error) {
      fastify.log.error({ error: error.message }, 'Failed to start debug session');
      return reply.code(500).send({ error: 'Failed to start debug session' });
    }
  });

  /**
   * Calculate estimated cost from token count
   * Uses blended rate of ~$18/1M tokens (conservative: $3 input + $15 output avg)
   */
  function calculateEstimatedCost(tokens) {
    const COST_PER_MILLION_TOKENS = 18;
    return (tokens / 1000000) * COST_PER_MILLION_TOKENS;
  }

  /**
   * GET /debug-sessions/:sessionId
   * Get debug session state
   */
  fastify.get('/debug-sessions/:sessionId', {
    schema: sessionParamsSchema,
  }, async (request, reply) => {
    const userId = request.user.id;
    const sessionId = request.params.sessionId;

    const ownershipCheck = await verifySessionOwnership(sessionId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({ error: ownershipCheck.error });
    }

    const { session } = ownershipCheck;

    // Aggregate token usage from all attempts
    const tokenResult = await fastify.db.query(
      `SELECT COALESCE(SUM(tokens_used), 0) as total_tokens
       FROM debug_attempts WHERE session_id = $1`,
      [sessionId]
    );

    const totalTokens = parseInt(tokenResult.rows[0].total_tokens);
    const estimatedCost = calculateEstimatedCost(totalTokens);

    return {
      id: session.id,
      deploymentId: session.deployment_id,
      serviceId: session.service_id,
      status: session.status,
      currentAttempt: session.current_attempt,
      maxAttempts: session.max_attempts,
      fileChanges: session.file_changes,
      finalExplanation: session.final_explanation,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      totalTokens,
      estimatedCost: estimatedCost.toFixed(4),
    };
  });

  /**
   * GET /debug-sessions/:sessionId/attempts
   * Get all attempts for a debug session
   */
  fastify.get('/debug-sessions/:sessionId/attempts', {
    schema: sessionParamsSchema,
  }, async (request, reply) => {
    const userId = request.user.id;
    const sessionId = request.params.sessionId;

    const ownershipCheck = await verifySessionOwnership(sessionId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({ error: ownershipCheck.error });
    }

    const attempts = await getDebugAttempts(fastify.db, sessionId);

    return {
      sessionId,
      attempts: attempts.map(a => ({
        id: a.id,
        attemptNumber: a.attempt_number,
        explanation: a.explanation,
        fileChanges: a.file_changes,
        succeeded: a.succeeded,
        buildLogs: a.build_logs,
        tokensUsed: a.tokens_used,
        gitDiff: a.git_diff,
        createdAt: a.created_at,
      })),
    };
  });

  /**
   * POST /debug-sessions/:sessionId/cancel
   * Cancel a running debug session
   */
  fastify.post('/debug-sessions/:sessionId/cancel', {
    schema: sessionParamsSchema,
  }, async (request, reply) => {
    const userId = request.user.id;
    const sessionId = request.params.sessionId;

    const ownershipCheck = await verifySessionOwnership(sessionId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({ error: ownershipCheck.error });
    }

    const { session } = ownershipCheck;

    if (session.status !== 'running') {
      return reply.code(400).send({
        error: 'Can only cancel running sessions',
        currentStatus: session.status,
      });
    }

    try {
      await cancelDebugSession(fastify.db, sessionId);
      return { cancelled: true, sessionId };
    } catch (error) {
      fastify.log.error({ error: error.message }, 'Failed to cancel debug session');
      return reply.code(500).send({ error: 'Failed to cancel session' });
    }
  });

  /**
   * POST /debug-sessions/:sessionId/rollback
   * Rollback debug session changes and restore original files
   */
  fastify.post('/debug-sessions/:sessionId/rollback', {
    schema: sessionParamsSchema,
  }, async (request, reply) => {
    const userId = request.user.id;
    const sessionId = request.params.sessionId;

    const ownershipCheck = await verifySessionOwnership(sessionId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({ error: ownershipCheck.error });
    }

    const { session } = ownershipCheck;

    // Only allow rollback on succeeded sessions (where AI made changes)
    if (session.status !== 'succeeded') {
      return reply.code(400).send({
        error: 'Can only rollback succeeded sessions',
        currentStatus: session.status,
      });
    }

    // Check if there are original files to restore
    const originalFiles = typeof session.original_files === 'string'
      ? JSON.parse(session.original_files || '{}')
      : (session.original_files || {});

    if (Object.keys(originalFiles).length === 0) {
      return reply.code(400).send({
        error: 'No original files to restore',
      });
    }

    try {
      const result = await rollbackDebugSession(fastify.db, session);
      return {
        success: true,
        sessionId,
        restoredFiles: result.restoredFiles,
      };
    } catch (error) {
      fastify.log.error({ error: error.message }, 'Failed to rollback debug session');
      return reply.code(500).send({ error: 'Failed to rollback session' });
    }
  });

  /**
   * POST /debug-sessions/:sessionId/retry
   * Reset and retry after max attempts
   */
  fastify.post('/debug-sessions/:sessionId/retry', {
    schema: sessionParamsSchema,
  }, async (request, reply) => {
    const userId = request.user.id;
    const sessionId = request.params.sessionId;

    // Check rate limits first
    const rateLimitCheck = await checkRateLimits(userId);
    if (!rateLimitCheck.allowed) {
      return reply.code(429).send({
        error: rateLimitCheck.error,
        currentConcurrent: rateLimitCheck.currentConcurrent,
        maxConcurrent: rateLimitCheck.maxConcurrent,
        currentHourly: rateLimitCheck.currentHourly,
        maxHourly: rateLimitCheck.maxHourly,
      });
    }

    const ownershipCheck = await verifySessionOwnership(sessionId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({ error: ownershipCheck.error });
    }

    const { session } = ownershipCheck;

    if (session.status === 'running') {
      return reply.code(400).send({
        error: 'Cannot retry a running session',
        currentStatus: session.status,
      });
    }

    // Get deployment and service info
    const deploymentResult = await fastify.db.query(
      `SELECT d.*, s.id as service_id, s.name as service_name, s.repo_url, s.branch,
              p.name as project_name, u.github_access_token
       FROM deployments d
       JOIN services s ON d.service_id = s.id
       JOIN projects p ON s.project_id = p.id
       JOIN users u ON p.user_id = u.id
       WHERE d.id = $1`,
      [session.deployment_id]
    );

    if (deploymentResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Deployment no longer exists' });
    }

    const deployment = deploymentResult.rows[0];

    try {
      // Create new debug session
      const newSession = await startDebugSession(
        fastify.db,
        session.deployment_id,
        session.service_id
      );

      // Get service info
      const serviceResult = await fastify.db.query(
        'SELECT * FROM services WHERE id = $1',
        [session.service_id]
      );
      const service = serviceResult.rows[0];

      // Decrypt GitHub token
      const githubToken = decrypt(deployment.github_access_token);

      // Run debug loop asynchronously
      runDebugLoop(
        fastify.db,
        newSession,
        service,
        deployment,
        githubToken,
        deployment.project_name,
        deployment.project_name
      ).catch(err => {
        fastify.log.error({ sessionId: newSession.id, error: err.message }, 'Debug loop error');
      });

      return reply.code(201).send({
        sessionId: newSession.id,
        previousSessionId: sessionId,
        status: 'running',
        message: 'New debug session started',
      });

    } catch (error) {
      fastify.log.error({ error: error.message }, 'Failed to retry debug session');
      return reply.code(500).send({ error: 'Failed to retry debug session' });
    }
  });

  /**
   * GET /services/:serviceId/debug-session
   * Get active or most recent debug session for a service
   */
  fastify.get('/services/:serviceId/debug-session', {
    schema: {
      params: {
        type: 'object',
        required: ['serviceId'],
        properties: {
          serviceId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.serviceId;

    // Verify service ownership
    const serviceResult = await fastify.db.query(
      `SELECT s.*, p.user_id
       FROM services s
       JOIN projects p ON s.project_id = p.id
       WHERE s.id = $1`,
      [serviceId]
    );

    if (serviceResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Service not found' });
    }

    if (serviceResult.rows[0].user_id !== userId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    // Get active session first, then most recent if none active
    const sessionResult = await fastify.db.query(
      `SELECT * FROM debug_sessions
       WHERE service_id = $1
       ORDER BY
         CASE WHEN status = 'running' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
      [serviceId]
    );

    if (sessionResult.rows.length === 0) {
      return { session: null };
    }

    const session = sessionResult.rows[0];

    // Aggregate token usage from all attempts
    const tokenResult = await fastify.db.query(
      `SELECT COALESCE(SUM(tokens_used), 0) as total_tokens
       FROM debug_attempts WHERE session_id = $1`,
      [session.id]
    );

    const totalTokens = parseInt(tokenResult.rows[0].total_tokens);
    const estimatedCost = calculateEstimatedCost(totalTokens);

    return {
      session: {
        id: session.id,
        deploymentId: session.deployment_id,
        status: session.status,
        currentAttempt: session.current_attempt,
        maxAttempts: session.max_attempts,
        fileChanges: session.file_changes,
        finalExplanation: session.final_explanation,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        totalTokens,
        estimatedCost: estimatedCost.toFixed(4),
      },
    };
  });
}
