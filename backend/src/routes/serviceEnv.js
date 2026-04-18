import { decrypt, encrypt } from '../services/encryption.js';
import {
  validateEnvVarKey,
  verifyServiceOwnership,
  MASKED_VALUE,
} from './_helpers.js';

export default async function serviceEnvRoutes(fastify, options) {
  const envVarParamsSchema = {
    params: {
      type: 'object',
      required: ['serviceId'],
      properties: {
        serviceId: { type: 'string', format: 'uuid' },
      },
    },
  };

  const envVarIdParamsSchema = {
    params: {
      type: 'object',
      required: ['serviceId', 'id'],
      properties: {
        serviceId: { type: 'string', format: 'uuid' },
        id: { type: 'string', format: 'uuid' },
      },
    },
  };

  const createEnvVarSchema = {
    body: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
    },
  };

  const updateEnvVarSchema = {
    body: {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string' },
      },
    },
  };

  /**
   * GET /services/:serviceId/env
   * List all environment variables for a service (masked values)
   */
  fastify.get('/services/:serviceId/env', { schema: envVarParamsSchema }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.serviceId;

    // Verify service ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    try {
      const result = await fastify.db.query(
        'SELECT id, key, created_at FROM env_vars WHERE service_id = $1 ORDER BY key ASC',
        [serviceId]
      );

      const envVars = result.rows.map(row => ({
        id: row.id,
        key: row.key,
        value: MASKED_VALUE,
        created_at: row.created_at,
      }));

      return { env_vars: envVars };
    } catch (err) {
      fastify.log.error(`Failed to list env vars: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to list environment variables',
      });
    }
  });

  /**
   * POST /services/:serviceId/env
   * Add a new environment variable
   */
  fastify.post('/services/:serviceId/env', {
    schema: { ...envVarParamsSchema, ...createEnvVarSchema },
  }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.serviceId;

    // Verify service ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    // Validate key
    const validation = validateEnvVarKey(request.body.key);
    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: validation.error,
      });
    }

    const key = validation.key;
    const { value } = request.body;

    try {
      // Check if key already exists for this service
      const existing = await fastify.db.query(
        'SELECT id FROM env_vars WHERE service_id = $1 AND key = $2',
        [serviceId, key]
      );

      if (existing.rows.length > 0) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'An environment variable with this key already exists for this service',
        });
      }

      // Encrypt value before storage
      const encryptedValue = encrypt(value);

      const result = await fastify.db.query(
        `INSERT INTO env_vars (service_id, key, value)
         VALUES ($1, $2, $3)
         RETURNING id, key, created_at`,
        [serviceId, key, encryptedValue]
      );

      const envVar = result.rows[0];

      fastify.log.info(`Created env var: ${key} for service ${serviceId}`);

      return reply.code(201).send({
        id: envVar.id,
        key: envVar.key,
        value: MASKED_VALUE,
        created_at: envVar.created_at,
      });
    } catch (err) {
      fastify.log.error(`Failed to create env var: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create environment variable',
      });
    }
  });

  /**
   * PATCH /services/:serviceId/env/:id
   * Update an environment variable value (not key)
   */
  fastify.patch('/services/:serviceId/env/:id', {
    schema: { ...envVarIdParamsSchema, ...updateEnvVarSchema },
  }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.serviceId;
    const envVarId = request.params.id;

    // Verify service ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    try {
      // Verify env var exists and belongs to this service
      const existing = await fastify.db.query(
        'SELECT id, key FROM env_vars WHERE id = $1 AND service_id = $2',
        [envVarId, serviceId]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Environment variable not found',
        });
      }

      // Encrypt new value
      const encryptedValue = encrypt(request.body.value);

      const result = await fastify.db.query(
        `UPDATE env_vars SET value = $1 WHERE id = $2
         RETURNING id, key, created_at`,
        [encryptedValue, envVarId]
      );

      const envVar = result.rows[0];

      fastify.log.info(`Updated env var: ${envVar.key} for service ${serviceId}`);

      return {
        id: envVar.id,
        key: envVar.key,
        value: MASKED_VALUE,
        created_at: envVar.created_at,
      };
    } catch (err) {
      fastify.log.error(`Failed to update env var: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update environment variable',
      });
    }
  });

  /**
   * DELETE /services/:serviceId/env/:id
   * Delete an environment variable
   */
  fastify.delete('/services/:serviceId/env/:id', { schema: envVarIdParamsSchema }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.serviceId;
    const envVarId = request.params.id;

    // Verify service ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    try {
      // Verify env var exists and belongs to this service
      const existing = await fastify.db.query(
        'SELECT id, key FROM env_vars WHERE id = $1 AND service_id = $2',
        [envVarId, serviceId]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Environment variable not found',
        });
      }

      await fastify.db.query('DELETE FROM env_vars WHERE id = $1', [envVarId]);

      fastify.log.info(`Deleted env var: ${existing.rows[0].key} from service ${serviceId}`);

      return { success: true, message: 'Environment variable deleted successfully' };
    } catch (err) {
      fastify.log.error(`Failed to delete env var: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete environment variable',
      });
    }
  });

  /**
   * GET /services/:serviceId/env/:id/value
   * Reveal the decrypted value of a single environment variable
   */
  fastify.get('/services/:serviceId/env/:id/value', { schema: envVarIdParamsSchema }, async (request, reply) => {
    const userId = request.user.id;
    const serviceId = request.params.serviceId;
    const envVarId = request.params.id;

    // Verify service ownership
    const ownershipCheck = await verifyServiceOwnership(fastify.db, serviceId, userId);
    if (ownershipCheck.error) {
      return reply.code(ownershipCheck.status).send({
        error: ownershipCheck.status === 404 ? 'Not Found' : 'Forbidden',
        message: ownershipCheck.error,
      });
    }

    try {
      const result = await fastify.db.query(
        'SELECT id, key, value, created_at FROM env_vars WHERE id = $1 AND service_id = $2',
        [envVarId, serviceId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Environment variable not found',
        });
      }

      const envVar = result.rows[0];
      const decryptedValue = decrypt(envVar.value);

      return {
        id: envVar.id,
        key: envVar.key,
        value: decryptedValue,
        created_at: envVar.created_at,
      };
    } catch (err) {
      fastify.log.error(`Failed to reveal env var value: ${err.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to reveal environment variable value',
      });
    }
  });
}
