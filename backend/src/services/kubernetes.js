import fs from 'fs';
import https from 'https';
import logger from './logger.js';

const K8S_API_SERVER = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : 'https://kubernetes.default.svc';

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

function getServiceAccountToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (err) {
    // Running outside cluster - use environment token
    logger.debug('Service account token file not found, using KUBERNETES_TOKEN env var', {
      error: err.code
    });
    const envToken = process.env.KUBERNETES_TOKEN;
    if (!envToken) {
      logger.error('No Kubernetes authentication available - neither service account nor KUBERNETES_TOKEN');
    }
    return envToken || null;
  }
}

function getCA() {
  try {
    return fs.readFileSync(CA_PATH, 'utf8');
  } catch (err) {
    // Running outside cluster - CA not available
    logger.debug('Kubernetes CA file not found, TLS verification may be disabled', {
      error: err.code
    });
    return null;
  }
}

async function k8sRequest(method, path, body = null, contentType = 'application/json') {
  const token = getServiceAccountToken();
  if (!token) {
    throw new Error('Kubernetes authentication not configured');
  }

  const ca = getCA();
  const urlObj = new URL(`${K8S_API_SERVER}${path}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Accept': 'application/json',
      },
      // TLS options
      ca: ca || undefined,
      rejectUnauthorized: !!ca, // Only verify if we have CA cert
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          let errorMessage;
          try {
            const errorJson = JSON.parse(data);
            errorMessage = errorJson.message || data;
          } catch (parseErr) {
            logger.debug('Kubernetes API returned non-JSON error', {
              status: res.statusCode,
              contentType: res.headers['content-type']
            });
            errorMessage = data;
          }
          const error = new Error(`Kubernetes API error: ${errorMessage}`);
          error.status = res.statusCode;
          reject(error);
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Kubernetes request failed: ${err.message}`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

export async function createNamespace(name) {
  const namespace = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      labels: {
        'app.kubernetes.io/managed-by': 'dangus-cloud',
      },
    },
  };

  return k8sRequest('POST', '/api/v1/namespaces', namespace);
}

export async function deleteNamespace(name) {
  return k8sRequest('DELETE', `/api/v1/namespaces/${name}`);
}

export async function getNamespace(name) {
  return k8sRequest('GET', `/api/v1/namespaces/${name}`);
}

export async function namespaceExists(name) {
  try {
    await getNamespace(name);
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}

export async function deleteDeployment(namespace, name) {
  return k8sRequest('DELETE', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
}

export async function deleteService(namespace, name) {
  return k8sRequest('DELETE', `/api/v1/namespaces/${namespace}/services/${name}`);
}

export async function deleteIngress(namespace, name) {
  return k8sRequest('DELETE', `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses/${name}`);
}

export async function deletePVC(namespace, name) {
  return k8sRequest('DELETE', `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`);
}

export async function applyManifest(manifest) {
  const { apiVersion, kind, metadata } = manifest;
  const namespace = metadata.namespace;
  const name = metadata.name;

  let path;
  if (apiVersion === 'v1' && kind === 'Service') {
    path = `/api/v1/namespaces/${namespace}/services`;
  } else if (apiVersion === 'apps/v1' && kind === 'Deployment') {
    path = `/apis/apps/v1/namespaces/${namespace}/deployments`;
  } else if (apiVersion === 'networking.k8s.io/v1' && kind === 'Ingress') {
    path = `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`;
  } else if (apiVersion === 'v1' && kind === 'PersistentVolumeClaim') {
    path = `/api/v1/namespaces/${namespace}/persistentvolumeclaims`;
  } else if (apiVersion === 'batch/v1' && kind === 'Job') {
    path = `/apis/batch/v1/namespaces/${namespace}/jobs`;
  } else if (apiVersion === 'v1' && kind === 'Secret') {
    path = `/api/v1/namespaces/${namespace}/secrets`;
  } else if (apiVersion === 'v1' && kind === 'Pod') {
    path = `/api/v1/namespaces/${namespace}/pods`;
  } else {
    throw new Error(`Unsupported manifest kind: ${kind}`);
  }

  return k8sRequest('POST', path, manifest);
}

export async function createSecret(namespace, name, data, type = 'Opaque') {
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'dangus-cloud',
      },
    },
    type,
    data,
  };

  return k8sRequest('POST', `/api/v1/namespaces/${namespace}/secrets`, secret);
}

export async function deleteSecret(namespace, name) {
  return k8sRequest('DELETE', `/api/v1/namespaces/${namespace}/secrets/${name}`);
}

export async function getJob(namespace, name) {
  return k8sRequest('GET', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`);
}

export async function deleteJob(namespace, name, propagationPolicy = 'Background') {
  return k8sRequest('DELETE', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}?propagationPolicy=${propagationPolicy}`);
}

export async function getPodsByLabel(namespace, labelSelector) {
  return k8sRequest('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`);
}

export async function getDeployment(namespace, name) {
  return k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
}

export async function getService(namespace, name) {
  return k8sRequest('GET', `/api/v1/namespaces/${namespace}/services/${name}`);
}

/**
 * Patch a Kubernetes Service using strategic merge patch
 * @param {string} namespace - Namespace
 * @param {string} name - Service name
 * @param {object} patch - Patch object
 */
export async function patchService(namespace, name, patch) {
  return k8sRequest(
    'PATCH',
    `/api/v1/namespaces/${namespace}/services/${name}`,
    patch,
    'application/strategic-merge-patch+json'
  );
}

/**
 * Patch a Kubernetes Deployment using strategic merge patch
 * @param {string} namespace - Namespace
 * @param {string} name - Deployment name
 * @param {object} patch - Patch object
 */
export async function patchDeployment(namespace, name, patch) {
  return k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
    patch,
    'application/strategic-merge-patch+json'
  );
}

/**
 * Patch a Kubernetes Ingress using strategic merge patch
 * @param {string} namespace - Namespace
 * @param {string} name - Ingress name
 * @param {object} patch - Patch object
 */
export async function patchIngress(namespace, name, patch) {
  return k8sRequest(
    'PATCH',
    `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses/${name}`,
    patch,
    'application/strategic-merge-patch+json'
  );
}

export async function getPodMetrics(namespace, labelSelector) {
  const metricsPath = `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`;
  const metrics = await k8sRequest('GET', metricsPath);

  // Filter by label selector (format: "app=servicename")
  const [labelKey, labelValue] = labelSelector.split('=');
  const pods = metrics.items.filter(pod =>
    pod.metadata.labels?.[labelKey] === labelValue
  );

  return pods.map(pod => ({
    name: pod.metadata.name,
    containers: pod.containers.map(container => ({
      name: container.name,
      cpu: container.usage.cpu,
      memory: container.usage.memory
    }))
  }));
}

export async function getPodLogs(namespace, podName, options = {}) {
  const { container = null, tailLines = 100, sinceSeconds = null } = options;
  let path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?timestamps=true`;
  if (container) path += `&container=${container}`;
  if (tailLines) path += `&tailLines=${tailLines}`;
  if (sinceSeconds) path += `&sinceSeconds=${sinceSeconds}`;
  const token = getServiceAccountToken();
  if (!token) {
    throw new Error('Kubernetes authentication not configured');
  }

  const ca = getCA();
  const urlObj = new URL(`${K8S_API_SERVER}${path}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      ca: ca || undefined,
      rejectUnauthorized: !!ca,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          const error = new Error(`Failed to get pod logs: ${data}`);
          error.status = res.statusCode;
          reject(error);
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to get pod logs: ${err.message}`));
    });

    req.end();
  });
}

/**
 * Stream pod logs in real-time using follow mode
 * Returns an EventEmitter-like object that emits 'data', 'error', and 'end' events
 */
export function streamPodLogs(namespace, podName, options = {}) {
  const { container = null, tailLines = 100 } = options;
  let path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?follow=true&timestamps=true`;
  if (container) path += `&container=${container}`;
  if (tailLines) path += `&tailLines=${tailLines}`;
  const token = getServiceAccountToken();

  if (!token) {
    const error = new Error('Kubernetes authentication not configured');
    return {
      on: (event, callback) => {
        if (event === 'error') callback(error);
      },
      destroy: () => {}
    };
  }

  const ca = getCA();
  const urlObj = new URL(`${K8S_API_SERVER}${path}`);

  const reqOptions = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname + urlObj.search,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    ca: ca || undefined,
    rejectUnauthorized: !!ca,
  };

  const req = https.request(reqOptions);

  const stream = {
    _handlers: { data: [], error: [], end: [] },
    _request: req,
    on(event, callback) {
      if (this._handlers[event]) {
        this._handlers[event].push(callback);
      }
      return this;
    },
    emit(event, ...args) {
      if (this._handlers[event]) {
        this._handlers[event].forEach(cb => cb(...args));
      }
    },
    destroy() {
      try {
        req.destroy();
      } catch (e) {
        // Ignore errors on destroy
      }
    }
  };

  req.on('response', (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      res.on('data', (chunk) => {
        stream.emit('data', chunk.toString());
      });
      res.on('end', () => {
        stream.emit('end');
      });
      res.on('error', (err) => {
        stream.emit('error', err);
      });
    } else {
      let errorData = '';
      res.on('data', chunk => errorData += chunk);
      res.on('end', () => {
        stream.emit('error', new Error(`Failed to stream logs: ${res.statusCode} - ${errorData}`));
      });
    }
  });

  req.on('error', (err) => {
    stream.emit('error', new Error(`Failed to stream pod logs: ${err.message}`));
  });

  req.end();

  return stream;
}

export async function rolloutRestart(namespace, deploymentName) {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
          }
        }
      }
    }
  };

  return k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`,
    patch,
    'application/strategic-merge-patch+json'
  );
}

export async function deleteServicePods(namespace, serviceName) {
  return k8sRequest(
    'DELETE',
    `/api/v1/namespaces/${namespace}/pods?labelSelector=app=${encodeURIComponent(serviceName)}`
  );
}

export async function getIngress(namespace, name) {
  return k8sRequest('GET', `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses/${name}`);
}

export async function getCertificate(namespace, name) {
  try {
    return await k8sRequest('GET', `/apis/cert-manager.io/v1/namespaces/${namespace}/certificates/${name}`);
  } catch (err) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function getSecret(namespace, name) {
  try {
    return await k8sRequest('GET', `/api/v1/namespaces/${namespace}/secrets/${name}`);
  } catch (err) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Get pod health information including readiness/liveness probe status
 * @param {string} namespace - Kubernetes namespace
 * @param {string} labelSelector - Label selector (e.g., "app=servicename")
 * @returns {Promise<Array>} Array of pod health objects
 */
export async function getPodHealth(namespace, labelSelector) {
  const podsResult = await getPodsByLabel(namespace, labelSelector);
  const pods = podsResult.items || [];

  return pods.map(pod => {
    const conditions = pod.status?.conditions || [];
    const containerStatuses = pod.status?.containerStatuses || [];

    // Get condition statuses
    const readyCondition = conditions.find(c => c.type === 'Ready');
    const containersReadyCondition = conditions.find(c => c.type === 'ContainersReady');

    // Get container info for restart count and state
    const mainContainer = containerStatuses[0] || {};
    const containerState = mainContainer.state || {};
    const lastState = mainContainer.lastState || {};

    // Detect crash loop or other waiting states
    let waitingReason = null;
    let terminatedReason = null;
    let terminatedExitCode = null;

    if (containerState.waiting) {
      waitingReason = containerState.waiting.reason;
    }
    if (containerState.terminated) {
      terminatedReason = containerState.terminated.reason;
      terminatedExitCode = containerState.terminated.exitCode;
    }
    if (lastState.terminated) {
      terminatedReason = terminatedReason || lastState.terminated.reason;
      terminatedExitCode = terminatedExitCode ?? lastState.terminated.exitCode;
    }

    return {
      name: pod.metadata.name,
      ready: readyCondition?.status === 'True',
      phase: pod.status?.phase,
      restartCount: mainContainer.restartCount || 0,
      waitingReason,
      terminatedReason,
      terminatedExitCode,
      liveness: {
        status: containersReadyCondition?.status === 'True' ? 'passing' : 'failing',
        lastCheck: containersReadyCondition?.lastTransitionTime || null,
        message: containersReadyCondition?.message || null
      },
      readiness: {
        status: readyCondition?.status === 'True' ? 'passing' : 'failing',
        lastCheck: readyCondition?.lastTransitionTime || null,
        message: readyCondition?.message || null
      }
    };
  });
}

/**
 * Get events for pods in a namespace with a specific label
 * @param {string} namespace - Kubernetes namespace
 * @param {string} labelSelector - Label selector (e.g., "app=servicename")
 * @param {number} limit - Maximum number of events to return (default 20)
 * @returns {Promise<Array>} Array of relevant events
 */
export async function getPodEvents(namespace, labelSelector, limit = 20) {
  // Get pods first to get their names
  const podsResult = await getPodsByLabel(namespace, labelSelector);
  const pods = podsResult.items || [];
  const podNames = pods.map(p => p.metadata.name);

  if (podNames.length === 0) {
    return [];
  }

  // Get events for the namespace
  const eventsResult = await k8sRequest('GET', `/api/v1/namespaces/${namespace}/events`);
  const events = eventsResult.items || [];

  // Filter events related to our pods - include all runtime-relevant event types
  return events
    .filter(event => {
      const involvedName = event.involvedObject?.name;
      const isRelevantPod = podNames.includes(involvedName);
      const relevantReasons = [
        'Unhealthy', 'ProbeError', 'BackOff', 'Started', 'Killing',
        'Pulled', 'Pulling', 'Created', 'Failed', 'FailedScheduling',
        'SuccessfulCreate', 'FailedCreate', 'CrashLoopBackOff', 'OOMKilled',
        'ContainerStatusUnknown', 'FailedMount', 'FailedAttachVolume'
      ];
      const isRelevantEvent = relevantReasons.includes(event.reason);
      return isRelevantPod && isRelevantEvent;
    })
    .map(event => ({
      type: event.type,
      reason: event.reason,
      message: event.message,
      count: event.count || 1,
      lastTimestamp: event.lastTimestamp || event.eventTime,
      podName: event.involvedObject?.name
    }))
    .sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp))
    .slice(0, limit);
}

/**
 * Get the full deployment spec/manifest
 * @param {string} namespace - Kubernetes namespace
 * @param {string} deploymentName - Deployment name
 * @returns {Promise<object>} Full deployment object including spec
 */
export async function getDeploymentSpec(namespace, deploymentName) {
  return getDeployment(namespace, deploymentName);
}

/**
 * Scale a deployment to specified replicas
 * @param {string} namespace - Kubernetes namespace
 * @param {string} name - Deployment name
 * @param {number} replicas - Number of replicas
 * @returns {Promise<object>} Updated deployment
 */
export async function scaleDeployment(namespace, name, replicas) {
  logger.info('Scaling deployment', { namespace, name, replicas });
  return patchDeployment(namespace, name, {
    spec: { replicas }
  });
}

/**
 * List all deployments in a namespace
 * @param {string} namespace - Kubernetes namespace
 * @returns {Promise<object>} List of deployments
 */
export async function listDeployments(namespace) {
  return k8sRequest(
    'GET',
    `/apis/apps/v1/namespaces/${namespace}/deployments`
  );
}

/**
 * Get current replica count for a deployment
 * @param {string} namespace - Kubernetes namespace
 * @param {string} name - Deployment name
 * @returns {Promise<number>} Current replica count
 */
export async function getDeploymentReplicas(namespace, name) {
  const deployment = await getDeployment(namespace, name);
  return deployment.spec?.replicas || 0;
}

/**
 * Create a ConfigMap in a namespace
 * Used for storing generated Dockerfiles that Kaniko can mount
 * @param {string} namespace - Kubernetes namespace
 * @param {string} name - ConfigMap name
 * @param {object} data - Key-value pairs of data (not base64 encoded)
 * @returns {Promise<object>} Created ConfigMap
 */
export async function createConfigMap(namespace, name, data) {
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'dangus-cloud',
      },
    },
    data,
  };

  return k8sRequest('POST', `/api/v1/namespaces/${namespace}/configmaps`, configMap);
}

/**
 * Update or create a ConfigMap (upsert)
 * @param {string} namespace - Kubernetes namespace
 * @param {string} name - ConfigMap name
 * @param {object} data - Key-value pairs of data
 * @returns {Promise<object>} Updated/created ConfigMap
 */
export async function upsertConfigMap(namespace, name, data) {
  try {
    // Try to get existing
    await k8sRequest('GET', `/api/v1/namespaces/${namespace}/configmaps/${name}`);
    // If exists, replace it
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'dangus-cloud',
        },
      },
      data,
    };
    return k8sRequest('PUT', `/api/v1/namespaces/${namespace}/configmaps/${name}`, configMap);
  } catch (error) {
    // If not found, create it
    if (error.message?.includes('404') || error.status === 404) {
      return createConfigMap(namespace, name, data);
    }
    throw error;
  }
}

/**
 * Delete a ConfigMap from a namespace
 * @param {string} namespace - Kubernetes namespace
 * @param {string} name - ConfigMap name
 * @returns {Promise<object>}
 */
export async function deleteConfigMap(namespace, name) {
  return k8sRequest('DELETE', `/api/v1/namespaces/${namespace}/configmaps/${name}`);
}

/**
 * Get a ConfigMap from a namespace
 * @param {string} namespace - Kubernetes namespace
 * @param {string} name - ConfigMap name
 * @returns {Promise<object>} ConfigMap object
 */
export async function getConfigMap(namespace, name) {
  return k8sRequest('GET', `/api/v1/namespaces/${namespace}/configmaps/${name}`);
}

/**
 * List all namespaces managed by Dangus Cloud
 * @returns {Promise<Array<{name: string, createdAt: string}>>} List of managed namespaces
 */
export async function listManagedNamespaces() {
  const result = await k8sRequest(
    'GET',
    '/api/v1/namespaces?labelSelector=app.kubernetes.io%2Fmanaged-by%3Ddangus-cloud'
  );

  return (result.items || []).map(ns => ({
    name: ns.metadata.name,
    createdAt: ns.metadata.creationTimestamp,
    labels: ns.metadata.labels || {}
  }));
}

/**
 * Check if a namespace exists and is managed by Dangus Cloud
 * @param {string} name - Namespace name
 * @returns {Promise<{exists: boolean, managedByUs: boolean, namespace: object|null}>}
 */
export async function checkNamespaceStatus(name) {
  try {
    const ns = await getNamespace(name);
    const managedByUs = ns.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'dangus-cloud';
    return { exists: true, managedByUs, namespace: ns };
  } catch (error) {
    if (error.status === 404) {
      return { exists: false, managedByUs: false, namespace: null };
    }
    throw error;
  }
}

/**
 * Create namespace idempotently - reclaim orphaned namespaces if they exist
 * @param {string} name - Namespace name
 * @param {function} checkDbProject - Async function that returns true if a DB project exists for this namespace
 * @returns {Promise<{created: boolean, reclaimed: boolean, namespace: object}>}
 */
/**
 * Get a Pod by name.
 */
export async function getPod(namespace, name) {
  return k8sRequest('GET', `/api/v1/namespaces/${namespace}/pods/${name}`);
}

/**
 * Delete a Pod. Best-effort; swallows 404s.
 */
export async function deletePod(namespace, name, { gracePeriodSeconds = 0 } = {}) {
  const qs = `?gracePeriodSeconds=${gracePeriodSeconds}`;
  return k8sRequest('DELETE', `/api/v1/namespaces/${namespace}/pods/${name}${qs}`);
}

/**
 * Apply a Pod manifest and poll until it reaches Ready (or timeout).
 * Returns the ready Pod object. Throws on timeout or terminal failure.
 */
export async function applyAndWaitPodReady(manifest, { timeoutMs = 90_000, pollIntervalMs = 1500 } = {}) {
  await applyManifest(manifest);
  const { namespace, name } = manifest.metadata;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let pod;
    try {
      pod = await getPod(namespace, name);
    } catch (err) {
      if (err.status === 404) {
        // Not yet indexed; wait and retry
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      }
      throw err;
    }
    const phase = pod.status?.phase;
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`Pod ${name} reached terminal phase ${phase} before Ready`);
    }
    const readyCond = (pod.status?.conditions || []).find(c => c.type === 'Ready');
    if (readyCond?.status === 'True') {
      return pod;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Pod ${name} did not become Ready within ${timeoutMs}ms`);
}

/**
 * Exec a command inside a running Pod.
 *
 * Wraps @kubernetes/client-node's Exec. Accumulates stdout/stderr into Buffers,
 * supports optional stdin, and enforces a timeout by calling WebSocket.close().
 *
 * @param {string} namespace
 * @param {string} podName
 * @param {string[]} command - Argv (e.g. ['sh', '-c', 'ls -la'])
 * @param {object} [opts]
 * @param {string} [opts.containerName]
 * @param {number} [opts.timeoutMs=120000]
 * @param {Buffer|string|null} [opts.stdin] - Optional stdin payload
 * @returns {Promise<{stdout: Buffer, stderr: Buffer, exitCode: number|null, timedOut: boolean}>}
 */
export async function execInPod(namespace, podName, command, opts = {}) {
  const {
    containerName,
    timeoutMs = 120_000,
    stdin = null,
  } = opts;

  // Lazy-load to avoid pulling the dep at module-init for non-exec paths.
  const k8sClient = await import('@kubernetes/client-node');
  const kc = new k8sClient.KubeConfig();
  try {
    kc.loadFromCluster();
    // If running out-of-cluster with a token env var, patch the context.
    if (!kc.getCurrentCluster() && process.env.KUBERNETES_TOKEN) {
      kc.loadFromOptions({
        clusters: [{ name: 'default', server: K8S_API_SERVER, skipTLSVerify: !getCA() }],
        users: [{ name: 'default', token: process.env.KUBERNETES_TOKEN }],
        contexts: [{ name: 'default', cluster: 'default', user: 'default' }],
        currentContext: 'default',
      });
    }
  } catch {
    kc.loadFromDefault();
  }

  const exec = new k8sClient.Exec(kc);
  const stdoutChunks = [];
  const stderrChunks = [];

  // Use PassThrough so Exec can pipe into them.
  const { PassThrough } = await import('node:stream');
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  stdoutStream.on('data', c => stdoutChunks.push(Buffer.from(c)));
  stderrStream.on('data', c => stderrChunks.push(Buffer.from(c)));

  let stdinStream = null;
  if (stdin !== null && stdin !== undefined) {
    const buf = Buffer.isBuffer(stdin) ? stdin : Buffer.from(String(stdin), 'utf8');
    stdinStream = new PassThrough();
    // Queue write + end; Exec reads it once the connection is open.
    stdinStream.end(buf);
  }

  let exitCode = null;
  let timedOut = false;
  let ws = null;

  const done = new Promise((resolve, reject) => {
    exec.exec(
      namespace,
      podName,
      containerName || '',
      command,
      stdoutStream,
      stderrStream,
      stdinStream,
      false, // tty
      (status) => {
        // status: V1Status — exitCode shows up in status.details.causes or message
        if (status?.status === 'Success') {
          exitCode = 0;
        } else if (status?.details?.causes) {
          const exitCause = status.details.causes.find(c => c.reason === 'ExitCode');
          if (exitCause) exitCode = parseInt(exitCause.message, 10);
        } else if (typeof status?.message === 'string') {
          const m = status.message.match(/exit code (\d+)/);
          if (m) exitCode = parseInt(m[1], 10);
        }
        if (exitCode === null) exitCode = status?.status === 'Success' ? 0 : 1;
      },
    ).then((conn) => {
      ws = conn;
      // Connection closed — resolve.
      if (ws && typeof ws.on === 'function') {
        ws.on('close', () => resolve());
        ws.on('error', (err) => reject(err));
      } else {
        // If exec.exec resolves without a handle, just wait a tick for streams.
        stdoutStream.on('end', () => resolve());
      }
    }).catch(reject);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    try { ws?.close?.(); } catch { /* ignore */ }
    try { stdoutStream.end(); } catch { /* ignore */ }
    try { stderrStream.end(); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    await done;
  } catch (err) {
    if (!timedOut) throw err;
  } finally {
    clearTimeout(timer);
  }

  return {
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    exitCode: timedOut ? null : exitCode,
    timedOut,
  };
}

export async function createNamespaceIdempotent(name, checkDbProject) {
  const status = await checkNamespaceStatus(name);

  if (!status.exists) {
    // Namespace doesn't exist - create it
    const namespace = await createNamespace(name);
    return { created: true, reclaimed: false, namespace };
  }

  if (!status.managedByUs) {
    // Namespace exists but not managed by us - can't touch it
    throw new Error(`Namespace "${name}" exists but is not managed by Dangus Cloud`);
  }

  // Namespace exists and is managed by us - check if a project owns it
  const hasDbProject = await checkDbProject(name);

  if (hasDbProject) {
    // Another project owns this namespace
    throw new Error(`Namespace "${name}" is already in use by another project`);
  }

  // Orphaned namespace - reclaim it by returning existing
  logger.info(`Reclaiming orphaned namespace: ${name}`);
  return { created: false, reclaimed: true, namespace: status.namespace };
}
