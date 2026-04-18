/**
 * Shared helpers and constants for service-related route plugins.
 *
 * NOTE: Ownership-verification helpers used to close over `fastify.db`
 * inside a single plugin. They now accept `db` as the first argument so
 * they can be shared across multiple route plugins.
 */

export const NAME_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 63;

export const ENV_VAR_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

export const MASKED_VALUE = '••••••••';
export const BASE_DOMAIN = process.env.BASE_DOMAIN || '192.168.1.124.nip.io';

export function validateServiceName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Name is required' };
  }

  const trimmedName = name.trim();

  if (trimmedName.length < NAME_MIN_LENGTH || trimmedName.length > NAME_MAX_LENGTH) {
    return { valid: false, error: `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters` };
  }

  if (!NAME_REGEX.test(trimmedName)) {
    return { valid: false, error: 'Name must be lowercase, start with a letter, and contain only alphanumeric characters and hyphens' };
  }

  if (trimmedName.includes('--')) {
    return { valid: false, error: 'Name cannot contain consecutive hyphens' };
  }

  return { valid: true, name: trimmedName };
}

export function validateEnvVarKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Key is required' };
  }

  const trimmedKey = key.trim();

  if (trimmedKey.length === 0 || trimmedKey.length > 255) {
    return { valid: false, error: 'Key must be between 1 and 255 characters' };
  }

  if (!ENV_VAR_KEY_REGEX.test(trimmedKey)) {
    return { valid: false, error: 'Key must be uppercase, start with a letter, and contain only alphanumeric characters and underscores' };
  }

  return { valid: true, key: trimmedKey };
}

export function computeSubdomain(projectName, serviceName) {
  // URL pattern: {projectName}-{serviceName}.{baseDomain}
  return `${projectName}-${serviceName}`;
}

export function computeServiceUrl(subdomain) {
  return `http://${subdomain}.${BASE_DOMAIN}`;
}

export function computeWebhookUrl(serviceId) {
  const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:3001/webhooks/github';
  return `${baseUrl}/${serviceId}`;
}

export function computeNamespace(projectName) {
  // Namespace is just the project name (globally unique)
  return projectName;
}

export function parseResourceQuantity(value) {
  if (!value || value === '0') return 0;

  // CPU: parse millicores (e.g., "45m", "100m", "1", "0.5")
  if (value.endsWith('m')) {
    return parseInt(value.slice(0, -1), 10);
  }
  // CPU without suffix means cores, convert to millicores
  if (/^[\d.]+$/.test(value)) {
    return Math.round(parseFloat(value) * 1000);
  }

  // Memory: parse bytes from various units
  if (value.endsWith('Ki')) {
    return parseInt(value.slice(0, -2), 10) * 1024;
  }
  if (value.endsWith('Mi')) {
    return parseInt(value.slice(0, -2), 10) * 1024 * 1024;
  }
  if (value.endsWith('Gi')) {
    return parseInt(value.slice(0, -2), 10) * 1024 * 1024 * 1024;
  }
  if (value.endsWith('K') || value.endsWith('k')) {
    return parseInt(value.slice(0, -1), 10) * 1000;
  }
  if (value.endsWith('M')) {
    return parseInt(value.slice(0, -1), 10) * 1000 * 1000;
  }
  if (value.endsWith('G')) {
    return parseInt(value.slice(0, -1), 10) * 1000 * 1000 * 1000;
  }

  // Plain number assumed to be bytes
  return parseInt(value, 10) || 0;
}

/**
 * Verify project ownership.
 * @param {object} db - fastify.db handle (has .query())
 * @param {string} projectId
 * @param {string} userId
 * @returns {Promise<{project?: object, error?: string, status?: number}>}
 */
export async function verifyProjectOwnership(db, projectId, userId) {
  const result = await db.query(
    'SELECT id, user_id, name FROM projects WHERE id = $1',
    [projectId]
  );

  if (result.rows.length === 0) {
    return { error: 'Project not found', status: 404 };
  }

  const project = result.rows[0];
  if (project.user_id !== userId) {
    return { error: 'Access denied', status: 403 };
  }

  return { project };
}

/**
 * Verify service ownership through project.
 * @param {object} db - fastify.db handle (has .query())
 * @param {string} serviceId
 * @param {string} userId
 * @returns {Promise<{service?: object, error?: string, status?: number}>}
 */
export async function verifyServiceOwnership(db, serviceId, userId) {
  const result = await db.query(
    `SELECT s.*, s.detected_port, p.user_id, p.name as project_name
     FROM services s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = $1`,
    [serviceId]
  );

  if (result.rows.length === 0) {
    return { error: 'Service not found', status: 404 };
  }

  const service = result.rows[0];
  if (service.user_id !== userId) {
    return { error: 'Access denied', status: 403 };
  }

  return { service };
}

// Shared JSON schemas reused across service route plugins
export const serviceParamsSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
};

export const projectParamsSchema = {
  params: {
    type: 'object',
    required: ['projectId'],
    properties: {
      projectId: { type: 'string', format: 'uuid' },
    },
  },
};
