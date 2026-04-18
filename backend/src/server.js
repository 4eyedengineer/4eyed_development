import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import databasePlugin from './plugins/database.js';
import authPlugin from './plugins/auth.js';
import websocketHubPlugin from './plugins/websocket-hub.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import serviceRoutes from './routes/services.js';
import serviceDeploymentRoutes from './routes/serviceDeployments.js';
import serviceEnvRoutes from './routes/serviceEnv.js';
import serviceLogRoutes from './routes/serviceLogs.js';
import serviceMetricRoutes from './routes/serviceMetrics.js';
import serviceDockerfileRoutes from './routes/serviceDockerfile.js';
import deploymentRoutes from './routes/deployments.js';
import webhookRoutes from './routes/webhooks.js';
import githubRoutes from './routes/github.js';
import domainRoutes from './routes/domains.js';
import notificationRoutes from './routes/notifications.js';
import dockerfileRoutes from './routes/dockerfile.js';
import debugRoutes from './routes/debug.js';
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';
import { startMetricsCollection, stopMetricsCollection } from './services/metricsCollector.js';
import { runStartupHealthCheck } from './services/reconciliation.js';

const fastify = Fastify({
  logger: true,
});

// Environment variable validation
const requiredEnvVars = [
  'DATABASE_URL',
];

const optionalEnvVars = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'ENCRYPTION_KEY',
  'HARBOR_URL',
  'HARBOR_PROJECT',
  'BASE_DOMAIN',
  'WEBHOOK_BASE_URL',
];

const authEnvVars = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
];

function validateEnv() {
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    fastify.log.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const configured = optionalEnvVars.filter(v => process.env[v]);
  const unconfigured = optionalEnvVars.filter(v => !process.env[v]);

  // Check if auth is partially configured
  const authConfigured = authEnvVars.filter(v => process.env[v]);
  const authMissing = authEnvVars.filter(v => !process.env[v]);
  if (authConfigured.length > 0 && authMissing.length > 0) {
    fastify.log.warn(`Auth partially configured. Missing: ${authMissing.join(', ')}`);
  }

  fastify.log.info(`Environment configured: ${requiredEnvVars.length} required, ${configured.length}/${optionalEnvVars.length} optional`);
  if (unconfigured.length > 0) {
    fastify.log.warn(`Optional env vars not set: ${unconfigured.join(', ')}`);
  }
}

// Register CORS for cross-origin requests (needed for local dev)
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
fastify.register(cors, {
  origin: FRONTEND_URL,
  credentials: true,
});

// Register WebSocket plugin for real-time log streaming
fastify.register(websocket);

// Register database plugin (includes migration runner)
fastify.register(databasePlugin);

// Register cookie plugin for session management
fastify.register(cookie, {
  secret: process.env.SESSION_SECRET,
  parseOptions: {},
});

// Register auth plugin (provides fastify.authenticate)
fastify.register(authPlugin);

// Register WebSocket hub plugin for real-time updates
fastify.register(websocketHubPlugin);

// Register auth routes
fastify.register(authRoutes);

// Register project routes
fastify.register(projectRoutes);

// Register service routes (core CRUD)
fastify.register(serviceRoutes);

// Register service sub-route plugins (deployments, env, logs, metrics, dockerfile)
fastify.register(serviceDeploymentRoutes);
fastify.register(serviceEnvRoutes);
fastify.register(serviceLogRoutes);
fastify.register(serviceMetricRoutes);
fastify.register(serviceDockerfileRoutes);

// Register deployment routes
fastify.register(deploymentRoutes);

// Register webhook routes (no auth required)
fastify.register(webhookRoutes);

// Register GitHub routes
fastify.register(githubRoutes);

// Register domain routes
fastify.register(domainRoutes);

// Register notification routes
fastify.register(notificationRoutes);

// Register Dockerfile generation routes
fastify.register(dockerfileRoutes);

// Register debug agent routes
fastify.register(debugRoutes);

// Register admin routes (health, reconciliation)
fastify.register(adminRoutes);

// Register health summary routes (dashboard)
fastify.register(healthRoutes);

// Routes that do not require authentication
const publicRoutes = [
  { method: 'GET', url: '/health' },
  { method: 'GET', url: '/admin/health' },  // System health - useful for monitoring
  { method: 'GET', url: '/admin/stats' },   // Basic stats - useful for monitoring
  { method: 'GET', url: '/auth/github' },
  { method: 'GET', url: '/auth/github/callback' },
  { method: 'GET', url: '/ws/stats' },
];

// Apply authentication to all routes except public ones and webhooks
fastify.addHook('onRequest', async (request, reply) => {
  // Skip auth for public routes
  const isPublicRoute = publicRoutes.some(
    (route) => route.method === request.method && request.url.startsWith(route.url.split('?')[0])
  );

  if (isPublicRoute) {
    return;
  }

  // Skip auth for webhook routes
  if (request.method === 'POST' && request.url.startsWith('/webhooks/')) {
    return;
  }

  // Apply authentication
  await fastify.authenticate(request, reply);
});

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok' };
});

// Start server
const start = async () => {
  try {
    validateEnv();
    const port = process.env.PORT || 3001;
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on ${host}:${port}`);

    // Start metrics collection loop
    startMetricsCollection();
    fastify.log.info('Metrics collection started');

    // Run startup health check (non-blocking, logs discrepancies)
    setImmediate(async () => {
      try {
        await runStartupHealthCheck(fastify.db);
      } catch (err) {
        fastify.log.error('Startup health check error', { error: err.message });
      }
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal}, shutting down gracefully...`);
  stopMetricsCollection();
  await fastify.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
