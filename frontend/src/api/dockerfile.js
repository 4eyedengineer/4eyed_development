import { apiFetch } from './utils.js';

/**
 * Check if Dockerfile generation is available
 * @returns {Promise<{available: boolean, model: string}>}
 */
export async function getGenerationStatus() {
  return apiFetch('/dockerfile/status');
}

/**
 * Kick off an async Dockerfile generation job. Returns { jobId, channel, status }.
 * Subscribe to the WS channel for live tool calls + final result, or poll
 * GET /dockerfile/jobs/:jobId as a fallback.
 */
export async function generateDockerfileAsync(repoUrl, branch, workdir) {
  const body = { repoUrl, branch };
  if (workdir) body.workdir = workdir;
  return apiFetch('/dockerfile/generate-async', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export async function getDockerfileJob(jobId) {
  return apiFetch(`/dockerfile/jobs/${jobId}`);
}

export async function cancelDockerfileJob(jobId) {
  return apiFetch(`/dockerfile/jobs/${jobId}/cancel`, { method: 'POST' });
}

/**
 * Get the generated Dockerfile for a service
 * @param {string} serviceId - Service UUID
 * @returns {Promise<{content: string, detectedFramework: object, createdAt: string, updatedAt: string}>}
 */
export async function getGeneratedDockerfile(serviceId) {
  return apiFetch(`/services/${serviceId}/generated-dockerfile`);
}
