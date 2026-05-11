import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { generateSandboxPodManifest } from './manifestGenerator.js';
import {
  applyAndWaitPodReady,
  deletePod,
  execInPod,
} from './kubernetes.js';
import logger from './logger.js';

const STDOUT_CAP = 50 * 1024;
const STDERR_CAP = 50 * 1024;

// Default sandbox image. Override via SANDBOX_IMAGE env var — point this at a
// custom multi-runtime image (Harbor, GHCR, etc.) to skip runtime installs
// during agent sessions. The default has node+npm+git+apt out of the box;
// agents install other runtimes (python, go, ruby, etc.) on demand.
const DEFAULT_SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'node:20-bookworm';

/**
 * Create an ephemeral sandbox Pod for an agent session. Blocks until the pod
 * reports Ready or the timeout elapses.
 *
 * @param {object} args
 * @param {string} args.namespace
 * @param {string} args.sessionId
 * @param {string} [args.imageTag='node:20-bookworm-slim']
 * @returns {Promise<{podName: string, namespace: string}>}
 */
export async function createSandbox({
  namespace,
  sessionId,
  imageTag = DEFAULT_SANDBOX_IMAGE,
}) {
  if (!namespace) throw new Error('createSandbox: namespace required');
  if (!sessionId) throw new Error('createSandbox: sessionId required');

  const shortId = crypto.randomBytes(3).toString('hex');
  // Pod names must be DNS-1123 (lowercase, <=63 chars). Truncate session id.
  const safeSession = String(sessionId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
  const podName = `agent-sbx-${safeSession}-${shortId}`;

  const manifest = generateSandboxPodManifest({
    podName,
    namespace,
    imageTag,
    sessionId: safeSession || 'unknown',
  });

  logger.info({ podName, namespace, imageTag, sessionId }, 'Creating sandbox pod');
  await applyAndWaitPodReady(manifest, { timeoutMs: 90_000 });
  logger.info({ podName, namespace }, 'Sandbox pod ready');

  return { podName, namespace };
}

/**
 * Best-effort delete — never throws. 404s are treated as success (already gone).
 */
export async function destroySandbox({ namespace, podName }) {
  if (!namespace || !podName) return;
  try {
    await deletePod(namespace, podName, { gracePeriodSeconds: 0 });
    logger.info({ podName, namespace }, 'Sandbox pod deleted');
  } catch (err) {
    if (err?.status === 404) return;
    logger.warn({ podName, namespace, err: err.message }, 'Failed to delete sandbox pod');
  }
}

/**
 * Produce a tar stream of a local directory's contents (not the directory itself).
 * Uses the system `tar` binary — it's available in the backend container image.
 */
async function tarLocalDir(localDir) {
  // Verify tar exists and the directory is there; surface useful errors early.
  await fs.access(localDir);
  return new Promise((resolve, reject) => {
    // -C <dir> . => archive the contents (relative paths), without a leading dir prefix.
    const proc = spawn('tar', ['-cf', '-', '-C', localDir, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (c) => chunks.push(Buffer.from(c)));
    proc.stderr.on('data', (c) => errChunks.push(Buffer.from(c)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`tar exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
      }
    });
  });
}

/**
 * Sync all files from a local directory into the pod at remoteDir. Existing
 * files in the pod are overwritten, unchanged files are left alone; this is
 * effectively idempotent so we can call it before every command.
 *
 * Implementation: pipe a locally-produced tar stream into `tar -xf -` running
 * inside the pod as stdin.
 */
export async function syncDirToPod({
  namespace,
  podName,
  localDir,
  remoteDir = '/workspace',
}) {
  const tarBuf = await tarLocalDir(localDir);
  const cmd = ['sh', '-c', `mkdir -p ${remoteDir} && tar -xf - -C ${remoteDir}`];
  const { stderr, exitCode, timedOut } = await execInPod(namespace, podName, cmd, {
    timeoutMs: 60_000,
    stdin: tarBuf,
  });
  if (timedOut) {
    throw new Error(`syncDirToPod timed out after 60s for ${podName}`);
  }
  if (exitCode !== 0) {
    const errText = stderr.toString('utf8').slice(0, 2000);
    throw new Error(`syncDirToPod failed (exit=${exitCode}): ${errText}`);
  }
}

function capBuffer(buf, cap) {
  if (buf.length <= cap) return buf.toString('utf8');
  const truncBytes = buf.length - cap;
  return buf.slice(0, cap).toString('utf8') + `\n... [truncated ${truncBytes} bytes]`;
}

/**
 * Execute a shell command inside the sandbox Pod.
 *
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, durationMs: number}>}
 */
/**
 * Clone a GitHub repo directly inside the sandbox pod. Uses an embedded token
 * for auth; the token appears in process args inside the pod only and is
 * redacted from any stderr/stdout we log on the host.
 *
 * The repo is cloned into /workspace (which we first empty). Optionally checks
 * out a specific commit SHA after cloning.
 *
 * @param {object} args
 * @param {string} args.namespace
 * @param {string} args.podName
 * @param {string} args.repoUrl       - e.g. https://github.com/owner/repo
 * @param {string} args.branch        - branch name
 * @param {string} [args.commitSha]   - optional commit SHA to check out
 * @param {string} args.githubToken   - OAuth token (x-access-token flow)
 * @returns {Promise<{durationMs: number}>}
 */
export async function cloneRepoIntoSandbox({
  namespace,
  podName,
  repoUrl,
  branch,
  commitSha,
  githubToken,
}) {
  if (!namespace || !podName) throw new Error('cloneRepoIntoSandbox: namespace & podName required');
  if (!repoUrl || !branch) throw new Error('cloneRepoIntoSandbox: repoUrl & branch required');
  if (!githubToken) throw new Error('cloneRepoIntoSandbox: githubToken required');

  // Normalize repoUrl to https form and strip any embedded creds.
  const cleanUrl = repoUrl.replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/^https:\/\/[^@]+@/, 'https://');
  const authedUrl = cleanUrl.replace(
    /^https:\/\//,
    `https://x-access-token:${githubToken}@`,
  );

  // Depth 1 clone on the branch, then (optionally) fetch + checkout the specific
  // SHA. Shallow keeps the clone fast; SHA checkout requires fetching that
  // specific object if it's not in the shallow history.
  const script = [
    'set -e',
    'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null || true',
    `git clone --depth 50 --branch ${JSON.stringify(branch)} ${JSON.stringify(authedUrl)} /workspace`,
    commitSha
      ? `cd /workspace && git fetch --depth 50 origin ${JSON.stringify(commitSha)} 2>/dev/null || true && git checkout ${JSON.stringify(commitSha)}`
      : '',
    // Strip the embedded token from git config so subsequent run_command calls
    // can't exfiltrate it by running `git remote -v`.
    `cd /workspace && git remote set-url origin ${JSON.stringify(cleanUrl)}`,
  ].filter(Boolean).join('\n');

  const started = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await execInPod(
    namespace,
    podName,
    ['sh', '-c', script],
    { timeoutMs: 180_000 },
  );
  const durationMs = Date.now() - started;

  // Redact any accidental token leakage before logging.
  const redact = (buf) => buf.toString('utf8').split(githubToken).join('[redacted]');

  if (timedOut) {
    throw new Error(`cloneRepoIntoSandbox timed out after 180s for ${podName}`);
  }
  if (exitCode !== 0) {
    const out = redact(stdout).slice(0, 1000);
    const err = redact(stderr).slice(0, 2000);
    throw new Error(`git clone failed (exit=${exitCode}) stderr=${err} stdout=${out}`);
  }

  logger.info({ podName, namespace, repoUrl: cleanUrl, branch, commitSha, durationMs },
    'Repo cloned into sandbox');
  return { durationMs };
}

export async function execInSandbox({
  namespace,
  podName,
  command,
  cwd = '/workspace',
  timeoutSeconds = 120,
}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('execInSandbox: command must be a non-empty string');
  }
  // Resolve cwd as a subdir of /workspace unless it's already absolute inside /workspace.
  let resolvedCwd;
  if (cwd.startsWith('/workspace')) {
    resolvedCwd = cwd;
  } else {
    // Relative path from the repo root.
    const rel = cwd.replace(/^\.\/+/, '');
    resolvedCwd = path.posix.join('/workspace', rel);
  }

  const started = Date.now();
  // Run via sh so `command` can use pipes, &&, etc. `cd` in front handles cwd.
  const wrapped = `cd ${JSON.stringify(resolvedCwd)} && ${command}`;
  const { stdout, stderr, exitCode, timedOut } = await execInPod(
    namespace,
    podName,
    ['sh', '-c', wrapped],
    { timeoutMs: Math.max(5, timeoutSeconds) * 1000 },
  );
  const durationMs = Date.now() - started;

  return {
    stdout: capBuffer(stdout, STDOUT_CAP),
    stderr: capBuffer(stderr, STDERR_CAP),
    exitCode,
    timedOut,
    durationMs,
  };
}
