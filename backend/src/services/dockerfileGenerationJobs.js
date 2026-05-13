import { generateForRepo, DockerfileValidationError } from './dockerfileGenerator.js';
import { decrypt } from './encryption.js';
import appEvents from './event-emitter.js';
import logger from './logger.js';

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
    if (err instanceof DockerfileValidationError) {
      return failJob(db, job.id, {
        message: err.reason,
        suggestedUserActions: err.suggestedUserActions,
        buildOutput: err.buildOutput,
        stage: err.stage,
      });
    }
    return failJob(db, job.id, { message: err.message, stage: 'crash' });
  }
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
