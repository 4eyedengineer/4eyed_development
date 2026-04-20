import { syncDirToPod, execInSandbox } from '../sandboxPod.js';
import logger from '../logger.js';

const MAX_COMMAND_LENGTH = 2048;
const DEFAULT_TIMEOUT_SECONDS = 120;

const TOOL_DESCRIPTION = [
  'Execute a shell command inside an ephemeral sandbox Pod that mirrors the repo files.',
  'Use this for `npm ls`, `npm ci`, `npx tsc --noEmit`, `npm run build`, `cat`, `find`, `ls`, etc. — any quick diagnostic.',
  'USE AGGRESSIVELY before proposing a fix: running a command takes seconds, whereas a Kaniko rebuild takes 5–10 minutes.',
  'The sandbox has node/npm and standard POSIX tools; it does NOT have docker or kubectl. Working directory defaults to the repo root (/workspace).',
].join(' ');

/**
 * Build the `run_command` tool bound to a specific sandbox pod + local dir.
 *
 * @param {object} args
 * @param {string} args.namespace       - Pod namespace
 * @param {string} args.podName         - Pod name (from createSandbox)
 * @param {string} args.localSandboxDir - Local sandbox directory to sync from
 * @returns {object} Tool descriptor suitable for runAgent.tools
 */
export function createCommandTool({ namespace, podName, localSandboxDir }) {
  if (!namespace || !podName || !localSandboxDir) {
    throw new Error('createCommandTool: namespace, podName, localSandboxDir all required');
  }

  return {
    name: 'run_command',
    description: TOOL_DESCRIPTION,
    input_schema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run. Can include pipes, &&, etc. Max 2048 chars.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory relative to the repo root. Defaults to the repo root.',
        },
        timeout_seconds: {
          type: 'integer',
          minimum: 5,
          maximum: 600,
          description: 'Max runtime in seconds. Default 120.',
        },
      },
    },
    execute: async (input = {}) => {
      const { command, cwd, timeout_seconds } = input;

      if (typeof command !== 'string' || command.length === 0) {
        return { content: 'Error: `command` is required and must be a non-empty string', is_error: true };
      }
      if (command.length > MAX_COMMAND_LENGTH) {
        return {
          content: `Error: command too long (${command.length} chars, max ${MAX_COMMAND_LENGTH}). Put longer logic in a script file via write_file and run it instead.`,
          is_error: true,
        };
      }
      const timeoutSeconds = Number.isInteger(timeout_seconds)
        ? Math.max(5, Math.min(600, timeout_seconds))
        : DEFAULT_TIMEOUT_SECONDS;

      try {
        // Sync local sandbox → pod every call so the pod always reflects
        // the latest edits made via write_file / str_replace.
        await syncDirToPod({ namespace, podName, localDir: localSandboxDir });
      } catch (err) {
        logger.warn({ err: err.message, podName }, 'run_command: sync failed');
        return {
          content: `Error: failed to sync workspace to sandbox pod: ${err.message}`,
          is_error: true,
        };
      }

      let result;
      try {
        result = await execInSandbox({
          namespace,
          podName,
          command,
          cwd: cwd || '/workspace',
          timeoutSeconds,
        });
      } catch (err) {
        logger.warn({ err: err.message, podName }, 'run_command: exec failed');
        return {
          content: `Error: sandbox exec failed: ${err.message}`,
          is_error: true,
        };
      }

      const header = result.timedOut
        ? `exit=timeout duration=${result.durationMs}ms (killed after ${timeoutSeconds}s)`
        : `exit=${result.exitCode} duration=${result.durationMs}ms`;

      const body =
        `${header}\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}`;

      // Non-zero exit is a COMMAND failure (useful signal), not a TOOL failure.
      return body;
    },
  };
}
