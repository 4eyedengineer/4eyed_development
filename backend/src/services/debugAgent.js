import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getRepoTree, getFileContent, parseGitHubUrl } from './github.js';
import { getGeneratedFile } from './dockerfileGenerator.js';
import { upsertConfigMap, deleteConfigMap, getPodLogs, getPodEvents, getPodHealth, getDeploymentSpec } from './kubernetes.js';
import { triggerBuild, watchBuildJob, captureBuildLogs, deployService, getDecryptedEnvVars } from './buildPipeline.js';
import { updateDeploymentStatus } from './deploymentService.js';
import { runAgent } from './agentRunner.js';
import { createFilesystemTools } from './tools/filesystem.js';
import { createCommandTool } from './tools/command.js';
import { createSandbox, destroySandbox } from './sandboxPod.js';
import appEvents from './event-emitter.js';
import logger from './logger.js';

const DEBUG_MODEL = process.env.DEBUG_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 8000;
const MAX_AGENT_ITERATIONS = 30;

// With ReAct, the agent has its own internal tool-call loop, so the outer
// "rebuild and analyze again" loop can be much shorter than the legacy 10x.
const DEFAULT_AGENT_MAX_ATTEMPTS = 3;

/**
 * System prompt for debug agent - generalist for all failure phases
 */
const DEBUG_SYSTEM_PROMPT = `You are an expert DevOps engineer debugging deployment failures.

You operate in agent mode with filesystem tools over a sandboxed copy of the repository plus diagnostic files. The sandbox contains:
- The repo files (Dockerfile, package.json, source, etc.) — same paths as the repo
- BUILD_LOGS.txt — most recent build output (if a build failure)
- POD_LOGS.txt — application container logs (if a runtime/startup/health failure)
- POD_EVENTS.txt — Kubernetes events
- POD_HEALTH.txt — pod status and restart counts
- DEPLOYMENT_SPEC.txt — current deployment manifest
- TREE.txt — full path listing
- PHASE.txt — one of: build, startup, runtime, health

Workflow:
1. Read PHASE.txt and the relevant log files to understand the failure.
2. Use list_dir / read_file / search to inspect any repo file you need.
3. Modify files in place using write_file or str_replace. Edit the actual files in the sandbox — do NOT just describe a fix.
4. When done, call submit_fix with the list of relative paths you modified plus a short explanation.
5. If the issue cannot be fixed by editing files (source bugs, missing external deps, secrets, resource limits, infra config), call request_manual_fix with clear suggestedActions instead.

You also have a \`run_command\` tool that executes shell commands in a sandbox with the repo files mounted. USE IT AGGRESSIVELY before proposing fixes. Example moves: \`npm ls\` to check installed deps vs imports, \`npx tsc --noEmit\` to reproduce TypeScript errors in seconds instead of minutes, \`cat package.json\` to read from within the build context, \`find . -name 'package.json' -not -path '*/node_modules/*'\` to discover monorepo structure, \`npm run build\` to reproduce the exact failure locally. Every Kaniko rebuild costs 5-10 minutes — running commands costs seconds. Prefer running commands over guessing.

SAFETY:
- NEVER create or modify .env, secrets, credentials, or keys
- Write COMPLETE file contents when using write_file (no diffs / no placeholders / no "..." truncation)
- Only modify files you understand the role of
- Prefer the smallest fix that addresses the root cause

End your turn immediately after calling submit_fix or request_manual_fix.

When the error references a module import ('Cannot find module X', 'No matching version for X'), consider BOTH (a) adding the correct npm package name to package.json, and (b) changing the import specifier in the source files. If package.json fixes alone don't resolve the error, read the actual import statements in the source (.ts, .js, .tsx, .jsx) and verify they reference a real package. Use read_file and search to find the imports, then write_file or str_replace to correct them.`;

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

  // Fetch the current full repo file set once (used to seed each sandbox).
  // Per-attempt diagnostic context (logs, pod health) is refreshed inside the loop.
  const repoSnapshot = await fetchRepoSnapshot(githubToken, service.repo_url, service.branch);

  // Cap outer iterations: each one is a fresh sandbox + agent loop + Kaniko rebuild.
  const outerMax = Math.min(session.max_attempts || DEFAULT_AGENT_MAX_ATTEMPTS, DEFAULT_AGENT_MAX_ATTEMPTS);

  try {
    for (let attempt = 1; attempt <= outerMax; attempt++) {
      await updateSessionAttempt(db, session.id, attempt);

      appEvents.emitDebugStatus(session.id, {
        attempt,
        maxAttempts: outerMax,
        status: 'analyzing',
        message: `Analyzing failure with agent (attempt ${attempt}/${outerMax})...`
      });

      logger.info({ sessionId: session.id, attempt }, 'Starting debug attempt');

      // Run the ReAct agent against a fresh sandbox seeded with current repo state + latest logs.
      const llmResult = await runDebugAgent({
        sessionId: session.id,
        attempt,
        service,
        deployment,
        buildLogs,
        repoSnapshot,
        previousAttempts: attempts,
        namespace,
      });

      const attemptRecord = await createAttempt(db, session.id, attempt, llmResult);
      attempts.push({
        attemptNumber: attempt,
        explanation: llmResult.explanation,
        fileChanges: llmResult.fileChanges,
      });

      // Manual-fix path: agent called request_manual_fix or produced no file changes.
      if (llmResult.needsManualFix || !llmResult.fileChanges || llmResult.fileChanges.length === 0) {
        logger.info({ sessionId: session.id, attempt }, 'Agent indicates manual fix required');

        await updateSessionFailed(db, session.id, llmResult.explanation);

        appEvents.emitDebugStatus(session.id, {
          attempt,
          maxAttempts: outerMax,
          status: 'needs_manual_fix',
          explanation: llmResult.explanation,
          suggestedActions: llmResult.suggestedActions || [],
          message: 'Issue requires manual fix by the user'
        });

        return { success: false, attempts: attempt, needsManualFix: true, explanation: llmResult.explanation, suggestedActions: llmResult.suggestedActions || [] };
      }

      appEvents.emitDebugStatus(session.id, {
        attempt,
        maxAttempts: outerMax,
        status: 'building',
        explanation: llmResult.explanation,
        fileChanges: llmResult.fileChanges,
        message: 'Applying fixes and rebuilding...'
      });

      const buildResult = await rebuildWithChanges(
        db, session.id, service, deployment, llmResult.fileChanges,
        githubToken, namespace, projectName
      );

      await updateAttemptResult(db, attemptRecord.id, buildResult.success, buildResult.logs);

      if (buildResult.success) {
        const finalChanges = llmResult.fileChanges;
        await updateSessionSuccess(db, session.id, finalChanges);

        const envVars = await getDecryptedEnvVars(db, service.id);
        await deployService(db, service, deployment, buildResult.imageTag, namespace, projectName, envVars);

        appEvents.emitDebugStatus(session.id, {
          attempt,
          maxAttempts: outerMax,
          status: 'succeeded',
          explanation: llmResult.explanation,
          fileChanges: finalChanges,
          message: `Build fixed in ${attempt} attempt(s)!`
        });

        logger.info({ sessionId: session.id, attempt }, 'Debug session succeeded');
        return { success: true, attempts: attempt, fileChanges: finalChanges };
      }

      // Build failed — capture latest logs for the next agent attempt.
      buildLogs = buildResult.logs || buildLogs;
      // Also update the in-memory snapshot's view of the modified files so the
      // next attempt sees the previously attempted edits as the new baseline.
      for (const fc of llmResult.fileChanges) {
        repoSnapshot.files[fc.path] = fc.content;
      }

      logger.info({
        sessionId: session.id,
        attempt,
        remaining: outerMax - attempt
      }, 'Debug attempt failed, continuing...');
    }

    const finalExplanation = await generateFinalExplanation(buildLogs, attempts);

    await updateSessionFailed(db, session.id, finalExplanation);

    // Emit failure event
    appEvents.emitDebugStatus(session.id, {
      attempt: outerMax,
      maxAttempts: outerMax,
      status: 'failed',
      finalExplanation,
      message: 'Could not auto-fix after maximum attempts'
    });

    logger.info({ sessionId: session.id }, 'Debug session failed after max attempts');

    return { success: false, attempts: outerMax, finalExplanation };

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
 * Run the ReAct debug agent for one outer attempt.
 *
 * Seeds a sandbox with current repo files + diagnostic logs, lets the
 * model explore and edit via tools, then returns the modified-file set
 * by reading them back from disk.
 */
async function runDebugAgent({ sessionId, attempt, service, deployment, buildLogs, repoSnapshot, previousAttempts, namespace }) {
  const sandboxDir = await createSandboxDir(`debug-${sessionId}-${attempt}`);
  let sandboxPod = null;

  try {
    // Seed sandbox: repo files + tree + diagnostic context.
    await fs.writeFile(path.join(sandboxDir, 'TREE.txt'), repoSnapshot.fileTree, 'utf8');
    for (const [relPath, content] of Object.entries(repoSnapshot.files)) {
      const abs = path.join(sandboxDir, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }

    // Diagnostic context (logs, events, etc).
    const phase = (deployment.status === 'failed' && buildLogs) ? 'build' : 'startup';
    await fs.writeFile(path.join(sandboxDir, 'PHASE.txt'), phase, 'utf8');
    await fs.writeFile(path.join(sandboxDir, 'BUILD_LOGS.txt'), String(buildLogs || 'No build logs available'), 'utf8');

    // Write .gitignore BEFORE initializing git so diagnostic-only files don't
    // pollute the baseline commit or show up in the agent's final diff.
    await fs.writeFile(
      path.join(sandboxDir, '.gitignore'),
      [...INJECTED_DIAGNOSTIC_FILES].join('\n') + '\n',
      'utf8',
    );

    // Git-initialize the sandbox so we can produce a real `git diff` of the
    // agent's changes as a human-facing artifact. Pure local repo — never pushed.
    initSandboxGit(sandboxDir);

    // Snapshot file mtimes so we can detect what the agent modified, even if
    // the agent forgets to declare them in modifiedFiles.
    const baselineMtimes = await snapshotMtimes(sandboxDir);

    // Per-attempt closure state for the submit/manual_fix tools.
    let outcome = null; // {kind: 'fix'|'manual', ...}

    const submitFix = {
      name: 'submit_fix',
      description: 'Submit the fix you applied via write_file / str_replace. Provide a short explanation and the relative paths of files you modified. Calling this ends the agent loop.',
      input_schema: {
        type: 'object',
        required: ['explanation', 'modifiedFiles'],
        properties: {
          explanation: { type: 'string', description: 'Why this fix should resolve the failure' },
          modifiedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative paths of files you modified',
          },
        },
      },
      execute: async (input) => {
        outcome = { kind: 'fix', ...input };
        return 'Fix submitted. End your turn now.';
      },
    };

    const requestManual = {
      name: 'request_manual_fix',
      description: 'Call this when the failure cannot be fixed automatically by editing files (source bugs, missing external services, secrets, resource limits, infra configuration). Provide an explanation and concrete suggestedActions for the user. Calling this ends the agent loop.',
      input_schema: {
        type: 'object',
        required: ['explanation', 'suggestedActions'],
        properties: {
          explanation: { type: 'string', description: 'Why this requires a human to fix' },
          suggestedActions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete steps the user should take',
          },
        },
      },
      execute: async (input) => {
        outcome = { kind: 'manual', ...input };
        return 'Manual fix request recorded. End your turn now.';
      },
    };

    // Spin up an ephemeral Pod mirroring the local sandbox so the agent can
    // run `npm ls`, `tsc --noEmit`, etc. in seconds. If the pod fails to come
    // up (quota, image pull, etc.) we log a warning and continue without the
    // run_command tool — the agent can still use the filesystem tools.
    if (namespace) {
      try {
        sandboxPod = await createSandbox({ namespace, sessionId: `${sessionId}-${attempt}` });
      } catch (err) {
        logger.warn({ sessionId, attempt, err: err.message },
          'Failed to provision sandbox pod; continuing without run_command tool');
        sandboxPod = null;
      }
    }

    const tools = [
      ...createFilesystemTools(sandboxDir, { writable: true }),
      submitFix,
      requestManual,
    ];
    if (sandboxPod) {
      tools.push(createCommandTool({
        namespace: sandboxPod.namespace,
        podName: sandboxPod.podName,
        localSandboxDir: sandboxDir,
      }));
    }

    const initialMessage = buildDebugInitialMessage({
      service,
      deployment,
      attempt,
      previousAttempts,
    });

    const agentResult = await runAgent({
      model: DEBUG_MODEL,
      systemPrompt: DEBUG_SYSTEM_PROMPT,
      initialUserMessage: initialMessage,
      tools,
      maxIterations: MAX_AGENT_ITERATIONS,
      maxTokens: MAX_TOKENS,
    });

    const tokensUsed =
      (agentResult.usage.input_tokens || 0) + (agentResult.usage.output_tokens || 0);

    logger.info({
      sessionId,
      attempt,
      iterations: agentResult.iterations,
      stopReason: agentResult.stopReason,
      cacheRead: agentResult.usage.cache_read_input_tokens,
      tokensUsed,
    }, 'Debug agent finished');

    // Path 1: agent asked for manual fix.
    if (outcome?.kind === 'manual') {
      return {
        explanation: outcome.explanation || 'Manual fix required',
        fileChanges: [],
        needsManualFix: true,
        suggestedActions: outcome.suggestedActions || [],
        tokensUsed,
      };
    }

    // Path 2: agent submitted a fix. Read modified files back from sandbox.
    // Use both the agent-declared list and a diff against baseline mtimes for safety.
    const modifiedRelPaths = await detectModifiedFiles(sandboxDir, baselineMtimes, outcome?.modifiedFiles || []);
    const fileChanges = [];
    for (const rel of modifiedRelPaths) {
      // Skip our injected diagnostic files — those aren't part of the repo.
      if (isInjectedDiagnosticPath(rel)) continue;
      try {
        const content = await fs.readFile(path.join(sandboxDir, rel), 'utf8');
        fileChanges.push({ path: rel, content });
      } catch (err) {
        logger.warn({ rel, err: err.message }, 'Failed to read modified file from sandbox');
      }
    }

    // Capture a unified git diff against the seed commit BEFORE the Kaniko
    // rebuild — this is the human-facing artifact the UI will render.
    // Also commit the agent's edits on top of the seed so future attempts
    // (or humans) can inspect the delta chain.
    const gitDiff = captureSandboxDiff(sandboxDir, attempt);

    if (!outcome) {
      // Agent ran out of iterations / hit token budget without submitting.
      return {
        explanation: `Agent did not complete (stop_reason=${agentResult.stopReason}, iterations=${agentResult.iterations}). ${fileChanges.length} file(s) were modified but not formally submitted.`,
        fileChanges,
        gitDiff,
        needsManualFix: fileChanges.length === 0,
        suggestedActions: fileChanges.length === 0 ? ['Inspect build logs and fix manually'] : [],
        tokensUsed,
      };
    }

    return {
      explanation: outcome.explanation || 'No explanation provided',
      fileChanges,
      gitDiff,
      needsManualFix: false,
      tokensUsed,
    };
  } finally {
    await cleanupSandbox(sandboxDir);
    if (sandboxPod) {
      await destroySandbox(sandboxPod);
    }
  }
}

/**
 * Build the user-message kickoff for the debug agent.
 */
function buildDebugInitialMessage({ service, deployment, attempt, previousAttempts }) {
  let msg = `Debug attempt ${attempt} for service "${service.name}" (deployment ${deployment.id}).\n\n`;
  msg += `Repo: ${service.repo_url} (branch: ${service.branch})\n\n`;
  msg += `Start by reading PHASE.txt and BUILD_LOGS.txt to understand the failure. Then explore the repo files (the sandbox already has them). Apply your fix using write_file or str_replace, then call submit_fix.\n\n`;

  if (previousAttempts.length > 0) {
    msg += `## Previous attempts in this session (did NOT fix the issue)\n`;
    for (const a of previousAttempts) {
      msg += `- Attempt ${a.attemptNumber}: ${a.explanation}`;
      if (a.fileChanges && a.fileChanges.length > 0) {
        msg += ` (modified: ${a.fileChanges.map(f => f.path).join(', ')})`;
      }
      msg += '\n';
    }
    msg += '\nTry a different approach this time.\n';
  }

  return msg;
}

/**
 * Generate a final user-facing explanation when outer attempts are exhausted.
 * Uses the agent runner with no tools so we still get prompt caching.
 */
async function generateFinalExplanation(buildLogs, attempts) {
  const userMessage = `After ${attempts.length} attempts, we could not automatically fix this deployment failure.

## Latest build logs
\`\`\`
${String(buildLogs).slice(-4000)}
\`\`\`

## Attempts tried
${attempts.map(a => `- Attempt ${a.attemptNumber}: ${a.explanation}`).join('\n')}

Please provide:
1. A clear explanation of why the failure cannot be automatically fixed
2. Specific manual steps the user can take

Be concise and actionable.`;

  try {
    const result = await runAgent({
      model: DEBUG_MODEL,
      systemPrompt: 'You are a helpful DevOps engineer explaining why a deployment cannot be automatically fixed and what the user should do. Respond as plain text.',
      initialUserMessage: userMessage,
      tools: [],
      maxIterations: 2,
      maxTokens: 2000,
    });
    const finalText = (result.finalMessage?.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    return finalText || 'Unable to generate explanation';
  } catch (err) {
    logger.warn({ err: err.message }, 'generateFinalExplanation failed');
    return 'Unable to generate explanation';
  }
}

// ---------- sandbox helpers ----------

async function createSandboxDir(prefix) {
  const base = path.join(os.tmpdir(), 'dangus-agent');
  await fs.mkdir(base, { recursive: true });
  const dir = path.join(base, `${prefix}-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupSandbox(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ dir, err: err.message }, 'Failed to clean up debug sandbox');
  }
}

const INJECTED_DIAGNOSTIC_FILES = new Set([
  'TREE.txt', 'PHASE.txt', 'BUILD_LOGS.txt',
  'POD_LOGS.txt', 'POD_EVENTS.txt', 'POD_HEALTH.txt', 'DEPLOYMENT_SPEC.txt',
]);

function isInjectedDiagnosticPath(rel) {
  return INJECTED_DIAGNOSTIC_FILES.has(rel);
}

/**
 * Run a git subcommand in the sandbox with no shell interpolation.
 * Returns stdout as a utf8 string. Throws on non-zero exit unless
 * `allowFailure` is true (in which case returns empty string).
 */
function git(sandboxDir, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: sandboxDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      // Avoid inheriting the host user's global git config (GPG signing,
      // commit.template, hooks, etc) — we want a hermetic local repo.
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        HOME: sandboxDir,
      },
    });
  } catch (err) {
    if (allowFailure) return '';
    throw err;
  }
}

/**
 * Initialize a local git repo in the sandbox and commit the seeded files as
 * the baseline. Uses a repo-local user.name / user.email so no host config
 * is required.
 */
function initSandboxGit(sandboxDir) {
  try {
    git(sandboxDir, ['init', '-q', '-b', 'main']);
    git(sandboxDir, ['config', 'user.name', 'dangus-agent']);
    git(sandboxDir, ['config', 'user.email', 'dangus-agent@local']);
    git(sandboxDir, ['config', 'commit.gpgsign', 'false']);
    git(sandboxDir, ['add', '-A']);
    git(sandboxDir, ['commit', '-q', '--allow-empty', '-m', 'seed: repo snapshot + diagnostics']);
  } catch (err) {
    logger.warn({ err: err.message }, 'initSandboxGit failed — diff capture will be disabled for this attempt');
  }
}

/**
 * Produce a unified git patch of everything the agent changed in the sandbox
 * relative to the seed commit (tracked diffs + untracked additions), then
 * commit the agent's changes so the HEAD advances. Returns a string safe to
 * store in the `git_diff` column; empty string if git isn't available.
 */
function captureSandboxDiff(sandboxDir, attemptNumber) {
  try {
    // Stage everything so `git diff --cached HEAD` includes untracked files.
    git(sandboxDir, ['add', '-A']);

    const diff = git(sandboxDir, ['diff', '--cached', '--unified=3', 'HEAD'], { allowFailure: true });
    const status = git(sandboxDir, ['status', '--porcelain'], { allowFailure: true });

    // Only commit if there's actually something staged.
    if (status.trim().length > 0) {
      git(sandboxDir, [
        'commit', '-q', '--allow-empty',
        '-m', `agent fix attempt ${attemptNumber}`,
      ], { allowFailure: true });
    }

    return diff || '';
  } catch (err) {
    logger.warn({ err: err.message, attemptNumber }, 'captureSandboxDiff failed');
    return '';
  }
}

/**
 * Walk sandbox and capture mtimeMs for every file.
 */
async function snapshotMtimes(root) {
  const out = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        try {
          const st = await fs.stat(full);
          out.set(path.relative(root, full), st.mtimeMs);
        } catch { /* ignore */ }
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Detect files that were created or modified vs the baseline snapshot.
 * Merges in the agent-declared `declared` list (relative paths) for safety.
 */
async function detectModifiedFiles(root, baseline, declared) {
  const current = await snapshotMtimes(root);
  const set = new Set();
  for (const [rel, mt] of current.entries()) {
    const prior = baseline.get(rel);
    if (prior === undefined || mt !== prior) set.add(rel);
  }
  for (const rel of declared) {
    if (typeof rel === 'string' && rel.length > 0) set.add(rel);
  }
  return [...set];
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
 * Fetch repository snapshot for the agent sandbox.
 * Returns the same {fileTree, files} shape we used pre-refactor — the agent
 * runner writes `files` to disk and exposes `fileTree` as TREE.txt so the
 * model can browse paths it didn't get pre-loaded.
 */
async function fetchRepoSnapshot(githubToken, repoUrl, branch) {
  const tree = await getRepoTree(githubToken, repoUrl, branch);

  const fileTree = tree
    .map(f => f.path)
    .sort()
    .slice(0, 200)
    .join('\n');

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
    INSERT INTO debug_attempts (session_id, attempt_number, explanation, file_changes, succeeded, tokens_used, git_diff)
    VALUES ($1, $2, $3, $4, false, $5, $6)
    RETURNING *
  `, [
    sessionId,
    attemptNumber,
    llmResult.explanation,
    JSON.stringify(llmResult.fileChanges),
    llmResult.tokensUsed || 0,
    llmResult.gitDiff || null,
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
