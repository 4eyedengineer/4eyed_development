import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getRepoTree, getFileContent } from './github.js';
import { DEFAULT_MODEL, isLLMAvailable } from './llmClient.js';
import { runAgent } from './agentRunner.js';
import { createFilesystemTools } from './tools/filesystem.js';
import logger from './logger.js';

// Files that hint at project type — used to seed the sandbox so the model
// has fast paths to common config without spending tool calls hunting.
const IMPORTANT_FILES = [
  // Node.js
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.nvmrc', '.node-version', 'tsconfig.json',
  'next.config.js', 'next.config.mjs', 'nuxt.config.js', 'nuxt.config.ts',
  'vite.config.js', 'vite.config.ts', 'svelte.config.js',
  // Python
  'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg',
  'poetry.lock', 'manage.py',
  // Go
  'go.mod', 'go.sum',
  // Rust
  'Cargo.toml', 'Cargo.lock',
  // Ruby
  'Gemfile', 'Gemfile.lock', 'config.ru',
  // PHP
  'composer.json', 'composer.lock',
  // Java
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts',
  // General
  'Procfile', 'Makefile', 'README.md', 'readme.md',
];

const IMPORTANT_EXTENSIONS = ['.csproj', '.fsproj', '.sln'];

const MAX_TREE_ENTRIES = 200;
const MAX_FILE_CONTENT_SIZE = 10000;
const MAX_AGENT_ITERATIONS = 20;
const MAX_AGENT_TOKENS = 8000;

const DOCKERFILE_SYSTEM_PROMPT = `You are an expert DevOps engineer generating production-ready Dockerfiles for Kubernetes deployment.

You are operating in agent mode with filesystem tools over a sandboxed copy of the repository. The sandbox root contains the most important config files plus a TREE.txt listing all paths. Use the tools to inspect anything you need:
- list_dir to explore directories
- read_file to load specific files (package.json scripts, tsconfig, framework config, lockfile entries)
- search to grep for things like "EXPOSE", "PORT", "listen(", framework markers

When you have enough information to produce a confident answer, call submit_dockerfile with the final result. Do NOT emit prose after submit_dockerfile — that call ends the conversation. Avoid reading large dependency files unless you really need them.

Generate a Dockerfile and .dockerignore optimized for the detected language/framework.

REQUIREMENTS:
- Use specific version tags (never :latest)
- Use multi-stage builds when beneficial
- Run as non-root user for security
- Include EXPOSE for the detected port
- Optimize layer caching (deps before source)
- Use alpine/slim base images when possible
- Include HEALTHCHECK when appropriate

CRITICAL FOR NON-ROOT:
Before switching to a non-root USER, fix permissions on ALL directories the process writes to at runtime (cache dirs, log dirs, pid files, etc). This is especially important for web servers like nginx/apache.

When submitting:
- "dockerfile" must be the complete Dockerfile contents
- "dockerignore" must be the complete .dockerignore contents
- "detectedPort" is the integer port the app listens on
- "framework" is a short slug (e.g. "nextjs", "django", "rails", "express", "fastify", "spring-boot", "static-nginx")
- "language" is a short slug (e.g. "nodejs", "python", "go", "ruby")
- "explanation" is one paragraph on the key choices you made`;

/**
 * Public: generate a Dockerfile for a service that doesn't have one.
 * Stores result in DB, mirrors the previous return shape.
 */
export async function generateForService(db, service, githubToken) {
  if (!isLLMAvailable()) {
    throw new Error('LLM generation not available: ANTHROPIC_API_KEY not configured');
  }

  const { repo_url: repoUrl, branch } = service;
  logger.info({ serviceId: service.id, repoUrl }, 'Starting Dockerfile generation');

  const result = await runDockerfileAgent(githubToken, repoUrl, branch);

  await storeGeneratedFile(db, service.id, 'dockerfile', result.dockerfile, result);
  await storeGeneratedFile(db, service.id, 'dockerignore', result.dockerignore, result);

  logger.info({
    serviceId: service.id,
    language: result.language,
    framework: result.framework,
    port: result.detectedPort,
    tokensUsed: result.tokensUsed,
  }, 'Dockerfile generation complete');

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
  };
}

/**
 * Public: generate a Dockerfile without persisting (pre-creation analysis).
 */
export async function generateForRepo(githubToken, repoUrl, branch) {
  if (!isLLMAvailable()) {
    throw new Error('LLM generation not available: ANTHROPIC_API_KEY not configured');
  }
  logger.info({ repoUrl, branch }, 'Starting Dockerfile generation for repo');
  const result = await runDockerfileAgent(githubToken, repoUrl, branch);
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
  };
}

/**
 * Core ReAct loop wrapper. Creates sandbox, seeds it, runs agent, cleans up.
 */
async function runDockerfileAgent(githubToken, repoUrl, branch) {
  const sandboxDir = await createSandboxDir('dockerfile');

  try {
    // Seed sandbox: fetch tree + important files via GitHub API.
    const tree = await getRepoTree(githubToken, repoUrl, branch);
    const fileTree = formatFileTree(tree);
    const seededFiles = await fetchImportantFiles(githubToken, repoUrl, branch, tree);

    await fs.writeFile(path.join(sandboxDir, 'TREE.txt'), fileTree, 'utf8');
    for (const [relPath, content] of Object.entries(seededFiles)) {
      const abs = path.join(sandboxDir, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }

    // Capture submitted result via closure.
    let submitted = null;
    const submitTool = {
      name: 'submit_dockerfile',
      description: 'Submit the final Dockerfile and .dockerignore for this repository. Calling this ends the agent loop. Do not call until you are confident in your answer.',
      input_schema: {
        type: 'object',
        required: ['dockerfile', 'dockerignore', 'detectedPort', 'framework', 'language', 'explanation'],
        properties: {
          dockerfile: { type: 'string', description: 'Complete Dockerfile contents' },
          dockerignore: { type: 'string', description: 'Complete .dockerignore contents' },
          detectedPort: { type: 'integer', description: 'Port the application listens on' },
          framework: { type: 'string', description: 'Framework slug (e.g. "nextjs", "django")' },
          language: { type: 'string', description: 'Language slug (e.g. "nodejs", "python")' },
          explanation: { type: 'string', description: 'One paragraph on key decisions' },
        },
      },
      execute: async (input) => {
        submitted = input;
        return 'Dockerfile submitted successfully. End your turn now.';
      },
    };

    const tools = [
      ...createFilesystemTools(sandboxDir, { writable: false }),
      submitTool,
    ];

    const initialMessage = `Generate a production-ready Dockerfile and .dockerignore for the repository at ${repoUrl} (branch: ${branch}).

The sandbox contains pre-fetched key config files plus TREE.txt listing the full repo path set. Start by reading TREE.txt and any obvious config (package.json, pyproject.toml, go.mod, etc.) to identify the language/framework. Use additional tool calls only if you need details to make a correct decision (e.g. start scripts, port configuration, framework-specific build steps).

When ready, call submit_dockerfile with the final answer.`;

    const agentResult = await runAgent({
      model: DEFAULT_MODEL,
      systemPrompt: DOCKERFILE_SYSTEM_PROMPT,
      initialUserMessage: initialMessage,
      tools,
      maxIterations: MAX_AGENT_ITERATIONS,
      maxTokens: MAX_AGENT_TOKENS,
    });

    if (!submitted) {
      throw new Error(
        `Dockerfile agent ended without calling submit_dockerfile (stop_reason=${agentResult.stopReason}, iterations=${agentResult.iterations})`
      );
    }

    const tokensUsed =
      (agentResult.usage.input_tokens || 0) + (agentResult.usage.output_tokens || 0);

    logger.info({
      repoUrl,
      iterations: agentResult.iterations,
      cacheRead: agentResult.usage.cache_read_input_tokens,
      cacheCreate: agentResult.usage.cache_creation_input_tokens,
      tokensUsed,
    }, 'Dockerfile agent finished');

    return {
      dockerfile: submitted.dockerfile,
      dockerignore: submitted.dockerignore,
      detectedPort: submitted.detectedPort,
      framework: submitted.framework,
      language: submitted.language,
      explanation: submitted.explanation,
      tokensUsed,
    };
  } finally {
    await cleanupSandbox(sandboxDir);
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

function formatFileTree(tree) {
  return tree
    .map(f => f.path)
    .sort()
    .slice(0, MAX_TREE_ENTRIES)
    .join('\n');
}

async function fetchImportantFiles(token, repoUrl, branch, tree) {
  const files = {};
  const filePaths = tree.map(f => f.path);
  const filesToFetch = [];

  for (const importantFile of IMPORTANT_FILES) {
    if (filePaths.includes(importantFile)) filesToFetch.push(importantFile);
    if (filePaths.includes(`src/${importantFile}`)) filesToFetch.push(`src/${importantFile}`);
  }
  for (const ext of IMPORTANT_EXTENSIONS) {
    const matches = filePaths.filter(p => p.endsWith(ext) && !p.includes('/'));
    filesToFetch.push(...matches.slice(0, 3));
  }

  const limited = filesToFetch.slice(0, 15);
  await Promise.all(limited.map(async (filePath) => {
    try {
      const result = await getFileContent(token, repoUrl, filePath, branch);
      if (result?.content) {
        const content = result.content.length > MAX_FILE_CONTENT_SIZE
          ? result.content.substring(0, MAX_FILE_CONTENT_SIZE) + '\n... (truncated)'
          : result.content;
        files[filePath] = content;
      }
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'Failed to fetch file');
    }
  }));

  return files;
}

async function storeGeneratedFile(db, serviceId, fileType, content, metadata) {
  const { language, framework, detectedPort, explanation, tokensUsed } = metadata;
  const detectedFramework = { language, framework, port: detectedPort, explanation };
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
