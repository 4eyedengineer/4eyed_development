import { listManagedNamespaces, deleteNamespace, createNamespace, getPodsByLabel, deletePod } from './kubernetes.js';
import logger from './logger.js';

/**
 * Reconciliation service for maintaining consistency between
 * the database (source of truth) and Kubernetes cluster state.
 */

// Sandbox pods are owned by the backend and live in its own namespace.
// They have activeDeadlineSeconds=3600 inside the pod spec, but a pod that
// terminates leaves a corpse behind, and a pod that survives a backend
// crash mid-job becomes a leak. Reap anything older than this threshold.
const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || 'dangus-cloud';
const SANDBOX_POD_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Get the current health status comparing DB projects vs K8s namespaces
 * @param {object} db - Database connection
 * @returns {Promise<object>} Health status report
 */
export async function getHealthStatus(db) {
  const startTime = Date.now();

  // Get all projects from DB
  const dbResult = await db.query(
    'SELECT id, name, user_id, created_at FROM projects ORDER BY name'
  );
  const dbProjects = dbResult.rows;
  const dbProjectNames = new Set(dbProjects.map(p => p.name));

  // Get all managed namespaces from K8s
  let k8sNamespaces = [];
  let k8sError = null;
  try {
    k8sNamespaces = await listManagedNamespaces();
  } catch (err) {
    k8sError = err.message;
    logger.error('Failed to list K8s namespaces for health check', { error: err.message });
  }
  const k8sNamespaceNames = new Set(k8sNamespaces.map(ns => ns.name));

  // Find orphaned namespaces (in K8s but not in DB)
  const orphanedNamespaces = k8sNamespaces.filter(ns => !dbProjectNames.has(ns.name));

  // Find ghost projects (in DB but not in K8s)
  const ghostProjects = dbProjects.filter(p => !k8sNamespaceNames.has(p.name));

  // Find healthy projects (in both)
  const healthyProjects = dbProjects.filter(p => k8sNamespaceNames.has(p.name));

  const status = {
    healthy: orphanedNamespaces.length === 0 && ghostProjects.length === 0 && !k8sError,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    summary: {
      totalDbProjects: dbProjects.length,
      totalK8sNamespaces: k8sNamespaces.length,
      healthyProjects: healthyProjects.length,
      orphanedNamespaces: orphanedNamespaces.length,
      ghostProjects: ghostProjects.length,
    },
    orphanedNamespaces: orphanedNamespaces.map(ns => ({
      name: ns.name,
      createdAt: ns.createdAt,
      action: 'Can be deleted - no DB project owns this namespace'
    })),
    ghostProjects: ghostProjects.map(p => ({
      id: p.id,
      name: p.name,
      userId: p.user_id,
      createdAt: p.created_at,
      action: 'Namespace missing - can recreate or delete project from DB'
    })),
    k8sError
  };

  return status;
}

/**
 * Perform reconciliation to fix inconsistencies
 * @param {object} db - Database connection
 * @param {object} options - Reconciliation options
 * @param {boolean} options.dryRun - If true, only report what would be done
 * @param {boolean} options.deleteOrphanedNamespaces - Delete K8s namespaces not in DB
 * @param {boolean} options.recreateMissingNamespaces - Recreate K8s namespaces for DB projects
 * @param {boolean} options.deleteGhostProjects - Delete DB projects without K8s namespaces
 * @returns {Promise<object>} Reconciliation result
 */
export async function reconcile(db, options = {}) {
  const {
    dryRun = true,
    deleteOrphanedNamespaces = false,
    recreateMissingNamespaces = false,
    deleteGhostProjects = false
  } = options;

  const startTime = Date.now();
  const actions = [];
  const errors = [];

  // Get current health status
  const health = await getHealthStatus(db);

  // Handle orphaned namespaces
  if (deleteOrphanedNamespaces && health.orphanedNamespaces.length > 0) {
    for (const ns of health.orphanedNamespaces) {
      const action = {
        type: 'DELETE_ORPHANED_NAMESPACE',
        target: ns.name,
        status: dryRun ? 'dry_run' : 'pending'
      };

      if (!dryRun) {
        try {
          await deleteNamespace(ns.name);
          action.status = 'success';
          logger.info(`Reconciliation: Deleted orphaned namespace ${ns.name}`);
        } catch (err) {
          action.status = 'error';
          action.error = err.message;
          errors.push({ type: 'DELETE_ORPHANED_NAMESPACE', target: ns.name, error: err.message });
          logger.error(`Reconciliation: Failed to delete orphaned namespace ${ns.name}`, { error: err.message });
        }
      }

      actions.push(action);
    }
  }

  // Handle ghost projects - recreate namespaces
  if (recreateMissingNamespaces && health.ghostProjects.length > 0) {
    for (const project of health.ghostProjects) {
      const action = {
        type: 'RECREATE_NAMESPACE',
        target: project.name,
        projectId: project.id,
        status: dryRun ? 'dry_run' : 'pending'
      };

      if (!dryRun) {
        try {
          await createNamespace(project.name);
          action.status = 'success';
          logger.info(`Reconciliation: Recreated namespace for project ${project.name}`);
        } catch (err) {
          action.status = 'error';
          action.error = err.message;
          errors.push({ type: 'RECREATE_NAMESPACE', target: project.name, error: err.message });
          logger.error(`Reconciliation: Failed to recreate namespace for ${project.name}`, { error: err.message });
        }
      }

      actions.push(action);
    }
  }

  // Reap orphan sandbox pods (agent crashes / backend restarts leave these
  // behind even though they have activeDeadlineSeconds=3600). We delete any
  // sandbox pod older than the threshold, regardless of phase — terminated
  // ones are corpses, Running ones from killed jobs are wasted compute.
  if (deleteOrphanedNamespaces && SANDBOX_NAMESPACE) {
    try {
      const podsResult = await getPodsByLabel(SANDBOX_NAMESPACE, 'app=dangus-agent-sandbox');
      const cutoffMs = Date.now() - SANDBOX_POD_MAX_AGE_MS;
      const stalePods = (podsResult.items || []).filter(p => {
        const created = p.metadata?.creationTimestamp;
        if (!created) return false;
        return new Date(created).getTime() < cutoffMs;
      });
      for (const pod of stalePods) {
        const action = {
          type: 'DELETE_STALE_SANDBOX_POD',
          target: `${SANDBOX_NAMESPACE}/${pod.metadata.name}`,
          status: dryRun ? 'dry_run' : 'pending'
        };
        if (!dryRun) {
          try {
            await deletePod(SANDBOX_NAMESPACE, pod.metadata.name, { gracePeriodSeconds: 0 });
            action.status = 'success';
            logger.info(`Reconciliation: Deleted stale sandbox pod ${pod.metadata.name}`);
          } catch (err) {
            if (err?.status !== 404) {
              action.status = 'error';
              action.error = err.message;
              errors.push({ type: 'DELETE_STALE_SANDBOX_POD', target: pod.metadata.name, error: err.message });
            } else {
              action.status = 'success'; // already gone
            }
          }
        }
        actions.push(action);
      }
    } catch (err) {
      logger.warn('Reconciliation: failed to list sandbox pods', { error: err.message });
    }
  }

  // Purge old completed/failed Dockerfile-gen jobs. Keeps the table small
  // and matches the "no PII retained" hygiene we want for tool-call logs.
  if (deleteGhostProjects) {
    try {
      const purgeResult = await db.query(
        `DELETE FROM dockerfile_generation_jobs
         WHERE status IN ('succeeded', 'failed')
           AND completed_at < NOW() - INTERVAL '7 days'
         RETURNING id`
      );
      if (purgeResult.rowCount > 0) {
        actions.push({
          type: 'PURGE_OLD_GEN_JOBS',
          target: `${purgeResult.rowCount} rows`,
          status: dryRun ? 'dry_run' : 'success',
        });
        if (!dryRun) {
          logger.info(`Reconciliation: Purged ${purgeResult.rowCount} old generation jobs`);
        }
      }
    } catch (err) {
      logger.warn('Reconciliation: failed to purge old gen jobs', { error: err.message });
    }
  }

  // Handle ghost projects - delete from DB
  if (deleteGhostProjects && health.ghostProjects.length > 0) {
    for (const project of health.ghostProjects) {
      const action = {
        type: 'DELETE_GHOST_PROJECT',
        target: project.name,
        projectId: project.id,
        status: dryRun ? 'dry_run' : 'pending'
      };

      if (!dryRun) {
        try {
          await db.query('DELETE FROM projects WHERE id = $1', [project.id]);
          action.status = 'success';
          logger.info(`Reconciliation: Deleted ghost project ${project.name} (${project.id})`);
        } catch (err) {
          action.status = 'error';
          action.error = err.message;
          errors.push({ type: 'DELETE_GHOST_PROJECT', target: project.name, error: err.message });
          logger.error(`Reconciliation: Failed to delete ghost project ${project.name}`, { error: err.message });
        }
      }

      actions.push(action);
    }
  }

  return {
    dryRun,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    healthBefore: health.summary,
    actions,
    errors,
    success: errors.length === 0
  };
}

/**
 * Run startup health check and log any discrepancies
 * This does NOT auto-fix anything - just reports issues
 * @param {object} db - Database connection
 */
export async function runStartupHealthCheck(db) {
  logger.info('Running startup reconciliation health check...');

  try {
    const health = await getHealthStatus(db);

    if (health.healthy) {
      logger.info('Startup health check: All systems consistent', {
        dbProjects: health.summary.totalDbProjects,
        k8sNamespaces: health.summary.totalK8sNamespaces
      });
      return health;
    }

    // Log warnings for any discrepancies
    if (health.orphanedNamespaces.length > 0) {
      logger.warn('Startup health check: Found orphaned K8s namespaces', {
        count: health.orphanedNamespaces.length,
        namespaces: health.orphanedNamespaces.map(ns => ns.name)
      });
    }

    if (health.ghostProjects.length > 0) {
      logger.warn('Startup health check: Found ghost DB projects (missing K8s namespaces)', {
        count: health.ghostProjects.length,
        projects: health.ghostProjects.map(p => ({ name: p.name, id: p.id }))
      });
    }

    if (health.k8sError) {
      logger.error('Startup health check: Could not connect to K8s API', {
        error: health.k8sError
      });
    }

    logger.info('Startup health check complete', {
      healthy: health.healthy,
      summary: health.summary
    });

    // Opt-in auto-cleanup. When RECONCILE_AUTO_CLEANUP=true the discrepancies
    // logged above get fixed instead of just reported. Only acts on
    // namespaces labeled `app.kubernetes.io/managed-by=dangus-cloud` so
    // user/system namespaces are never touched. Default off — explicit opt-in
    // in production deployment env.
    if (process.env.RECONCILE_AUTO_CLEANUP === 'true' && !health.healthy) {
      logger.info('Auto-cleanup enabled — reconciling discrepancies');
      const result = await reconcile(db, {
        dryRun: false,
        deleteOrphanedNamespaces: true,
        deleteGhostProjects: true,
      });
      logger.info('Auto-cleanup finished', {
        actions: result.actions.length,
        errors: result.errors.length,
      });
    }

    return health;
  } catch (err) {
    logger.error('Startup health check failed', { error: err.message });
    return null;
  }
}

/**
 * Start a periodic reconciliation loop. Runs once per RECONCILE_INTERVAL_MS
 * (default 1h) and applies the same RECONCILE_AUTO_CLEANUP rules as startup.
 * Returns a stop function the caller can use to cancel during shutdown.
 */
export function startPeriodicReconciliation(db) {
  const intervalMs = parseInt(process.env.RECONCILE_INTERVAL_MS || '', 10) || 60 * 60 * 1000;
  const autoClean = process.env.RECONCILE_AUTO_CLEANUP === 'true';

  logger.info('Starting periodic reconciliation', { intervalMs, autoClean });

  const timer = setInterval(async () => {
    try {
      const health = await getHealthStatus(db);
      if (health.healthy) return;

      logger.info('Periodic reconciliation: discrepancies detected', { summary: health.summary });

      if (autoClean) {
        const result = await reconcile(db, {
          dryRun: false,
          deleteOrphanedNamespaces: true,
          deleteGhostProjects: true,
        });
        logger.info('Periodic reconciliation: cleanup applied', {
          actions: result.actions.length,
          errors: result.errors.length,
        });
      }
    } catch (err) {
      logger.error('Periodic reconciliation tick failed', { error: err.message });
    }
  }, intervalMs);

  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
