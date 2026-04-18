import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// In container: /app/src/services -> /app/templates
// Locally: backend/src/services -> backend/../templates (via ../../templates won't work)
// Use environment variable or fallback to container path
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || join(__dirname, '../../templates');

/**
 * Interpolate template variables using mustache-style syntax.
 * Supports:
 *   - Simple variables: {{variable}}
 *   - Conditional blocks: {{#variable}}content{{/variable}}
 *   - Each loops: {{#each items}}...{{name}}...{{/each}}
 *
 * @param {string} template - Template string with {{variable}} placeholders
 * @param {object} vars - Object containing variable values
 * @returns {string} Interpolated template string
 */
function interpolate(template, vars) {
  let result = template;

  // Handle {{#each items}}...{{/each}} loops
  result = result.replace(
    /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, arrayName, content) => {
      const items = vars[arrayName];
      if (!items || !Array.isArray(items) || items.length === 0) {
        return '';
      }
      return items.map(item => {
        let itemContent = content;
        for (const [key, value] of Object.entries(item)) {
          itemContent = itemContent.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            String(value)
          );
        }
        return itemContent;
      }).join('');
    }
  );

  // Handle {{#variable}}...{{/variable}} conditional blocks
  result = result.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, varName, content) => {
      const value = vars[varName];
      if (!value) {
        return '';
      }
      // Recursively interpolate the content inside the block
      return interpolate(content, vars);
    }
  );

  // Handle simple {{variable}} replacements
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing required variable: ${key}`);
    }
    return String(vars[key]);
  });

  return result;
}

/**
 * Load a template file from the templates directory
 * @param {string} filename - Template filename (e.g., 'deployment.yaml.tpl')
 * @returns {string} Template content
 */
function loadTemplate(filename) {
  const templatePath = join(TEMPLATES_DIR, filename);
  return readFileSync(templatePath, 'utf8');
}

/**
 * Generate a Kubernetes Namespace manifest
 * @param {string} name - Namespace name (project name, e.g., 'myproject')
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generateNamespaceManifest(name) {
  // Namespace is just the project name now (globally unique)
  const template = loadTemplate('namespace.yaml.tpl');
  const yaml = interpolate(template, {
    namespace: name,
    projectName: name
  });
  return parse(yaml);
}

/**
 * Generate a Kubernetes Deployment manifest
 * @param {object} options - Deployment configuration
 * @param {string} options.namespace - Kubernetes namespace
 * @param {string} options.serviceName - Name of the service
 * @param {string} options.image - Full container image path with tag
 * @param {number} options.port - Container port to expose
 * @param {number} [options.replicas=1] - Number of replicas (1-3)
 * @param {Array<{name: string, value: string}>} [options.envVars] - Environment variables
 * @param {string} [options.healthCheckPath] - HTTP path for health check probe
 * @param {string} [options.storageMountPath] - Mount path for PVC (default: /data)
 * @param {string} [options.storageClaimName] - PVC name if persistent storage is enabled
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generateDeploymentManifest(options) {
  const required = ['namespace', 'serviceName', 'image', 'port'];
  for (const field of required) {
    if (!(field in options)) {
      throw new Error(`Missing required option: ${field}`);
    }
  }

  // Set default replicas if not provided
  if (!options.replicas) {
    options.replicas = 1;
  }

  // Set default storageMountPath if storageClaimName is provided
  if (options.storageClaimName && !options.storageMountPath) {
    options.storageMountPath = '/data';
  }

  const template = loadTemplate('deployment.yaml.tpl');
  const yaml = interpolate(template, options);
  return parse(yaml);
}

/**
 * Generate a Kubernetes Service manifest
 * @param {object} options - Service configuration
 * @param {string} options.namespace - Kubernetes namespace
 * @param {string} options.serviceName - Service name
 * @param {number} options.port - Container/service port
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generateServiceManifest(options) {
  const required = ['namespace', 'serviceName', 'port'];
  for (const field of required) {
    if (!(field in options)) {
      throw new Error(`Missing required option: ${field}`);
    }
  }

  const template = loadTemplate('service.yaml.tpl');
  const yaml = interpolate(template, options);
  return parse(yaml);
}

/**
 * Generate a Kubernetes Ingress manifest
 * @param {object} options - Ingress configuration
 * @param {string} options.namespace - Kubernetes namespace
 * @param {string} options.serviceName - Service name
 * @param {number} options.port - Service port number
 * @param {string} options.subdomain - Subdomain prefix (e.g., 'a1b2c3-myservice')
 * @param {string} options.baseDomain - Base domain (e.g., '192.168.1.124.nip.io')
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generateIngressManifest(options) {
  const required = ['namespace', 'serviceName', 'port', 'subdomain', 'baseDomain'];
  for (const field of required) {
    if (!(field in options)) {
      throw new Error(`Missing required option: ${field}`);
    }
  }

  const template = loadTemplate('ingress.yaml.tpl');
  const yaml = interpolate(template, options);
  return parse(yaml);
}

/**
 * Generate a Kubernetes PersistentVolumeClaim manifest
 * @param {object} options - PVC configuration
 * @param {string} options.namespace - Kubernetes namespace
 * @param {string} options.serviceName - Service name for the PVC
 * @param {number} options.storageGb - Storage size in GB (1-10)
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generatePVCManifest(options) {
  const required = ['namespace', 'serviceName', 'storageGb'];
  for (const field of required) {
    if (!(field in options)) {
      throw new Error(`Missing required option: ${field}`);
    }
  }

  if (options.storageGb < 1 || options.storageGb > 10) {
    throw new Error('storageGb must be between 1 and 10');
  }

  const template = loadTemplate('pvc.yaml.tpl');
  const yaml = interpolate(template, options);
  return parse(yaml);
}

/**
 * Generate a Kubernetes Job manifest for Kaniko Docker image builds.
 *
 * Two modes:
 *   1. Repo Dockerfile: omit `dockerfileConfigMap`. `dockerfilePath` points to
 *      the Dockerfile in the cloned repo (e.g., './Dockerfile').
 *   2. Generated Dockerfile: pass `dockerfileConfigMap`. An init container
 *      writes files from the ConfigMap into /workspace. `dockerfilePath`
 *      should be '/workspace/Dockerfile' (or similar).
 *
 * @param {object} options - Kaniko job configuration
 * @param {string} options.namespace - Kubernetes namespace for the job
 * @param {string} options.jobName - Unique job name
 * @param {string} options.repoUrl - GitHub repository URL (e.g., github.com/owner/repo)
 * @param {string} options.branch - Git branch to build from
 * @param {string} options.commitSha - Specific commit SHA to build
 * @param {string} options.dockerfilePath - Path to Dockerfile (relative to /workspace, or absolute)
 * @param {string} options.imageDest - Full destination image path
 * @param {string} options.gitSecretName - Name of K8s secret containing git credentials
 * @param {string} options.registrySecretName - Name of K8s secret containing registry credentials
 * @param {string} [options.dockerfileConfigMap] - Name of ConfigMap with generated Dockerfile
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generateKanikoJobManifest(options) {
  const required = [
    'namespace',
    'jobName',
    'repoUrl',
    'branch',
    'commitSha',
    'dockerfilePath',
    'imageDest',
    'gitSecretName',
    'registrySecretName'
  ];
  for (const field of required) {
    if (!(field in options)) {
      throw new Error(`Missing required option: ${field}`);
    }
  }

  const template = loadTemplate('kaniko-job.yaml.tpl');
  const yaml = interpolate(template, {
    ...options,
    dockerfileConfigMap: options.dockerfileConfigMap || ''
  });
  return parse(yaml);
}

/**
 * Generate a Kubernetes Ingress manifest for custom domains with TLS
 * @param {object} options - Domain Ingress configuration
 * @param {string} options.namespace - Kubernetes namespace
 * @param {string} options.serviceName - Service name
 * @param {number} options.port - Service port number
 * @param {string} options.domain - Custom domain (e.g., api.example.com)
 * @param {string} options.ingressName - Unique ingress name for this domain
 * @param {string} options.secretName - TLS secret name for certificate storage
 * @returns {object} Parsed Kubernetes manifest object
 */
export function generateDomainIngressManifest(options) {
  const required = ['namespace', 'serviceName', 'port', 'domain', 'ingressName', 'secretName'];
  for (const field of required) {
    if (!(field in options)) {
      throw new Error(`Missing required option: ${field}`);
    }
  }

  const template = loadTemplate('domain-ingress.yaml.tpl');
  const yaml = interpolate(template, options);
  return parse(yaml);
}
