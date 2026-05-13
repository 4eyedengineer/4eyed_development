import { decrypt } from '../services/encryption.js';
import {
  listUserRepos,
  getFileContent,
  getRepoTree,
  getRepoInfo,
  listBranches
} from '../services/github.js';
import { parseDockerCompose, findDockerfiles, detectMonorepo } from '../services/composeParser.js';

/**
 * Helper to get decrypted GitHub token for the current user
 */
async function getGitHubToken(fastify, userId) {
  const result = await fastify.db.query(
    'SELECT github_access_token FROM users WHERE id = $1',
    [userId]
  );

  if (!result.rows[0]?.github_access_token) {
    return null;
  }

  return decrypt(result.rows[0].github_access_token);
}

export default async function githubRoutes(fastify, options) {
  /**
   * GET /github/repos
   * List repositories accessible to the authenticated user
   */
  fastify.get('/github/repos', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          perPage: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          search: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const { page, perPage, search } = request.query;

    try {
      const githubToken = await getGitHubToken(fastify, userId);
      if (!githubToken) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'GitHub token not configured'
        });
      }

      const result = await listUserRepos(githubToken, { page, perPage });

      // Filter by search if provided
      if (search) {
        const searchLower = search.toLowerCase();
        result.repos = result.repos.filter(repo =>
          repo.fullName.toLowerCase().includes(searchLower) ||
          (repo.description || '').toLowerCase().includes(searchLower)
        );
      }

      return result;
    } catch (error) {
      fastify.log.error(`Failed to list repos: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to list repositories'
      });
    }
  });

  /**
   * GET /github/branches
   * List branches for a repository
   */
  fastify.get('/github/branches', {
    schema: {
      querystring: {
        type: 'object',
        required: ['repo_url'],
        properties: {
          repo_url: { type: 'string' },
          search: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const { repo_url, search } = request.query;

    try {
      const githubToken = await getGitHubToken(fastify, userId);
      if (!githubToken) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'GitHub token not configured'
        });
      }

      const branches = await listBranches(githubToken, repo_url, search || '');
      return { branches };
    } catch (error) {
      fastify.log.error(`Failed to list branches: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to list branches'
      });
    }
  });

  /**
   * POST /github/analyze
   * Analyze a repository for docker-compose and Dockerfiles
   */
  fastify.post('/github/analyze', {
    schema: {
      body: {
        type: 'object',
        required: ['repoUrl'],
        properties: {
          repoUrl: { type: 'string' },
          branch: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const userId = request.user.id;
    const { repoUrl, branch } = request.body;

    try {
      const githubToken = await getGitHubToken(fastify, userId);
      if (!githubToken) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'GitHub token not configured'
        });
      }

      // Get repo info for default branch
      const repoInfo = await getRepoInfo(githubToken, repoUrl);
      const targetBranch = branch || repoInfo.defaultBranch;

      const result = {
        repo: repoInfo,
        branch: targetBranch,
        composeServices: [],
        standaloneDockerfiles: [],
        hasDockerCompose: false,
        composeFile: null,
        composeParseError: null
      };

      // Try to find and parse docker-compose files
      const composeFiles = [
        'docker-compose.yml',
        'docker-compose.yaml',
        'compose.yml',
        'compose.yaml'
      ];

      for (const fileName of composeFiles) {
        const composeFile = await getFileContent(
          githubToken, repoUrl, fileName, targetBranch
        );

        if (composeFile) {
          result.hasDockerCompose = true;
          result.composeFile = fileName;

          try {
            result.composeServices = parseDockerCompose(composeFile.content);
          } catch (parseError) {
            result.composeParseError = parseError.message;
          }
          break;
        }
      }

      // Get repo tree to find standalone Dockerfiles
      const tree = await getRepoTree(githubToken, repoUrl, targetBranch);
      result.standaloneDockerfiles = findDockerfiles(tree);

      // Detect monorepo layout. Only fetch root package.json if signals warrant it.
      let rootPkg = null;
      try {
        const f = await getFileContent(githubToken, repoUrl, 'package.json', targetBranch);
        if (f?.content) rootPkg = f.content;
      } catch { /* ignore */ }
      result.monorepo = detectMonorepo(tree, rootPkg);

      // Filter out Dockerfiles that are already referenced in compose services
      if (result.composeServices.length > 0) {
        const composePaths = new Set(
          result.composeServices
            .filter(s => s.build)
            .map(s => {
              const context = s.build.context.replace(/^\.\//, '');
              const dockerfile = s.build.dockerfile;
              return context === '.' ? dockerfile : `${context}/${dockerfile}`;
            })
        );

        result.standaloneDockerfiles = result.standaloneDockerfiles.filter(
          df => !composePaths.has(df.path)
        );
      }

      return result;
    } catch (error) {
      fastify.log.error(`Failed to analyze repo: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to analyze repository'
      });
    }
  });
}
