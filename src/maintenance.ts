import { Hono } from 'hono';
import type { Config } from './config.js';

/** Keep managed-provider health checks alive without opening the data volume.
 * Operators can use that same container's shell for exclusive offline recovery.
 */
export function createMaintenanceApplication(config: Config) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.production) c.header('Strict-Transport-Security', 'max-age=31536000');
    if (c.req.path !== '/healthz' && new URL(c.req.url).host !== new URL(config.origin).host)
      return c.text('Unrecognized host', 400);
    await next();
  });
  app.get('/healthz', (c) => c.json({ status: 'maintenance', ready: false, version: '0.1.0' }));
  app.all('*', (c) => {
    c.header('Retry-After', '300');
    return c.text(
      'This circle is taking a short maintenance break. Please come back shortly.',
      503,
    );
  });
  return app;
}
