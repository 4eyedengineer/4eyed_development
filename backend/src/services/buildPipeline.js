import {
  applyManifest,
  createSecret,
  deleteSecret,
  getJob,
  deleteJob,
  getPodsByLabel,
  getPodLogs,
  upsertConfigMap,
  deleteConfigMap,
} from './kubernetes.js';
import logger from './logger.js';
import {
  generateKanikoJobManifest,
  generateDeploymentManifest,
  generateServiceManifest,
  generateIngressManifest,
  generatePVCManifest,
} from './manifestGenerator.js';
import { parseGitHubUrl, getDockerfileExposedPort } from './github.js';
import { getGeneratedFile } from './dockerfileGenerator.js';
import { updateDeploymentStatus } from './deploymentService.js';
import { decrypt } from './encryption.js';
import { sendDeploymentNotification } from './notifications.js';
import appEvents from './event-emitter.js';

const HARBOR_REGISTRY = process.env.HARBOR_REGISTRY || 'harbor.192.168.1.124.nip.io';
const BASE_DOMAIN = process.env.BASE_DOMAIN || '192.168.1.124.nip.io';
const REGISTRY_SECRET_NAME = process.env.REGISTRY_SECRET_NAME || 'harbor-registry-secret';
const BUILD_POLL_INTERVAL = 5000; // 5 seconds
const BUILD_TIMEOUT = 1800000; // 30 minutes

/**
 * Generate the image tag for a build
 * @param {string} namespace - Kubernetes namespace
 * @param {string} serviceName - Service name
 * @param {string} commitSha - Git commit SHA
 * @returns {string} Full image path with tag
 */
function generateImageTag(namespace, serviceName, commitSha) {
  return `${HARBOR_REGISTRY}/dangus/${namespace}/${serviceName}:${commitSha.substring(0, 7)}`;
}

/**
 * Generate a unique job name for a build
 * @param {string} serviceName - Service name
 * @param {string} commitSha - Git commit SHA
 * @returns {string} Job name
 */
function generateJobName(serviceName, commitSha) {
  return `build-${serviceName}-${commitSha.substring(0, 7)}`;
}

/**
 * Create a Kubernetes secret for git credentials
 * @param {string} namespace - Kubernetes namespace
 * @param {string} secretName - Secret name
 * @param {string} githubToken - GitHub personal access token
 * @returns {Promise<object>} Created secret
 */
async function createGitSecret(namespace, secretName, githubToken) {
  const data = {
    GIT_USERNAME: Buffer.from('x-access-token').toString('base64'),
    GIT_PASSWORD: Buffer.from(githubToken).toString('base64'),
  };

  return createSecret(namespace, secretName, data);
}

/**
 * Trigger a build for a service deployment
 * @param {object} db - Database connection
 * @param {object} service - Service object from database
 * @param {object} deployment - Deployment object from database
 * @param {string} commitSha - Git commit SHA to build
 * @param {string} githubToken - Decrypted GitHub token
 * @param {string} namespace - Kubernetes namespace
 * @param {string} userHash - User hash for subdomain
 * @returns {Promise<{jobName: string, imageTag: string}>}
 */
export async function triggerBuild(db, service, deployment, commitSha, githubToken, namespace, userHash) {
  // Update deployment status to building
  await updateDeploymentStatus(db, deployment.id, 'building');

  // Emit WebSocket event for real-time update
  appEvents.emitDeploymentStatus(deployment.id, {
    status: 'building',
    previousStatus: 'pending',
    commitSha,
    message: 'Starting build...'
  });

  const jobName = generateJobName(service.name, commitSha);
  const imageTag = generateImageTag(namespace, service.name, commitSha);
  const gitSecretName = `git-creds-${jobName}`;
  const dockerfileConfigMapName = `dockerfile-${jobName}`;

  // Check if this service has a generated Dockerfile
  const generatedDockerfile = await getGeneratedFile(db, service.id, 'dockerfile');
  const generatedDockerignore = await getGeneratedFile(db, service.id, 'dockerignore');
  const useGeneratedDockerfile = !!generatedDockerfile;

  try {
    // Create git credentials secret
    await createGitSecret(namespace, gitSecretName, githubToken);

    // Parse repo URL for Kaniko (needs format: github.com/owner/repo)
    const { owner, repo } = parseGitHubUrl(service.repo_url);
    const repoUrl = `github.com/${owner}/${repo}`;

    let dockerfilePath;
    let configMapName = null;

    if (useGeneratedDockerfile) {
      logger.info({
        serviceName: service.name,
        framework: generatedDockerfile.detectedFramework
      }, 'Using generated Dockerfile for build');

      const configMapData = { Dockerfile: generatedDockerfile.content };
      if (generatedDockerignore) {
        configMapData['.dockerignore'] = generatedDockerignore.content;
      }

      await upsertConfigMap(namespace, dockerfileConfigMapName, configMapData);

      dockerfilePath = '/workspace/Dockerfile';
      configMapName = dockerfileConfigMapName;
    } else {
      // Handle build_context for monorepo setups
      if (service.build_context) {
        const context = service.build_context.replace(/^\.\//, '').replace(/\/$/, '');
        dockerfilePath = `./${context}/${service.dockerfile_path}`;
      } else {
        dockerfilePath = `./${service.dockerfile_path}`;
      }
    }

    const jobManifest = generateKanikoJobManifest({
      namespace,
      jobName,
      repoUrl,
      branch: service.branch,
      commitSha,
      dockerfilePath,
      imageDest: imageTag,
      gitSecretName,
      registrySecretName: REGISTRY_SECRET_NAME,
      ...(configMapName && { dockerfileConfigMap: configMapName }),
    });

    await applyManifest(jobManifest);

    return {
      jobName,
      imageTag,
      gitSecretName,
      dockerfileConfigMapName: useGeneratedDockerfile ? dockerfileConfigMapName : null
    };
  } catch (error) {
    // Cleanup secrets and configmaps on failure
    try {
      await deleteSecret(namespace, gitSecretName);
      if (useGeneratedDockerfile) {
        await deleteConfigMap(namespace, dockerfileConfigMapName);
      }
    } catch (cleanupErr) {
      logger.warn('Failed to cleanup resources during build failure', {
        namespace,
        secretName: gitSecretName,
        configMapName: dockerfileConfigMapName,
        error: cleanupErr.message
      });
    }

    await updateDeploymentStatus(db, deployment.id, 'failed', {
      build_logs: `Build trigger failed: ${error.message}`,
    });

    throw error;
  }
}

/**
 * Watch a build job until completion or failure
 * @param {object} db - Database connection
 * @param {string} namespace - Kubernetes namespace
 * @param {string} jobName - Job name to watch
 * @param {string} deploymentId - Deployment ID to update
 * @param {string} gitSecretName - Git secret name for cleanup
 * @returns {Promise<{success: boolean, imageTag?: string, logs?: string}>}
 */
export async function watchBuildJob(db, namespace, jobName, deploymentId, gitSecretName) {
  const startTime = Date.now();

  while (Date.now() - startTime < BUILD_TIMEOUT) {
    try {
      const job = await getJob(namespace, jobName);
      const status = job.status || {};

      // Check for completion
      if (status.succeeded >= 1) {
        const logs = await captureBuildLogs(namespace, jobName);

        // Update deployment with image tag - safely extract from job spec
        const containerArgs = job.spec?.template?.spec?.containers?.[0]?.args || [];
        const destinationArg = containerArgs.find(arg => arg?.startsWith?.('--destination='));
        const imageTag = destinationArg?.replace('--destination=', '') || null;

        await updateDeploymentStatus(db, deploymentId, 'deploying', {
          build_logs: logs,
          image_tag: imageTag,
        });

        // Emit WebSocket event for real-time update
        appEvents.emitDeploymentStatus(deploymentId, {
          status: 'deploying',
          previousStatus: 'building',
          imageTag,
          message: 'Build completed, deploying...'
        });

        // Cleanup
        await cleanupBuildJob(namespace, jobName, gitSecretName);

        return { success: true, imageTag, logs };
      }

      // Check for failure
      if (status.failed >= job.spec.backoffLimit) {
        const logs = await captureBuildLogs(namespace, jobName);

        await updateDeploymentStatus(db, deploymentId, 'failed', {
          build_logs: logs,
        });

        // Emit WebSocket event for real-time update
        appEvents.emitDeploymentStatus(deploymentId, {
          status: 'failed',
          previousStatus: 'building',
          message: 'Build failed'
        });

        // Cleanup
        await cleanupBuildJob(namespace, jobName, gitSecretName);

        return { success: false, logs };
      }

      // Still running, wait and poll again
      await sleep(BUILD_POLL_INTERVAL);
    } catch (error) {
      // Job might not exist yet or other transient error
      if (error.status === 404) {
        await sleep(BUILD_POLL_INTERVAL);
        continue;
      }

      throw error;
    }
  }

  // Timeout reached
  const logs = await captureBuildLogs(namespace, jobName).catch(() => 'Build timed out');

  await updateDeploymentStatus(db, deploymentId, 'failed', {
    build_logs: `Build timed out after ${BUILD_TIMEOUT / 1000} seconds\n\n${logs}`,
  });

  // Emit WebSocket event for real-time update
  appEvents.emitDeploymentStatus(deploymentId, {
    status: 'failed',
    previousStatus: 'building',
    message: `Build timed out after ${BUILD_TIMEOUT / 1000} seconds`
  });

  await cleanupBuildJob(namespace, jobName, gitSecretName);

  return { success: false, logs: 'Build timed out' };
}

/**
 * Deploy a service after successful build
 * @param {object} db - Database connection
 * @param {object} service - Service object from database
 * @param {object} deployment - Deployment object from database
 * @param {string} imageTag - Docker image tag
 * @param {string} namespace - Kubernetes namespace
 * @param {string} projectName - Project name for subdomain
 * @param {Array<{name: string, value: string}>} envVars - Decrypted environment variables
 * @returns {Promise<void>}
 */
export async function deployService(db, service, deployment, imageTag, namespace, projectName, envVars = []) {
  try {
    // URL pattern: {projectName}-{serviceName}.{baseDomain}
    const subdomain = `${projectName}-${service.name}`;

    // Generate PVC manifest if storage is configured
    if (service.storage_gb) {
      const pvcManifest = generatePVCManifest({
        namespace,
        serviceName: service.name,
        storageGb: service.storage_gb,
      });

      try {
        await applyManifest(pvcManifest);
      } catch (error) {
        // PVC might already exist, ignore 409 Conflict
        if (error.status !== 409) {
          throw error;
        }
      }
    }

    // Generate and apply deployment manifest
    const deploymentManifest = generateDeploymentManifest({
      namespace,
      serviceName: service.name,
      image: imageTag,
      port: service.port,
      replicas: service.replicas || 1,
      envVars: envVars.length > 0 ? envVars : undefined,
      healthCheckPath: service.health_check_path || undefined,
      storageClaimName: service.storage_gb ? `${service.name}-pvc` : undefined,
    });

    try {
      await applyManifest(deploymentManifest);
    } catch (error) {
      // If deployment exists, we need to update it instead
      if (error.status === 409) {
        // For now, delete and recreate (could be improved with PATCH)
        const { deleteDeployment } = await import('./kubernetes.js');
        await deleteDeployment(namespace, service.name);
        await applyManifest(deploymentManifest);
      } else {
        throw error;
      }
    }

    // Generate and apply service manifest
    const serviceManifest = generateServiceManifest({
      namespace,
      serviceName: service.name,
      port: service.port,
    });

    try {
      await applyManifest(serviceManifest);
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }
    }

    // Generate and apply ingress manifest
    const ingressManifest = generateIngressManifest({
      namespace,
      serviceName: service.name,
      port: service.port,
      subdomain,
      baseDomain: BASE_DOMAIN,
    });

    try {
      await applyManifest(ingressManifest);
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }
    }

    // Update deployment status to live
    await updateDeploymentStatus(db, deployment.id, 'live');

    // Emit WebSocket event for real-time update
    appEvents.emitDeploymentStatus(deployment.id, {
      status: 'live',
      previousStatus: 'deploying',
      imageTag,
      message: 'Deployment successful'
    });
  } catch (error) {
    await updateDeploymentStatus(db, deployment.id, 'failed', {
      build_logs: (deployment.build_logs || '') + `\n\nDeploy failed: ${error.message}`,
    });

    // Emit WebSocket event for real-time update
    appEvents.emitDeploymentStatus(deployment.id, {
      status: 'failed',
      previousStatus: 'deploying',
      message: `Deploy failed: ${error.message}`
    });

    throw error;
  }
}

/**
 * Capture build logs from a Kaniko job
 * @param {string} namespace - Kubernetes namespace
 * @param {string} jobName - Job name
 * @returns {Promise<string>} Combined logs from all containers
 */
export async function captureBuildLogs(namespace, jobName) {
  const logs = [];

  try {
    // Find pods by job-name label
    const podsResponse = await getPodsByLabel(namespace, `job-name=${jobName}`);
    const pods = podsResponse.items || [];

    if (pods.length === 0) {
      return 'No pods found for build job';
    }

    // Get the most recent pod
    const pod = pods.sort((a, b) =>
      new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp)
    )[0];

    // Try to get logs from init container (git-clone)
    try {
      const gitLogs = await getPodLogs(namespace, pod.metadata.name, 'git-clone');
      logs.push('=== Git Clone Logs ===');
      logs.push(gitLogs);
    } catch (gitLogErr) {
      logger.debug('Could not retrieve git-clone logs', {
        namespace,
        pod: pod.metadata.name,
        error: gitLogErr.message
      });
      logs.push('=== Git Clone Logs ===');
      logs.push('(no logs available)');
    }

    // Get logs from main container (kaniko)
    try {
      const kanikoLogs = await getPodLogs(namespace, pod.metadata.name, 'kaniko');
      logs.push('\n=== Kaniko Build Logs ===');
      logs.push(kanikoLogs);
    } catch (kanikoLogErr) {
      logger.debug('Could not retrieve kaniko logs', {
        namespace,
        pod: pod.metadata.name,
        error: kanikoLogErr.message
      });
      logs.push('\n=== Kaniko Build Logs ===');
      logs.push('(no logs available)');
    }
  } catch (error) {
    logs.push(`Failed to capture logs: ${error.message}`);
  }

  return logs.join('\n');
}

/**
 * Cleanup completed Kaniko job and associated resources
 * @param {string} namespace - Kubernetes namespace
 * @param {string} jobName - Job name
 * @param {string} gitSecretName - Git secret name
 */
async function cleanupBuildJob(namespace, jobName, gitSecretName) {
  // Delete git credentials secret
  try {
    await deleteSecret(namespace, gitSecretName);
  } catch (secretErr) {
    // Log but don't fail - cleanup errors shouldn't break the pipeline
    if (secretErr.status !== 404) {
      logger.warn('Failed to cleanup git secret', {
        namespace,
        secretName: gitSecretName,
        error: secretErr.message
      });
    }
  }

  // Delete job (will cascade delete pods)
  try {
    await deleteJob(namespace, jobName);
  } catch (jobErr) {
    // Log but don't fail - cleanup errors shouldn't break the pipeline
    if (jobErr.status !== 404) {
      logger.warn('Failed to cleanup build job', {
        namespace,
        jobName,
        error: jobErr.message
      });
    }
  }
}

/**
 * Helper function for async sleep
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get decrypted environment variables for a service
 * @param {object} db - Database connection
 * @param {string} serviceId - Service ID
 * @returns {Promise<Array<{name: string, value: string}>>}
 */
export async function getDecryptedEnvVars(db, serviceId) {
  const result = await db.query(
    'SELECT key, value FROM env_vars WHERE service_id = $1',
    [serviceId]
  );

  return result.rows.map(row => ({
    name: row.key,
    value: decrypt(row.value),
  }));
}

/**
 * Detect exposed port from Dockerfile and check for mismatch
 * @param {object} db - Database connection
 * @param {object} service - Service object
 * @param {string} githubToken - Decrypted GitHub token
 * @returns {Promise<{detectedPort: number|null, hasMismatch: boolean}>}
 */
export async function detectDockerfilePort(db, service, githubToken) {
  if (!service.repo_url || !githubToken) {
    return { detectedPort: null, hasMismatch: false };
  }

  try {
    // Build the full Dockerfile path considering build_context
    let dockerfilePath = service.dockerfile_path || 'Dockerfile';
    if (service.build_context) {
      const context = service.build_context.replace(/^\.\//, '').replace(/\/$/, '');
      dockerfilePath = `${context}/${dockerfilePath}`;
    }

    const { port: detectedPort } = await getDockerfileExposedPort(
      githubToken,
      service.repo_url,
      dockerfilePath,
      service.branch
    );

    const hasMismatch = detectedPort !== null && detectedPort !== service.port;

    // Store detected port in service record for UI display
    if (detectedPort !== null) {
      await db.query(
        'UPDATE services SET detected_port = $1 WHERE id = $2',
        [detectedPort, service.id]
      );
    }

    return { detectedPort, hasMismatch };
  } catch (error) {
    logger.warn('Failed to detect Dockerfile port', {
      serviceId: service.id,
      error: error.message
    });
    return { detectedPort: null, hasMismatch: false };
  }
}

/**
 * Run the complete build and deploy pipeline for a service
 * Handles both repo-based builds and direct image deployments
 * @param {object} db - Database connection
 * @param {object} service - Service object with project_name populated
 * @param {object} deployment - Deployment object
 * @param {string} commitSha - Git commit SHA (null for image-only services)
 * @param {string} githubToken - Decrypted GitHub token (null for image-only services)
 * @param {string} namespace - Kubernetes namespace
 * @param {string} projectName - Project name for subdomain
 * @param {string} userHash - User hash for subdomain
 * @param {object} project - Project object (optional, for notifications)
 */
export async function runBuildPipeline(db, service, deployment, commitSha, githubToken, namespace, projectName, userHash, project = null) {
  // Get decrypted env vars (needed for both paths)
  const envVars = await getDecryptedEnvVars(db, service.id);

  // Helper to send notifications
  const notifyCompletion = async (finalDeployment) => {
    if (project) {
      try {
        await sendDeploymentNotification(db, finalDeployment, service, project);
      } catch (notifyErr) {
        logger.error('Failed to send deployment notification', { error: notifyErr.message });
      }
    }
  };

  // For image-only services (no repo_url), skip build and deploy directly
  if (service.image && !service.repo_url) {
    // Update deployment status - skip building phase
    await updateDeploymentStatus(db, deployment.id, 'deploying', {
      build_logs: `Using pre-built image: ${service.image}`,
      image_tag: service.image,
    });

    // Deploy directly with the specified image
    await deployService(db, service, deployment, service.image, namespace, projectName, envVars);

    // Get updated deployment for notification
    const finalDeployment = await getDeploymentById(db, deployment.id);
    await notifyCompletion(finalDeployment);

    return { success: true, imageTag: service.image };
  }

  // Detect port from Dockerfile before building
  const { detectedPort, hasMismatch } = await detectDockerfilePort(db, service, githubToken);

  // Log port detection results
  if (detectedPort !== null) {
    logger.info('Detected exposed port from Dockerfile', {
      serviceId: service.id,
      detectedPort,
      configuredPort: service.port,
      hasMismatch
    });

    if (hasMismatch) {
      logger.warn('Port mismatch detected', {
        serviceId: service.id,
        dockerfilePort: detectedPort,
        configuredPort: service.port
      });
    }
  }

  // For repo-based services, run the full build pipeline
  const { jobName, imageTag, gitSecretName } = await triggerBuild(
    db,
    service,
    deployment,
    commitSha,
    githubToken,
    namespace,
    userHash
  );

  // Watch the build job
  const buildResult = await watchBuildJob(db, namespace, jobName, deployment.id, gitSecretName);

  if (!buildResult.success) {
    // Get updated deployment for failure notification
    const finalDeployment = await getDeploymentById(db, deployment.id);
    await notifyCompletion(finalDeployment);
    return { success: false, error: 'Build failed' };
  }

  // Add port mismatch warning to build logs if detected
  if (hasMismatch) {
    const warningMsg = `\n\n=== PORT MISMATCH WARNING ===\nDockerfile exposes port ${detectedPort} but service is configured for port ${service.port}.\nThis may cause 502 errors. Use "Fix Port" to update the service configuration.`;
    await updateDeploymentStatus(db, deployment.id, 'deploying', {
      build_logs: (buildResult.logs || '') + warningMsg,
    });
  }

  // Deploy the service
  await deployService(db, service, deployment, buildResult.imageTag, namespace, projectName, envVars);

  // Get updated deployment for notification
  const finalDeployment = await getDeploymentById(db, deployment.id);
  await notifyCompletion(finalDeployment);

  return { success: true, imageTag: buildResult.imageTag, detectedPort, hasMismatch };
}

/**
 * Get deployment by ID
 * @param {object} db - Database connection
 * @param {string} deploymentId - Deployment UUID
 * @returns {Promise<object>} Deployment object
 */
async function getDeploymentById(db, deploymentId) {
  const result = await db.query(
    'SELECT * FROM deployments WHERE id = $1',
    [deploymentId]
  );
  return result.rows[0];
}
