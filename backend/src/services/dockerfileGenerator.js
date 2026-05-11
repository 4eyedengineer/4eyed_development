import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_MODEL, isLLMAvailable } from './llmClient.js';
import { runAgent } from './agentRunner.js';
import { createFilesystemTools } from './tools/filesystem.js';
import { createCommandTool } from './tools/command.js';
import { createSandbox, destroySandbox, cloneRepoIntoSandbox } from './sandboxPod.js';
import logger from './logger.js';

// Sandbox pods all live in the backend's own namespace. Simpler RBAC, and
// the repo-connect preflight (no project yet) still has a home to spawn in.
const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || 'dangus-cloud';

const MAX_AGENT_ITERATIONS = 30;
const MAX_AGENT_TOKENS = 8000;

// Regex that matches common build/compile commands. When we see `exit=0` on
// one of these via run_command, we mark the build as validated. This is the
// gate that unlocks submit_dockerfile.
const BUILD_COMMAND_PATTERNS = [
  /\bnpm\s+(ci|install)\b.*&&.*\b(npm|pnpm|yarn)\s+(run\s+)?build\b/,
  /\b(npm|pnpm|yarn)\s+(run\s+)?build\b/,
  /\bnpx\s+tsc\b/,
  /\bnext\s+build\b/,
  /\bvite\s+build\b/,
  /\bgo\s+build\b/,
  /\bcargo\s+build\b/,
  /\bmvn\s+(package|verify|install)\b/,
  /\bgradle\s+(build|assemble)\b/,
  /\bpython\s+-m\s+build\b/,
  /\bpip\s+install\b.*-r\s+requirements\.txt/,
  /\bbundle\s+exec\b/,
  /\bdotnet\s+(build|publish)\b/,
  /\bmake\b/,
];

const SYSTEM_PROMPT = `You are an expert DevOps engineer who emits Dockerfiles that are VALIDATED — not guessed.

Your goal: produce a Dockerfile where the build steps DEMONSTRABLY succeed against the real repo in an isolated sandbox. If you cannot prove the build works, you surface the failure loudly instead of shipping a broken Dockerfile.

## Environment
- An ephemeral sandbox Pod is provisioned with the repo cloned at /workspace.
- Running as root in a Debian bookworm container (image \`node:20-bookworm\` by default).
- PRE-INSTALLED: node 20, npm, git, curl, python3, pip, gcc/g++, make, ca-certificates, common POSIX tools.
- APT IS READY: \`apt-get install -y <pkg>\` works without a separate \`apt-get update\` (the base image ships with package lists).
  - Ruby: \`apt-get install -y ruby-full\`
  - Java: \`apt-get install -y default-jdk\` (or \`openjdk-17-jdk-headless\`)
  - PHP: \`apt-get install -y php-cli php-fpm composer\`
  - Pnpm/yarn: \`npm install -g pnpm\` (or yarn)
  - Poetry/uv: \`pip install --break-system-packages poetry uv\`
- BINARY RUNTIMES (download via curl):
  - Go: \`curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | tar -xz -C /usr/local && export PATH=/usr/local/go/bin:$PATH\`
  - Rust: \`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && . $HOME/.cargo/env\`
  - Bun: \`curl -fsSL https://bun.sh/install | bash && export PATH=$HOME/.bun/bin:$PATH\`
- Detect the stack FIRST (read package.json, pyproject.toml, go.mod, Gemfile, pom.xml, Cargo.toml, composer.json, etc.), then install ONLY what that stack needs. Do not bulk-install runtimes you won't use. If setup becomes too involved, call cannot_validate instead of guessing.

## Tools
- **run_command**: execute shell commands in the sandbox. THIS IS YOUR PRIMARY TOOL. Use it to inspect the repo (\`ls /workspace\`, \`cat /workspace/package.json\`, \`find /workspace -maxdepth 3 -name package.json -not -path '*/node_modules/*'\`), install deps, and run builds. Every run_command call syncs your authored Dockerfile + .dockerignore into /workspace first.
- **read_file / write_file / str_replace / list_dir / search**: operate on your LOCAL scratch dir. That dir exists only to hold files you AUTHOR — primarily \`Dockerfile\` and \`.dockerignore\`. Do NOT try to read repo source via filesystem tools; the scratch dir doesn't have them. Use run_command (\`cat /workspace/src/foo.ts\`) for repo inspection.
- **submit_dockerfile**: submit the validated result. THIS IS REJECTED unless you have previously run a build command and seen exit=0 via run_command. Schema-valid but rejected-in-body until you earn it.
- **cannot_validate**: declare that the build cannot be made to succeed in this sandbox. Reserve for genuine user-facing problems (missing private dep, broken source, unsupported build setup). Ends the loop with a failure surfaced to the user.

## Workflow
1. Inspect: \`ls /workspace\` and \`cat /workspace/package.json\` (or equivalent for the stack). Look for monorepo layout — multiple package.json, nx.json, turbo.json, workspaces.
2. Decide: language, framework, which subdir is the deployable app, build command.
3. Author Dockerfile + .dockerignore in the local scratch dir via write_file.
4. VALIDATE: run the Dockerfile's build commands in the sandbox (e.g. \`cd /workspace && npm ci && npm run build\`). If it fails, read the error, amend the Dockerfile, try again. You may need several iterations — this is expected.
5. Once a build command exits 0, call submit_dockerfile.

## Rules
- NEVER modify files in /workspace (repo source is read-only to you). Only author the Dockerfile + .dockerignore locally.
- Use specific version tags (never :latest). Prefer alpine/slim bases.
- Multi-stage builds when beneficial (build stage → runtime stage).
- Run as non-root. chown any writable dirs before switching USER.
- Set EXPOSE to the actual port the app listens on — confirm by grepping the source (\`grep -r "listen(" /workspace/src\` or checking start scripts).
- Keep it minimal: the Dockerfile is a recipe of what you just proved works, not a kitchen sink.

## End your turn immediately after calling submit_dockerfile or cannot_validate.`;

/**
 * Public: generate a validated Dockerfile for a service that doesn't have one.
 * Stores result in DB, mirrors the previous return shape.
 */
export async function generateForService(db, service, githubToken) {
  if (!isLLMAvailable()) {
    throw new Error('LLM generation not available: ANTHROPIC_API_KEY not configured');
  }

  const { repo_url: repoUrl, branch } = service;
  logger.info({ serviceId: service.id, repoUrl }, 'Starting validated Dockerfile generation');

  const result = await runDockerfileAgent({
    githubToken,
    repoUrl,
    branch,
    sessionId: `svc-${service.id.slice(0, 12)}`,
  });

  await storeGeneratedFile(db, service.id, 'dockerfile', result.dockerfile, result);
  await storeGeneratedFile(db, service.id, 'dockerignore', result.dockerignore, result);

  logger.info({
    serviceId: service.id,
    language: result.language,
    framework: result.framework,
    port: result.detectedPort,
    tokensUsed: result.tokensUsed,
    validatedBy: result.validatedBy,
  }, 'Validated Dockerfile stored');

  return {
    dockerfile: result.dockerfile,
    dockerignore: result.dockerignore,
    detectedPort: result.detectedPort,
    framework: {
      language: result.language,
      framework: result.framework,
      explanation: result.explanation,
    },
    tokensUsed: result.tokensUsed,
    validatedBy: result.validatedBy,
  };
}

/**
 * Public: generate and validate a Dockerfile without persisting (pre-creation).
 */
export async function generateForRepo(githubToken, repoUrl, branch) {
  if (!isLLMAvailable()) {
    throw new Error('LLM generation not available: ANTHROPIC_API_KEY not configured');
  }
  logger.info({ repoUrl, branch }, 'Starting validated Dockerfile generation for repo');
  const result = await runDockerfileAgent({
    githubToken,
    repoUrl,
    branch,
    sessionId: `preflight-${crypto.randomBytes(3).toString('hex')}`,
  });
  return {
    dockerfile: result.dockerfile,
    dockerignore: result.dockerignore,
    detectedPort: result.detectedPort,
    framework: {
      language: result.language,
      framework: result.framework,
      explanation: result.explanation,
    },
    tokensUsed: result.tokensUsed,
    validatedBy: result.validatedBy,
  };
}

/**
 * Structured error surfaced when validation cannot succeed. Routes/deploy
 * flow should catch this specifically and render it to the user.
 */
export class DockerfileValidationError extends Error {
  constructor(reason, { suggestedUserActions, buildOutput, stage = 'validation' } = {}) {
    super(reason);
    this.name = 'DockerfileValidationError';
    this.reason = reason;
    this.suggestedUserActions = suggestedUserActions || null;
    this.buildOutput = buildOutput || null;
    this.stage = stage;
  }
}

/**
 * Core ReAct loop: spawn sandbox, clone, run agent, enforce validation gate.
 */
async function runDockerfileAgent({ githubToken, repoUrl, branch, sessionId }) {
  const localSandboxDir = await createSandboxDir('dockerfile');
  let sandboxPod = null;

  try {
    sandboxPod = await createSandbox({ namespace: SANDBOX_NAMESPACE, sessionId });

    await cloneRepoIntoSandbox({
      namespace: SANDBOX_NAMESPACE,
      podName: sandboxPod.podName,
      repoUrl,
      branch,
      githubToken,
    });

    // --- State tracked via closures over the tool descriptors ---
    let buildValidated = false;
    let buildEvidence = null;
    let submitted = null;
    let cannotValidate = null;

    const fsTools = createFilesystemTools(localSandboxDir, { writable: true });

    // Wrap run_command so we can inspect outputs and mark successful builds.
    const baseCommandTool = createCommandTool({
      namespace: SANDBOX_NAMESPACE,
      podName: sandboxPod.podName,
      localSandboxDir,
    });
    const commandTool = {
      ...baseCommandTool,
      execute: async (input) => {
        const result = await baseCommandTool.execute(input);
        const text = typeof result === 'string' ? result : result?.content || '';
        if (/^exit=0\b/.test(text)) {
          const cmd = (input.command || '').trim();
          if (BUILD_COMMAND_PATTERNS.some((re) => re.test(cmd))) {
            buildValidated = true;
            buildEvidence = {
              command: cmd,
              outputTail: text.slice(-600),
            };
            logger.info({ cmd }, 'dockerfileGenerator: build validated');
          }
        }
        return result;
      },
    };

    const submitTool = {
      name: 'submit_dockerfile',
      description:
        'Submit the validated Dockerfile and .dockerignore. REJECTED unless you have previously run a build command (e.g. `npm ci && npm run build`) via run_command and seen exit=0 in the same session. Do not call this on guesswork.',
      input_schema: {
        type: 'object',
        required: ['dockerfile', 'dockerignore', 'detectedPort', 'framework', 'language', 'explanation'],
        properties: {
          dockerfile: { type: 'string', description: 'Complete Dockerfile contents' },
          dockerignore: { type: 'string', description: 'Complete .dockerignore contents' },
          detectedPort: { type: 'integer', description: 'Port the application listens on' },
          framework: { type: 'string', description: 'Framework slug (e.g. "nextjs", "django")' },
          language: { type: 'string', description: 'Language slug (e.g. "nodejs", "python")' },
          explanation: { type: 'string', description: 'One paragraph on key decisions, including the build command you proved works' },
        },
      },
      execute: async (input) => {
        if (!buildValidated) {
          return {
            content:
              'REJECTED: You have not yet proven the build works. Run the Dockerfile\'s build command (e.g. `cd /workspace && npm ci && npm run build`) via run_command and confirm exit=0 BEFORE calling submit_dockerfile. If you cannot make the build succeed, call cannot_validate instead.',
            is_error: true,
          };
        }
        submitted = input;
        return 'Dockerfile accepted. End your turn now.';
      },
    };

    const cannotValidateTool = {
      name: 'cannot_validate',
      description:
        'Declare that the build cannot be made to succeed in this sandbox. Use this only after genuine attempts — if a missing dep, broken source, or unsupported setup blocks you. Ends the loop and surfaces the failure to the user.',
      input_schema: {
        type: 'object',
        required: ['reason', 'suggestedUserActions'],
        properties: {
          reason: {
            type: 'string',
            description: 'Concrete one-paragraph explanation of why validation cannot succeed.',
          },
          suggestedUserActions: {
            type: 'string',
            description: 'What the user should do to unblock (e.g. "commit a tsconfig.json", "fix the import of @square/foo in src/bar.ts").',
          },
          buildOutput: {
            type: 'string',
            description: 'Most relevant build output (errors) for diagnosis. ~500 chars.',
          },
        },
      },
      execute: async (input) => {
        cannotValidate = input;
        return 'Failure recorded. End your turn now.';
      },
    };

    const tools = [...fsTools, commandTool, submitTool, cannotValidateTool];

    const initialMessage = `Generate a validated Dockerfile + .dockerignore for ${repoUrl} (branch: ${branch}).

The sandbox Pod is ready with the repo cloned at /workspace. Start by running \`ls /workspace && cat /workspace/package.json 2>/dev/null || true\` (or the equivalent for the stack you detect) via run_command to orient yourself. Look for monorepo markers.

Then author the Dockerfile locally via write_file, run the build in the sandbox, iterate until it succeeds, and finally call submit_dockerfile. If the build fundamentally cannot succeed, call cannot_validate.`;

    const agentResult = await runAgent({
      model: DEFAULT_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      initialUserMessage: initialMessage,
      tools,
      maxIterations: MAX_AGENT_ITERATIONS,
      maxTokens: MAX_AGENT_TOKENS,
      onEvent: (event) => {
        if (event.type === 'tool_use') {
          // Truncate inputs to keep logs readable.
          const summary = {};
          if (event.name === 'run_command') summary.cmd = String(event.input?.command || '').slice(0, 160);
          else if (event.name === 'write_file') summary.path = event.input?.path;
          else if (event.name === 'str_replace') summary.path = event.input?.path;
          else if (event.name === 'read_file') summary.path = event.input?.path;
          else if (event.name === 'list_dir') summary.path = event.input?.path;
          else if (event.name === 'search') summary.q = event.input?.query;
          else if (event.name === 'submit_dockerfile') summary.detectedPort = event.input?.detectedPort;
          else if (event.name === 'cannot_validate') summary.reason = String(event.input?.reason || '').slice(0, 120);
          logger.info({ tool: event.name, iter: event.iteration, ...summary }, 'agent tool call');
        }
      },
    });

    const tokensUsed =
      (agentResult.usage.input_tokens || 0) + (agentResult.usage.output_tokens || 0);

    logger.info({
      repoUrl,
      iterations: agentResult.iterations,
      cacheRead: agentResult.usage.cache_read_input_tokens,
      cacheCreate: agentResult.usage.cache_creation_input_tokens,
      tokensUsed,
      buildValidated,
      submitted: !!submitted,
      cannotValidate: !!cannotValidate,
    }, 'Dockerfile agent finished');

    if (submitted) {
      return {
        dockerfile: submitted.dockerfile,
        dockerignore: submitted.dockerignore,
        detectedPort: submitted.detectedPort,
        framework: submitted.framework,
        language: submitted.language,
        explanation: submitted.explanation,
        tokensUsed,
        validatedBy: buildEvidence?.command || 'unknown',
      };
    }

    if (cannotValidate) {
      throw new DockerfileValidationError(cannotValidate.reason, {
        suggestedUserActions: cannotValidate.suggestedUserActions,
        buildOutput: cannotValidate.buildOutput,
        stage: 'agent-declined',
      });
    }

    // Hit iteration cap or unexpected stop — also a loud failure.
    throw new DockerfileValidationError(
      `Validation agent did not reach a verdict (stop_reason=${agentResult.stopReason}, iterations=${agentResult.iterations}, validated=${buildValidated}).`,
      {
        suggestedUserActions:
          'Check the build logs. The automated validator ran out of iterations without either proving the build works or declaring it unfixable. This usually means the build setup is unusual — consider committing a Dockerfile yourself.',
        stage: 'no-verdict',
      },
    );
  } finally {
    if (sandboxPod) await destroySandbox(sandboxPod);
    await cleanupSandbox(localSandboxDir);
  }
}

// ---------- helpers ----------

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
    logger.warn({ dir, err: err.message }, 'Failed to clean up sandbox dir');
  }
}

async function storeGeneratedFile(db, serviceId, fileType, content, metadata) {
  const { language, framework, detectedPort, explanation, tokensUsed, validatedBy } = metadata;
  const detectedFramework = { language, framework, port: detectedPort, explanation, validatedBy };
  await db.query(`
    INSERT INTO generated_files (service_id, file_type, content, llm_model, detected_framework, tokens_used)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (service_id, file_type)
    DO UPDATE SET
      content = EXCLUDED.content,
      llm_model = EXCLUDED.llm_model,
      detected_framework = EXCLUDED.detected_framework,
      tokens_used = EXCLUDED.tokens_used,
      updated_at = NOW()
  `, [serviceId, fileType, content, DEFAULT_MODEL, JSON.stringify(detectedFramework), tokensUsed]);
}

export async function getGeneratedFile(db, serviceId, fileType) {
  const result = await db.query(`
    SELECT content, detected_framework, tokens_used, created_at, updated_at
    FROM generated_files
    WHERE service_id = $1 AND file_type = $2
  `, [serviceId, fileType]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    content: row.content,
    detectedFramework: row.detected_framework,
    tokensUsed: row.tokens_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function hasGeneratedDockerfile(db, serviceId) {
  const result = await db.query(`
    SELECT 1 FROM generated_files
    WHERE service_id = $1 AND file_type = 'dockerfile'
    LIMIT 1
  `, [serviceId]);
  return result.rows.length > 0;
}

export async function deleteGeneratedFiles(db, serviceId) {
  await db.query(`DELETE FROM generated_files WHERE service_id = $1`, [serviceId]);
}
