import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const headers = Object.fromEntries(
  readFileSync(new URL('./public/_headers', import.meta.url), 'utf8')
    .split('\n/assets/')[0]
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(2, colon), line.slice(colon + 1).trim()];
    }),
);

export default defineConfig({
  plugins: [
    {
      name: 'preview-security-headers',
      configurePreviewServer(server) {
        server.middlewares.use((_req, res, next) => {
          for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
          next();
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { sourcemap: false },
});
