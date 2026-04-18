import Anthropic from '@anthropic-ai/sdk';
import { getRepoTree, getFileContent, parseGitHubUrl } from './github.js';
import { getGeneratedFile } from './dockerfileGenerator.js';
import { upsertConfigMap, deleteConfigMap, getPodLogs, getPodEvents, getPodHealth, getDeploymentSpec } from './kubernetes.js';
import { triggerBuild, watchBuildJob, captureBuildLogs, deployService, getDecryptedEnvVars } from './buildPipeline.js';
import { updateDeploymentStatus } from './deploymentService.js';
import appEvents from './event-emitter.js';
import logger from './logger.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEBUG_MODEL = process.env.DEBUG_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 8000;

let client = null;

/**
 * Get or create Anthropic client singleton
 */
function getClient() {
  if (!client) {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * System prompt for debug agent - generalist for all failure phases
 */
const DEBUG_SYSTEM_PROMPT = `You are an expert DevOps engineer debugging deployment failures.

You will be given context about a failure including:
- PHASE: build, startup, runtime, or health (tells you what kind of failure)
- BUILD_LOGS: Container build output (if build phase)
- POD_LOGS: Application container logs (if startup/runtime/health phase)
- POD_EVENTS: Kubernetes events (scheduling, crashes, OOM, probe failures)
- POD_HEALTH: Current pod status and restart counts
- DEPLOYMENT_SPEC: Kubernetes deployment configuration
- REPO_CONTEXT: Repository structure and key files

Analyze all provided context to understand the root cause. The PHASE tells you where in the lifecycle the failure occurred, but use ALL context to reason about the fix.

SAFETY:
- NEVER create or modify .env, secrets, credentials, or keys
- Output COMPLETE file contents, not diffs

OUTPUT FORMAT - respond with valid JSON only:
{
  "explanation": "Brief analysis of the error and what you're fixing",
  "fileChanges": [
    {"path": "Dockerfile", "content": "FROM node:20-alpine\\n..."}
  ],
  "needsManualFix": false,
  "suggestedActions": ["Optional array of manual steps if needsManualFix is true"]
}

Set needsManualFix: true when:
- Source code bugs that require human judgment
- Missing external dependencies (APIs, databases)
- Configuration issues outside the repository
- Resource limits that need human decision
- Authentication/secrets issues

When needsManualFix is true, provide clear suggestedActions for the user.`;

/**
 * Determine the failure phase based on deployment and pod state
 * @param {object} deployment - Deployment record
 * @param {Array} podHealth - Pod health array from getPodHealth
 * @returns {string} Phase: build, startup, runtime, or health
 */
export function determineFailurePhase(deployment, podHealth) {
  if (deployment.status === 'failed' && deployment.build_logs && !deployment.image_tag) {
    return 'build';
  }
  if (podHealth && podHealth.length > 0) {
    const pod = podHealth[0];
    if (pod.waitingReason === 'CrashLoopBackOff' ||
        pod.waitingReason === 'Error' ||
        (pod.restartCount > 0 && pod.terminatedExitCode !== 0)) {
      return 'startup';
    }
    if (pod.phase === 'Running' &&
        (pod.liveness?.status === 'failing' || pod.readiness?.status === 'failing')) {
      return 'health';
    }
    if (pod.restartCount > 2 && pod.phase !== 'Running') {
      return 'runtime';
    }
  }
  if (deployment.build_logs) {
    return 'build';
  }
  return 'startup';
}

/**
 * Gather diagnostic context based on failure phase
 */
export async function gatherDiagnosticContext(db, service, deployment, phase, namespace) {
  const context = { phase, buildLogs: null, podLogs: null, podEvents: null, podHealth: null, deploymentSpec: null };
  const labelSelector = `app=${service.name}`;
  if (phase !== 'build') {
    try {
      context.podHealth = await getPodHealth(namespace, labelSelector);
      context.podEvents = await getPodEvents(namespace, labelSelector, 50);
      context.deploymentSpec = await getDeploymentSpec(namespace, service.name);
      if (context.podHealth && context.podHealth.length > 0) {
        const podName = context.podHealth[0].name;
        try {
          context.podLogs = await getPodLogs(namespace, podName, { tailLines: 200, previous: context.podHealth[0].restartCount > 0 });
        } catch (logErr) {
          logger.warn({ podName, error: logErr.message }, 'Failed to fetch pod logs');
        }
      }
    } catch (err) {
      logger.warn({ phase, error: err.message }, 'Failed to gather runtime context');
    }
  }
  if (deployment.build_logs) {
    context.buildLogs = deployment.build_logs;
  }
  return context;
}

/**
 * Start a new debug session for a failed deployment
 * @param {object} db - Database connection
 * @param {string} deploymentId - Failed deployment ID
 * @param {string} serviceId - Service ID
 * @param {number} maxAttempts - Maximum fix attempts (default 10)
 * @returns {Promise<object>} Created session
 */
export async function startDebugSession(db, deploymentId, serviceId, maxAttempts = 10) {
  // Check for existing active session
  const existingResult = await db.query(`
    SELECT id FROM debug_sessions
    WHERE service_id = $1 AND status = 'running'
    LIMIT 1
  `, [serviceId]);

  if (existingResult.rows.length > 0) {
    throw new Error('An active debug session already exists for this service');
  }

  // Snapshot original generated files for potential restore
  const originalDockerfile = await getGeneratedFile(db, serviceId, 'dockerfile');
  const originalDockerignore = await getGeneratedFile(db, serviceId, 'dockerignore');
  const originalFiles = {};
  if (originalDockerfile) {
    originalFiles.Dockerfile = originalDockerfile.content;
  }
  if (originalDockerignore) {
    originalFiles['.dockerignore'] = originalDockerignore.content;
  }

  // Create session
  const result = await db.query(`
    INSERT INTO debug_sessions (deployment_id, service_id, max_attempts, original_files)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [deploymentId, serviceId, maxAttempts, JSON.stringify(originalFiles)]);

  const session = result.rows[0];

  logger.info({
    sessionId: session.id,
    deploymentId,
    serviceId,
    maxAttempts
  }, 'Debug session created');

  return session;
}

/**
 * Run the debug loop for a session
 * @param {object} db - Database connection
 * @param {object} session - Debug session object
 * @param {object} service - Service object
 * @param {object} deployment - Failed deployment object
 * @param {string} githubToken - Decrypted GitHub token
 * @param {string} namespace - Kubernetes namespace
 * @param {string} projectName - Project name
 */
export async function runDebugLoop(db, session, service, deployment, githubToken, namespace, projectName) {
  let buildLogs = deployment.build_logs || 'No build logs available';
  const attempts = [];

  // Fetch repo context once (reused across attempts)
  const repoContext = await fetchRepoContext(githubToken, service.repo_url, service.branch);

  try {
    for (let attempt = 1; attempt <= session.max_attempts; attempt++) {
      // Update session current attempt
      await updateSessionAttempt(db, session.id, attempt);

      // Emit progress event
      appEvents.emitDebugStatus(session.id, {
        attempt,
        maxAttempts: session.max_attempts,
        status: 'analyzing',
        message: `Analyzing build failure (attempt ${attempt}/${session.max_attempts})...`
      });

      logger.info({ sessionId: session.id, attempt }, 'Starting debug attempt');

      // Call LLM to analyze and fix
      const llmResult = await analyzeFailureWithLLM(buildLogs, repoContext, attempts);

      // Store attempt
      const attemptRecord = await createAttempt(db, session.id, attempt, llmResult);
      attempts.push({
        attemptNumber: attempt,
        explanation: llmResult.explanation,
        fileChanges: llmResult.fileChanges
      });

      // If LLM says manual fix is needed, trust it and stop
      if (llmResult.needsManualFix || !llmResult.fileChanges || llmResult.fileChanges.length === 0) {
        logger.info({ sessionId: session.id, attempt }, 'LLM indicates manual fix required');

        await updateSessionFailed(db, session.id, llmResult.explanation);

        appEvents.emitDebugStatus(session.id, {
          attempt,
          maxAttempts: session.max_attempts,
          status: 'needs_manual_fix',
          explanation: llmResult.explanation,
          suggestedActions: llmResult.suggestedActions || [],
          message: 'Issue requires manual fix by the user'
        });

        return { success: false, attempts: attempt, needsManualFix: true, explanation: llmResult.explanation, suggestedActions: llmResult.suggestedActions || [] };
      }

      // Emit progress - applying changes
      appEvents.emitDebugStatus(session.id, {
        attempt,
        maxAttempts: session.max_attempts,
        status: 'building',
        explanation: llmResult.explanation,
        fileChanges: llmResult.fileChanges,
        message: 'Applying fixes and rebuilding...'
      });

      // Apply file changes and rebuild
      const buildResult = await rebuildWithChanges(
        db, session.id, service, deployment, llmResult.fileChanges,
        githubToken, namespace, projectName
      );

      // Update attempt with build result
      await updateAttemptResult(db, attemptRecord.id, buildResult.success, buildResult.logs);

      if (buildResult.success) {
        // Success! Update session and deploy
        const finalChanges = llmResult.fileChanges;

        await updateSessionSuccess(db, session.id, finalChanges);

        // Deploy the service
        const envVars = await getDecryptedEnvVars(db, service.id);
        await deployService(db, service, deployment, buildResult.imageTag, namespace, projectName, envVars);

        // Emit success event
        appEvents.emitDebugStatus(session.id, {
          attempt,
          maxAttempts: session.max_attempts,
          status: 'succeeded',
          explanation: llmResult.explanation,
          fileChanges: finalChanges,
          message: `Build fixed in ${attempt} attempt(s)!`
        });

        logger.info({ sessionId: session.id, attempt }, 'Debug session succeeded');

        return { success: true, attempts: attempt, fileChanges: finalChanges };
      }

      // Build failed - update logs for next attempt
      buildLogs = buildResult.logs || buildLogs;

      logger.info({
        sessionId: session.id,
        attempt,
        remaining: session.max_attempts - attempt
      }, 'Debug attempt failed, continuing...');
    }

    // Max attempts reached - get final explanation
    const finalExplanation = await generateFinalExplanation(buildLogs, repoContext, attempts);

    await updateSessionFailed(db, session.id, finalExplanation);

    // Emit failure event
    appEvents.emitDebugStatus(session.id, {
      attempt: session.max_attempts,
      maxAttempts: session.max_attempts,
      status: 'failed',
      finalExplanation,
      message: 'Could not auto-fix after maximum attempts'
    });

    logger.info({ sessionId: session.id }, 'Debug session failed after max attempts');

    return { success: false, attempts: session.max_attempts, finalExplanation };

  } catch (error) {
    logger.error({ sessionId: session.id, error: error.message }, 'Debug loop error');

    await updateSessionError(db, session.id, error.message);

    appEvents.emitDebugStatus(session.id, {
      status: 'error',
      message: `Debug session error: ${error.message}`
    });

    throw error;
  }
}

/**
 * Analyze build failure and suggest fixes using LLM
 */
async function analyzeFailureWithLLM(buildLogs, repoContext, previousAttempts) {
  const anthropic = getClient();

  const userMessage = buildDebugPrompt(buildLogs, repoContext, previousAttempts);

  logger.debug('Calling LLM for debug analysis');

  const response = await anthropic.messages.create({
    model: DEBUG_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: userMessage }],
    system: DEBUG_SYSTEM_PROMPT
  });

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent) {
    throw new Error('No text response from LLM');
  }

  const result = parseJsonResponse(textContent.text);
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

  return {
    explanation: result.explanation || 'No explanation provided',
    fileChanges: result.fileChanges || [],
    needsManualFix: result.needsManualFix || false,
    tokensUsed
  };
}

/**
 * Build the debug prompt for the LLM
 */
function buildDebugPrompt(buildLogs, repoContext, previousAttempts) {
  let prompt = `## Build Logs\n\`\`\`\n${buildLogs}\n\`\`\`\n\n`;

  prompt += `## Repository Structure\n\`\`\`\n${repoContext.fileTree}\n\`\`\`\n\n`;

  if (repoContext.files && Object.keys(repoContext.files).length > 0) {
    prompt += '## Current Files\n\n';
    for (const [filename, content] of Object.entries(repoContext.files)) {
      if (content) {
        prompt += `### ${filename}\n\`\`\`\n${content}\n\`\`\`\n\n`;
      }
    }
  }

  if (previousAttempts.length > 0) {
    prompt += '## Previous Attempts\n\n';
    for (const attempt of previousAttempts) {
      prompt += `### Attempt ${attempt.attemptNumber}\n`;
      prompt += `**Explanation:** ${attempt.explanation}\n`;
      if (attempt.fileChanges && attempt.fileChanges.length > 0) {
        prompt += `**Files Modified:** ${attempt.fileChanges.map(f => f.path).join(', ')}\n`;
      }
      prompt += '\n';
    }
    prompt += 'The above attempts did not fix the issue. Try a different approach.\n\n';
  }

  prompt += 'Analyze the build failure and provide fixes.';

  return prompt;
}

/**
 * Generate final explanation when max attempts reached
 */
async function generateFinalExplanation(buildLogs, repoContext, attempts) {
  const anthropic = getClient();

  const userMessage = `After ${attempts.length} attempts, we could not automatically fix this build failure.

## Build Logs
\`\`\`
${buildLogs}
\`\`\`

## Previous Attempts
${attempts.map(a => `- Attempt ${a.attemptNumber}: ${a.explanation}`).join('\n')}

Please provide:
1. A clear explanation of why the build cannot be automatically fixed
2. Specific manual steps the user can take to resolve the issue

Be concise and actionable.`;

  const response = await anthropic.messages.create({
    model: DEBUG_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: userMessage }],
    system: 'You are a helpful DevOps engineer explaining why a build cannot be automatically fixed and what the user should do.'
  });

  const textContent = response.content.find(c => c.type === 'text');
  return textContent?.text || 'Unable to generate explanation';
}

/**
 * Apply file changes and trigger a new build
 */
async function rebuildWithChanges(db, sessionId, service, deployment, fileChanges, githubToken, namespace, projectName) {
  // Create ConfigMap with all file changes
  const configMapName = `debug-files-${service.name}-${Date.now()}`;
  const configMapData = {};

  for (const file of fileChanges) {
    // Encode path: escape underscores first, then convert slashes
    // e.g., src/my_config.js -> src_my__config.js
    const key = file.path.replace(/_/g, '__').replace(/\//g, '_');
    configMapData[key] = file.content;
  }

  try {
    await upsertConfigMap(namespace, configMapName, configMapData);

    // Also update generated_files table for Dockerfile changes
    for (const file of fileChanges) {
      if (file.path === 'Dockerfile') {
        await storeGeneratedFile(db, service.id, 'dockerfile', file.content);
      } else if (file.path === '.dockerignore') {
        await storeGeneratedFile(db, service.id, 'dockerignore', file.content);
      }
    }

    // Trigger build using the debug ConfigMap
    const { jobName, imageTag, gitSecretName } = await triggerDebugBuild(
      db, service, deployment, deployment.commit_sha, githubToken, namespace, configMapName
    );

    // Track current job in session for cancellation
    await db.query(`
      UPDATE debug_sessions
      SET current_job_name = $1, current_namespace = $2, updated_at = NOW()
      WHERE id = $3
    `, [jobName, namespace, sessionId]);

    // Watch build
    const buildResult = await watchBuildJob(db, namespace, jobName, deployment.id, gitSecretName);

    // Clear job tracking after build completes
    await db.query(`
      UPDATE debug_sessions
      SET current_job_name = NULL, current_namespace = NULL, updated_at = NOW()
      WHERE id = $1
    `, [sessionId]);

    // Cleanup ConfigMap
    await deleteConfigMap(namespace, configMapName).catch(() => {});

    return {
      success: buildResult.success,
      imageTag: buildResult.imageTag,
      logs: buildResult.logs
    };

  } catch (error) {
    // Cleanup on error
    await deleteConfigMap(namespace, configMapName).catch(() => {});
    throw error;
  }
}

/**
 * Trigger a debug build with a ConfigMap containing modified files
 */
async function triggerDebugBuild(db, service, deployment, commitSha, githubToken, namespace, configMapName) {
  const { applyManifest, createSecret, deleteSecret } = await import('./kubernetes.js');
  const { generateKanikoJobManifest } = await import('./manifestGenerator.js');
  const { parseGitHubUrl } = await import('./github.js');

  await updateDeploymentStatus(db, deployment.id, 'building');

  appEvents.emitDeploymentStatus(deployment.id, {
    status: 'building',
    previousStatus: 'failed',
    commitSha,
    message: 'Rebuilding with AI fixes...'
  });

  const HARBOR_REGISTRY = process.env.HARBOR_REGISTRY || 'harbor.192.168.1.124.nip.io';
  const REGISTRY_SECRET_NAME = process.env.REGISTRY_SECRET_NAME || 'harbor-registry-secret';

  const jobName = `debug-${service.name}-${Date.now()}`;
  const imageTag = `${HARBOR_REGISTRY}/dangus/${namespace}/${service.name}:debug-${Date.now()}`;
  const gitSecretName = `git-creds-${jobName}`;

  const { owner, repo } = parseGitHubUrl(service.repo_url);
  const repoUrl = `github.com/${owner}/${repo}`;

  try {
    // Create git credentials secret
    const gitSecretData = {
      GIT_USERNAME: Buffer.from('x-access-token').toString('base64'),
      GIT_PASSWORD: Buffer.from(githubToken).toString('base64'),
    };
    await createSecret(namespace, gitSecretName, gitSecretData);

    const jobManifest = generateKanikoJobManifest({
      namespace,
      jobName,
      repoUrl,
      branch: service.branch,
      commitSha,
      dockerfilePath: '/workspace/Dockerfile',
      imageDest: imageTag,
      gitSecretName,
      registrySecretName: REGISTRY_SECRET_NAME,
      dockerfileConfigMap: configMapName,
    });

    await applyManifest(jobManifest);

    return { jobName, imageTag, gitSecretName };

  } catch (error) {
    await deleteSecret(namespace, gitSecretName).catch(() => {});
    throw error;
  }
}

/**
 * Fetch repository context for LLM
 */
async function fetchRepoContext(githubToken, repoUrl, branch) {
  const tree = await getRepoTree(githubToken, repoUrl, branch);

  // Format file tree (limited to 200 entries)
  const fileTree = tree
    .map(f => f.path)
    .sort()
    .slice(0, 200)
    .join('\n');

  // Fetch key files
  const files = await fetchKeyFiles(githubToken, repoUrl, branch, tree);

  return { fileTree, files };
}

/**
 * Fetch key configuration files from repo
 * Uses repo structure to intelligently select relevant files
 */
async function fetchKeyFiles(token, repoUrl, branch, tree) {
  const files = {};
  const filePaths = tree.map(f => f.path);

  // Let repo structure guide file selection - find all root-level config files
  const configExtensions = ['.json', '.yaml', '.yml', '.toml', '.lock', '.mod', '.sum'];
  const configPatterns = [
    /^Dockerfile$/i, /^\.dockerignore$/i, /^Makefile$/i, /^Procfile$/i,
    /^\.nvmrc$/i, /^\.node-version$/i, /^\.python-version$/i, /^\.ruby-version$/i,
    /^nginx\.conf$/i, /^\.?env\.example$/i
  ];

  // Find files matching patterns or extensions (root level only for brevity)
  const filesToFetch = filePaths.filter(path => {
    if (path.includes('/')) return false; // Root level only
    if (configPatterns.some(p => p.test(path))) return true;
    if (configExtensions.some(ext => path.endsWith(ext))) return true;
    return false;
  });

  // Fetch in parallel (limit to 20 files)
  const fetchPromises = filesToFetch.slice(0, 20).map(async (filePath) => {
    try {
      const result = await getFileContent(token, repoUrl, filePath, branch);
      if (result?.content) {
        // Truncate large files
        files[filePath] = result.content.length > 10000
          ? result.content.substring(0, 10000) + '\n... (truncated)'
          : result.content;
      }
    } catch (error) {
      logger.warn({ filePath, error: error.message }, 'Failed to fetch file');
    }
  });

  await Promise.all(fetchPromises);
  return files;
}

/**
 * Store a generated file in the database
 */
async function storeGeneratedFile(db, serviceId, fileType, content) {
  await db.query(`
    INSERT INTO generated_files (service_id, file_type, content, llm_model, detected_framework, tokens_used)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (service_id, file_type)
    DO UPDATE SET
      content = EXCLUDED.content,
      llm_model = EXCLUDED.llm_model,
      updated_at = NOW()
  `, [serviceId, fileType, content, DEBUG_MODEL, '{}', 0]);
}

/**
 * Parse JSON response from LLM
 */
function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim());
    }

    // Try to find JSON object
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }

    throw new Error(`Failed to parse LLM response: ${text.substring(0, 200)}`);
  }
}

// Database helper functions

async function updateSessionAttempt(db, sessionId, attempt) {
  await db.query(`
    UPDATE debug_sessions
    SET current_attempt = $1, updated_at = NOW()
    WHERE id = $2
  `, [attempt, sessionId]);
}

async function updateSessionSuccess(db, sessionId, fileChanges) {
  await db.query(`
    UPDATE debug_sessions
    SET status = 'succeeded', file_changes = $1, updated_at = NOW()
    WHERE id = $2
  `, [JSON.stringify(fileChanges), sessionId]);
}

async function updateSessionFailed(db, sessionId, finalExplanation) {
  await db.query(`
    UPDATE debug_sessions
    SET status = 'failed', final_explanation = $1, updated_at = NOW()
    WHERE id = $2
  `, [finalExplanation, sessionId]);
}

async function updateSessionError(db, sessionId, errorMessage) {
  await db.query(`
    UPDATE debug_sessions
    SET status = 'failed', final_explanation = $1, updated_at = NOW()
    WHERE id = $2
  `, [`Error: ${errorMessage}`, sessionId]);
}

async function createAttempt(db, sessionId, attemptNumber, llmResult) {
  const result = await db.query(`
    INSERT INTO debug_attempts (session_id, attempt_number, explanation, file_changes, succeeded, tokens_used)
    VALUES ($1, $2, $3, $4, false, $5)
    RETURNING *
  `, [
    sessionId,
    attemptNumber,
    llmResult.explanation,
    JSON.stringify(llmResult.fileChanges),
    llmResult.tokensUsed || 0
  ]);

  return result.rows[0];
}

async function updateAttemptResult(db, attemptId, succeeded, buildLogs) {
  await db.query(`
    UPDATE debug_attempts
    SET succeeded = $1, build_logs = $2
    WHERE id = $3
  `, [succeeded, buildLogs, attemptId]);
}

/**
 * Cancel a running debug session
 */
export async function cancelDebugSession(db, sessionId) {
  // Get session with current job info before updating status
  const sessionResult = await db.query(`
    SELECT current_job_name, current_namespace FROM debug_sessions
    WHERE id = $1 AND status = 'running'
  `, [sessionId]);

  if (sessionResult.rows.length === 0) {
    throw new Error('Session not found or not running');
  }

  const { current_job_name, current_namespace } = sessionResult.rows[0];

  // Terminate running Kaniko job if one exists (non-blocking)
  if (current_job_name && current_namespace) {
    const { deleteJob } = await import('./kubernetes.js');
    deleteJob(current_namespace, current_job_name, 'Background')
      .then(() => {
        logger.info({ sessionId, jobName: current_job_name, namespace: current_namespace },
          'Terminated Kaniko job on debug session cancel');
      })
      .catch((err) => {
        logger.warn({ sessionId, jobName: current_job_name, error: err.message },
          'Failed to terminate Kaniko job on debug session cancel');
      });
  }

  // Update session status
  const result = await db.query(`
    UPDATE debug_sessions
    SET status = 'cancelled', current_job_name = NULL, current_namespace = NULL, updated_at = NOW()
    WHERE id = $1 AND status = 'running'
    RETURNING *
  `, [sessionId]);

  if (result.rows.length === 0) {
    throw new Error('Session not found or not running');
  }

  appEvents.emitDebugStatus(sessionId, {
    status: 'cancelled',
    message: 'Debug session cancelled by user'
  });

  return result.rows[0];
}

/**
 * Get debug session by ID
 */
export async function getDebugSession(db, sessionId) {
  const result = await db.query(`
    SELECT * FROM debug_sessions WHERE id = $1
  `, [sessionId]);

  return result.rows[0] || null;
}

/**
 * Get debug session by deployment ID
 */
export async function getDebugSessionByDeployment(db, deploymentId) {
  const result = await db.query(`
    SELECT * FROM debug_sessions
    WHERE deployment_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [deploymentId]);

  return result.rows[0] || null;
}

/**
 * Get active debug session for a service
 */
export async function getActiveDebugSession(db, serviceId) {
  const result = await db.query(`
    SELECT * FROM debug_sessions
    WHERE service_id = $1 AND status = 'running'
    LIMIT 1
  `, [serviceId]);

  return result.rows[0] || null;
}

/**
 * Get all attempts for a debug session
 */
export async function getDebugAttempts(db, sessionId) {
  const result = await db.query(`
    SELECT * FROM debug_attempts
    WHERE session_id = $1
    ORDER BY attempt_number ASC
  `, [sessionId]);

  return result.rows;
}

/**
 * Rollback a debug session to restore original files
 * @param {object} db - Database connection
 * @param {object} session - Debug session object (must include original_files)
 * @returns {Promise<{success: boolean, restoredFiles: string[]}>}
 */
export async function rollbackDebugSession(db, session) {
  const originalFiles = typeof session.original_files === 'string'
    ? JSON.parse(session.original_files)
    : session.original_files;

  if (!originalFiles || Object.keys(originalFiles).length === 0) {
    throw new Error('No original files to restore');
  }

  const restoredFiles = [];

  for (const [filename, content] of Object.entries(originalFiles)) {
    const fileType = filename === 'Dockerfile' ? 'dockerfile' :
                     filename === '.dockerignore' ? 'dockerignore' : null;
    if (fileType && content) {
      await storeGeneratedFile(db, session.service_id, fileType, content);
      restoredFiles.push(filename);
    }
  }

  await db.query(`
    UPDATE debug_sessions
    SET status = 'rolled_back', updated_at = NOW()
    WHERE id = $1
  `, [session.id]);

  logger.info({
    sessionId: session.id,
    serviceId: session.service_id,
    restoredFiles
  }, 'Debug session rolled back');

  appEvents.emitDebugStatus(session.id, {
    status: 'rolled_back',
    message: 'Original files restored',
    restoredFiles
  });

  return { success: true, restoredFiles };
}
