import { generateForRepo, DockerfileValidationError, DockerfileCancelledError } from './dockerfileGenerator.js';
import { decrypt } from './encryption.js';
import appEvents from './event-emitter.js';
import logger from './logger.js';

// In-process registry of running jobs → AbortController. Lets cancelJob()
// signal the runJob() coroutine. The map only contains jobs running on the
// CURRENT backend pod — a backend restart drops the registry but also kills
// the goroutine, so callers must handle "I asked to cancel a job from a
// previous instance" gracefully (we still mark it cancelled in the DB).
const activeJobs = new Map();

/**
 * Create a new async Dockerfile generation job and kick off the agent in
 * the background. Returns immediately with the job row so the caller can
 * respond 202 to the user.
 *
 * The agent's tool calls + final result stream over WebSocket on channel
 * `dockerfile_gen:<jobId>`. The same data is also appended to
 * dockerfile_generation_jobs.tool_events / .result so clients that
 * connect late or reconnect can replay state.
 */
export async function createJob(db, userId, { repoUrl, branch, workdir, githubToken }) {
  const result = await db.query(`
    INSERT INTO dockerfile_generation_jobs (user_id, repo_url, branch, workdir, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING *
  `, [userId, repoUrl, branch, workdir || '']);

  const job = result.rows[0];
  logger.info({ jobId: job.id, userId, repoUrl, branch, workdir }, 'Dockerfile gen job created');

  // Fire-and-forget — we don't await this. Errors are caught inside runJob.
  runJob(db, job, githubToken).catch(err => {
    logger.error({ jobId: job.id, err: err.message }, 'runJob: top-level crash');
  });

  return job;
}

export async function getJob(db, jobId, userId) {
  const result = await db.query(`
    SELECT * FROM dockerfile_generation_jobs
    WHERE id = $1 AND user_id = $2
  `, [jobId, userId]);
  return result.rows[0] || null;
}

/**
 * Internal: run the agent for a job. Updates DB row + emits WS events
 * at each step. Never throws — all errors are converted to a 'failed'
 * status with structured detail.
 */
async function runJob(db, job, githubToken) {
  // Register a fresh AbortController so cancelJob() can signal us.
  const controller = new AbortController();
  activeJobs.set(job.id, controller);

  // Mark running.
  await db.query(`
    UPDATE dockerfile_generation_jobs
    SET status = 'running', updated_at = NOW()
    WHERE id = $1
  `, [job.id]);
  appEvents.emitDockerfileGen(job.id, { type: 'status', status: 'running' });

  // Resolve the token. We pull it from the caller in createJob — but
  // since createJob already returned and we're async now, we need to
  // re-fetch. Cheap enough.
  if (!githubToken) {
    const tokenResult = await db.query(
      'SELECT github_access_token FROM users WHERE id = $1',
      [job.user_id]
    );
    if (!tokenResult.rows[0]?.github_access_token) {
      return failJob(db, job.id, {
        message: 'GitHub token not configured for this user',
        stage: 'auth',
      });
    }
    githubToken = decrypt(tokenResult.rows[0].github_access_token);
  }

  try {
    const result = await generateForRepo(githubToken, job.repo_url, job.branch, {
      workdir: job.workdir,
      signal: controller.signal,
      onEvent: (event) => {
        // Persist + stream. Persistence is fire-and-forget — if a write fails
        // the user can still get the WS event.
        db.query(`
          UPDATE dockerfile_generation_jobs
          SET tool_events = tool_events || $1::jsonb, updated_at = NOW()
          WHERE id = $2
        `, [JSON.stringify(event), job.id]).catch(err =>
          logger.warn({ jobId: job.id, err: err.message }, 'tool_events append failed')
        );
        appEvents.emitDockerfileGen(job.id, event);
      },
    });

    await db.query(`
      UPDATE dockerfile_generation_jobs
      SET status = 'succeeded', result = $1::jsonb,
          updated_at = NOW(), completed_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(result), job.id]);
    appEvents.emitDockerfileGen(job.id, { type: 'succeeded', result });
    logger.info({ jobId: job.id }, 'Dockerfile gen job succeeded');
  } catch (err) {
    if (err instanceof DockerfileCancelledError) {
      // cancelJob() already updated the row + emitted the event, but mark
      // here too in case cancel came from a SIGTERM or out-of-band path.
      await db.query(`
        UPDATE dockerfile_generation_jobs
        SET status = 'cancelled', updated_at = NOW(), completed_at = NOW()
        WHERE id = $1 AND status = 'running'
      `, [job.id]);
      appEvents.emitDockerfileGen(job.id, { type: 'cancelled' });
      logger.info({ jobId: job.id }, 'Dockerfile gen job cancelled');
      return;
    }
    if (err instanceof DockerfileValidationError) {
      return failJob(db, job.id, {
        message: err.reason,
        suggestedUserActions: err.suggestedUserActions,
        buildOutput: err.buildOutput,
        stage: err.stage,
      });
    }
    return failJob(db, job.id, { message: err.message, stage: 'crash' });
  } finally {
    activeJobs.delete(job.id);
  }
}

/**
 * Cancel a running job. Aborts the agent's in-flight LLM call between
 * iterations, marks the row 'cancelled', emits a final WS event. Idempotent —
 * calling on an already-terminal job is a no-op.
 */
export async function cancelJob(db, jobId, userId) {
  const result = await db.query(`
    SELECT id, status FROM dockerfile_generation_jobs
    WHERE id = $1 AND user_id = $2
  `, [jobId, userId]);
  if (result.rows.length === 0) return { found: false };
  const { status } = result.rows[0];
  if (['succeeded', 'failed', 'cancelled'].includes(status)) {
    return { found: true, alreadyTerminal: true, status };
  }

  // Signal the in-process agent (if running on this pod).
  const controller = activeJobs.get(jobId);
  if (controller) controller.abort();

  // Mark row + emit event. The runJob coroutine will also try to mark
  // cancelled but the unique completed_at + status guard makes this safe.
  await db.query(`
    UPDATE dockerfile_generation_jobs
    SET status = 'cancelled', updated_at = NOW(), completed_at = NOW()
    WHERE id = $1 AND status IN ('pending', 'running')
  `, [jobId]);
  appEvents.emitDockerfileGen(jobId, { type: 'cancelled' });
  logger.info({ jobId, userId, signalledLocally: !!controller }, 'Dockerfile gen job cancel requested');
  return { found: true, cancelled: true };
}

async function failJob(db, jobId, failureDetail) {
  await db.query(`
    UPDATE dockerfile_generation_jobs
    SET status = 'failed', result = $1::jsonb,
        updated_at = NOW(), completed_at = NOW()
    WHERE id = $2
  `, [JSON.stringify(failureDetail), jobId]);
  appEvents.emitDockerfileGen(jobId, { type: 'failed', ...failureDetail });
  logger.warn({ jobId, ...failureDetail }, 'Dockerfile gen job failed');
}
