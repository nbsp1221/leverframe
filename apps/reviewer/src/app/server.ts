import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { createMarkdownFromOpenApi } from '@scalar/openapi-to-markdown';
import { HTTPException } from 'hono/http-exception';
import type { CredentialStore } from '../github/credentials.js';
import type { JobDatabase } from '../jobs/database.js';
import { ExecutionTraceStore } from '../execution/trace.js';
import type { ServerConfig } from './config.js';
import { registerDevelopmentRoutes } from './routes/development.js';
import { registerGitHubRoutes } from './routes/github.js';
import { registerReviewExecutionRoutes } from './routes/review-execution.js';
import { registerReviewRoutes } from './routes/reviews.js';
import {
  type Dependency,
  type Observation,
  type ServerHooks,
  apiError,
  createObservations,
} from './server-common.js';

export type { ServerHooks } from './server-common.js';

const renderOpenApiMarkdown = createMarkdownFromOpenApi as (document: unknown) => Promise<string>;
const scalarBrowserScript = loadScalarBrowserScript();
const scalarBrowserPath = `/docs/assets/scalar-${createHash('sha256')
  .update(scalarBrowserScript)
  .digest('hex')
  .slice(0, 16)}.js`;

function loadScalarBrowserScript(): string {
  const bundledPath = fileURLToPath(new URL('./scalar-api-reference.js', import.meta.url));
  if (existsSync(bundledPath)) {
    return readFileSync(bundledPath, 'utf8');
  }

  const packageEntry = createRequire(import.meta.url).resolve('@scalar/api-reference');
  const developmentPath = join(dirname(packageEntry), 'browser', 'standalone.js');
  return readFileSync(developmentPath, 'utf8');
}

function createApi(
  config: ServerConfig,
  database: JobDatabase,
  credentials: CredentialStore,
  hooks: ServerHooks,
  traceStore: ExecutionTraceStore,
): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) {
        return;
      }
      const invalidVerdict = result.error.issues.some((issue) => issue.path.at(-1) === 'verdict');
      let code = 'INVALID_REQUEST';
      if (invalidVerdict) {
        code = 'INVALID_VERDICT';
      } else if (result.target === 'query') {
        code = 'INVALID_QUERY';
      } else if (result.target === 'param') {
        code = c.req.path.includes('/findings/') ? 'INVALID_TARGET' : 'INVALID_ID';
      }
      return apiError(c, 422, 'invalid request', code, result.error.issues);
    },
  });
  app.onError((error, c) => {
    if (
      error instanceof HTTPException &&
      error.status === 400 &&
      error.message === 'Malformed JSON in request body' &&
      c.req.path.startsWith('/api/v1/')
    ) {
      return apiError(c, 422, 'invalid request', 'INVALID_REQUEST');
    }
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    console.error(error);
    return c.text('Internal Server Error', 500);
  });
  const observations = createObservations();

  const observed = (
    dependency: Dependency,
    status: Observation['status'],
    detail: string | null = null,
  ) => {
    observations[dependency] = { status, detail, last_observed_at: new Date().toISOString() };
  };

  const recordRead = () => {
    observed('api', 'healthy');
    observed('database', 'healthy');
  };

  registerGitHubRoutes(app, config, database, credentials, hooks, observed);
  registerDevelopmentRoutes(app, database, hooks, config.development?.repository);
  registerReviewRoutes(app, database, hooks, observations, recordRead);
  registerReviewExecutionRoutes(app, database, traceStore, recordRead);

  const openApiDocument = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Leverframe Review API',
      version: '1.0.0',
      description:
        'Private review observation and evaluation API shared by Leverframe web and external tools on the same trusted network. External agents must obtain human approval before evaluation writes; Leverframe does not run or verify that approval workflow. Before writing, read the current evaluation revision and send its ID as expected_previous_id. After a lost response, read evaluation history to discover whether the write succeeded instead of blindly retrying it.',
    },
    servers: [{ url: '/', description: 'Same-origin private Leverframe deployment' }],
  });
  let llmsDocument: Promise<string> | undefined;

  const getLlmsDocument = (): Promise<string> => {
    llmsDocument ??= renderOpenApiMarkdown(openApiDocument);
    return llmsDocument;
  };

  app.get('/openapi.json', (c) => c.json(openApiDocument));
  app.get(scalarBrowserPath, (c) =>
    c.body(scalarBrowserScript, 200, {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': 'text/javascript; charset=utf-8',
    }),
  );
  const scalar = Scalar({
    agent: { disabled: true },
    cdn: scalarBrowserPath,
    hideClientButton: true,
    pageTitle: 'Leverframe Review API',
    showDeveloperTools: 'never',
    telemetry: false,
    url: '/openapi.json',
    withDefaultFonts: false,
  });

  const scalarPage: typeof scalar = async (c, next) => {
    const response = await scalar(c, next);
    if (response === undefined) {
      return;
    }
    return new Response((await response.text()).replace('<html>', '<html lang="en">'), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  app.get('/docs', scalarPage);
  app.get('/docs/', scalarPage);
  app.get('/llms.txt', async (c) => {
    try {
      return new Response(await getLlmsDocument(), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    } catch (error) {
      console.error('failed to generate LLM API documentation', error);
      return c.text('API documentation generation failed.', 500);
    }
  });
  return app;
}

export function createLeverframeServer(
  config: ServerConfig,
  database: JobDatabase,
  credentials: CredentialStore,
  hooks: ServerHooks = {},
  traceStore: ExecutionTraceStore = new ExecutionTraceStore(config.jobsDirectory),
) {
  const listener = getRequestListener(
    createApi(config, database, credentials, hooks, traceStore).fetch,
  );
  return createServer((request, response) => {
    void listener(request, response);
  });
}
