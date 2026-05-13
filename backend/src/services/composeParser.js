import { parse } from 'yaml';
import logger from './logger.js';

/**
 * Sanitize service name for Kubernetes DNS compatibility
 * Must be lowercase, start with letter, alphanumeric and hyphens only, max 63 chars
 * @param {string} name - Original service name
 * @returns {string} - Sanitized name
 */
function sanitizeServiceName(name) {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')  // Replace invalid chars with hyphens
    .replace(/-+/g, '-')          // Collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');     // Trim leading/trailing hyphens

  // Ensure name starts with a letter (required for K8s DNS)
  if (sanitized && !/^[a-z]/.test(sanitized)) {
    sanitized = 'svc-' + sanitized;
  }

  // Ensure name ends with alphanumeric (required for K8s DNS)
  sanitized = sanitized.replace(/-+$/, '');

  // Handle empty result
  if (!sanitized) {
    sanitized = 'service';
  }

  return sanitized.substring(0, 63);
}

/**
 * Detect service type based on image/name patterns
 * @param {string} name - Service name
 * @param {object} config - Service configuration
 * @returns {string} - Service type
 */
function detectServiceType(name, config) {
  const image = config.image || '';
  const lowerName = name.toLowerCase();
  const lowerImage = image.toLowerCase();

  const patterns = {
    database: ['postgres', 'mysql', 'mariadb', 'mongo', 'sqlite', 'cockroach', 'timescale'],
    cache: ['redis', 'memcached', 'varnish', 'dragonfly'],
    queue: ['rabbitmq', 'kafka', 'nats', 'activemq', 'pulsar'],
    proxy: ['nginx', 'traefik', 'haproxy', 'caddy', 'envoy'],
    search: ['elasticsearch', 'opensearch', 'solr', 'meilisearch', 'typesense']
  };

  for (const [type, keywords] of Object.entries(patterns)) {
    if (keywords.some(kw => lowerName.includes(kw) || lowerImage.includes(kw))) {
      return type;
    }
  }

  return 'container';
}

/**
 * Extract first exposed port from ports configuration
 * @param {object} config - Service configuration
 * @returns {number} - Port number
 */
function extractPort(config) {
  if (!config.ports || config.ports.length === 0) {
    // Default ports for known services
    const image = (config.image || '').toLowerCase();
    if (image.includes('postgres')) return 5432;
    if (image.includes('mysql') || image.includes('mariadb')) return 3306;
    if (image.includes('redis')) return 6379;
    if (image.includes('mongo')) return 27017;
    if (image.includes('nginx')) return 80;
    if (image.includes('rabbitmq')) return 5672;
    if (image.includes('kafka')) return 9092;
    if (image.includes('elasticsearch') || image.includes('opensearch')) return 9200;
    if (image.includes('meilisearch')) return 7700;
    return 8080; // Default fallback
  }

  const portSpec = config.ports[0];
  if (typeof portSpec === 'number') return portSpec;
  if (typeof portSpec === 'string') {
    // Handle various formats: "8080:80", "80", "8080:80/tcp", "127.0.0.1:8080:80"
    const parts = portSpec.replace(/\/\w+$/, '').split(':');
    // The container port is always the last part
    return parseInt(parts[parts.length - 1], 10) || 8080;
  }
  if (portSpec && typeof portSpec === 'object' && portSpec.target) {
    return portSpec.target;
  }

  return 8080;
}

/**
 * Extract environment variables from service config
 * @param {object} config - Service configuration
 * @returns {Array<{key: string, value: string}>}
 */
function extractEnvVars(config) {
  const envVars = [];

  if (Array.isArray(config.environment)) {
    for (const env of config.environment) {
      const [key, ...valueParts] = env.split('=');
      envVars.push({ key, value: valueParts.join('=') || '' });
    }
  } else if (config.environment && typeof config.environment === 'object') {
    for (const [key, value] of Object.entries(config.environment)) {
      envVars.push({ key, value: String(value ?? '') });
    }
  }

  return envVars;
}

/**
 * Check if service has volumes (suggests persistent storage needed)
 * @param {object} config - Service configuration
 * @returns {boolean}
 */
function hasVolumes(config) {
  if (!config.volumes || config.volumes.length === 0) return false;

  // Check for named volumes or bind mounts that suggest persistence
  return config.volumes.some(v => {
    if (typeof v === 'string') {
      // Named volumes like "pgdata:/var/lib/postgresql/data"
      // or paths like "/data:/var/lib/data"
      return v.includes(':');
    }
    if (v && typeof v === 'object') {
      return v.type === 'volume' || v.source;
    }
    return false;
  });
}

/**
 * Extract health check path if defined
 * @param {object} config - Service configuration
 * @returns {string|null}
 */
function extractHealthCheck(config) {
  if (config.healthcheck?.test) {
    const test = Array.isArray(config.healthcheck.test)
      ? config.healthcheck.test.join(' ')
      : config.healthcheck.test;

    // Try to extract path from curl/wget commands
    const pathMatch = test.match(/(?:curl|wget)[^/]*(?:localhost|127\.0\.0\.1)[:\d]*(\/?[^\s"']+)/i);
    if (pathMatch) {
      return pathMatch[1];
    }

    // Try simple path pattern
    const simpleMatch = test.match(/(?:GET|HEAD)\s+(\/?[^\s"']+)/i);
    if (simpleMatch) {
      return simpleMatch[1];
    }
  }
  return null;
}

/**
 * Parse docker-compose.yml content and extract services
 * @param {string} composeContent - Raw YAML content
 * @returns {Array<object>} - Extracted services
 */
export function parseDockerCompose(composeContent) {
  const compose = parse(composeContent);

  if (!compose || !compose.services) {
    throw new Error('Invalid docker-compose.yml: no services found');
  }

  const extractedServices = [];

  for (const [serviceName, config] of Object.entries(compose.services)) {
    const service = {
      name: sanitizeServiceName(serviceName),
      originalName: serviceName,
      type: detectServiceType(serviceName, config),
      // Source - either direct image or build from Dockerfile
      image: config.image || null,
      build: null,
      // Port detection
      port: extractPort(config),
      // Environment variables
      envVars: extractEnvVars(config),
      // Volumes for storage detection
      hasStorage: hasVolumes(config),
      // Dependencies for ordering
      dependsOn: config.depends_on || [],
      // Health check if defined
      healthCheckPath: extractHealthCheck(config)
    };

    // Handle build configuration
    if (config.build) {
      if (typeof config.build === 'string') {
        // String format: build: ./path
        service.build = { context: config.build, dockerfile: 'Dockerfile' };
        logger.debug(`Service "${serviceName}": build is string, using default dockerfile`, {
          context: config.build
        });
      } else {
        // Object format: build: { context: ..., dockerfile: ... }
        const context = config.build.context;
        const dockerfile = config.build.dockerfile;

        if (!context) {
          logger.warn(`Service "${serviceName}": build.context not specified, using "."`, {
            originalName: serviceName
          });
        }
        if (!dockerfile) {
          logger.debug(`Service "${serviceName}": build.dockerfile not specified, using "Dockerfile"`, {
            context: context || '.'
          });
        }

        service.build = {
          context: context || '.',
          dockerfile: dockerfile || 'Dockerfile'
        };
      }
    }

    extractedServices.push(service);
  }

  return extractedServices;
}

/**
 * Find Dockerfiles in common locations from repo tree
 * @param {Array<{path: string}>} tree - Repository file tree
 * @returns {Array<{path: string, context: string, serviceName: string}>}
 */
export function findDockerfiles(tree) {
  const dockerfiles = [];
  const dockerfilePattern = /^(.*\/)?Dockerfile(\..*)?$/i;

  for (const item of tree) {
    if (dockerfilePattern.test(item.path)) {
      const parts = item.path.split('/');
      const filename = parts[parts.length - 1];

      // Determine service name from directory or filename suffix
      let serviceName;
      if (parts.length > 1) {
        // Use parent directory name (e.g., "backend" from "backend/Dockerfile")
        serviceName = sanitizeServiceName(parts[parts.length - 2]);
      } else if (filename.includes('.')) {
        // Use suffix (e.g., "worker" from "Dockerfile.worker")
        const suffix = filename.split('.').pop();
        serviceName = sanitizeServiceName(suffix);
      } else {
        serviceName = 'app';
      }

      dockerfiles.push({
        path: item.path,
        context: parts.length > 1 ? parts.slice(0, -1).join('/') : '.',
        serviceName
      });
    }
  }

  return dockerfiles;
}

/**
 * Detect monorepo layout from the repo tree + optional root package.json.
 *
 * Returns { isMonorepo, type, workspaces } where workspaces is a list of
 * deployable subdirs the user should pick from. Returns isMonorepo=false
 * when there's exactly 0 or 1 sub-package.json (no ambiguity).
 *
 * @param {Array<{path: string}>} tree - Repo file tree
 * @param {string|null} rootPackageJsonContent - Root package.json contents if available
 * @returns {{isMonorepo: boolean, type: string|null, workspaces: Array<{path: string, name: string, hasPackageJson: boolean}>}}
 */
export function detectMonorepo(tree, rootPackageJsonContent) {
  const paths = new Set(tree.map(f => f.path));

  // Strong monorepo signals at the repo root.
  const hasNx = paths.has('nx.json');
  const hasTurbo = paths.has('turbo.json');
  const hasPnpmWorkspace = paths.has('pnpm-workspace.yaml');
  const hasLerna = paths.has('lerna.json');

  let workspacesField = null;
  if (rootPackageJsonContent) {
    try {
      const pkg = JSON.parse(rootPackageJsonContent);
      if (Array.isArray(pkg.workspaces)) workspacesField = pkg.workspaces;
      else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) workspacesField = pkg.workspaces.packages;
    } catch { /* ignore */ }
  }

  // Find all sub-package.json files (not at root, not in node_modules).
  const subPackageJsons = tree
    .map(f => f.path)
    .filter(p => p.endsWith('/package.json') && !p.includes('/node_modules/'));

  // If no strong signals AND only 0–1 sub-packages, it's not a monorepo.
  const hasStrongSignal = hasNx || hasTurbo || hasPnpmWorkspace || hasLerna || (workspacesField && workspacesField.length > 0);
  if (!hasStrongSignal && subPackageJsons.length <= 1) {
    return { isMonorepo: false, type: null, workspaces: [] };
  }

  // Build the candidate workspace list — one entry per sub-package.json dir.
  // Prefer common monorepo conventions (apps/*, packages/*, services/*) at
  // the front of the list when ranking.
  const workspaces = subPackageJsons.map(p => {
    const dir = p.replace(/\/package\.json$/, '');
    const segments = dir.split('/');
    const name = segments[segments.length - 1];
    return { path: dir, name, hasPackageJson: true };
  });

  // Stable sort: known top-level conventions first, then alpha.
  const TOP_DIRS = ['apps', 'packages', 'services', 'workspaces', 'libs'];
  workspaces.sort((a, b) => {
    const aTop = TOP_DIRS.indexOf(a.path.split('/')[0]);
    const bTop = TOP_DIRS.indexOf(b.path.split('/')[0]);
    if (aTop !== bTop) {
      if (aTop === -1) return 1;
      if (bTop === -1) return -1;
      return aTop - bTop;
    }
    return a.path.localeCompare(b.path);
  });

  let type = 'workspaces';
  if (hasNx) type = 'nx';
  else if (hasTurbo) type = 'turborepo';
  else if (hasPnpmWorkspace) type = 'pnpm';
  else if (hasLerna) type = 'lerna';

  return { isMonorepo: true, type, workspaces };
}

/**
 * Infer default storage size based on service type
 * @param {string} type - Service type
 * @returns {number|null} - Suggested storage in GB or null
 */
export function inferStorageSize(type) {
  switch (type) {
    case 'database':
      return 5; // 5GB for databases
    case 'cache':
      return null; // Caches typically don't need persistent storage
    case 'search':
      return 5; // Search engines need storage for indices
    default:
      return null;
  }
}
