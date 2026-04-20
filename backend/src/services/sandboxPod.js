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
  imageTag = 'node:20-bookworm-slim',
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
