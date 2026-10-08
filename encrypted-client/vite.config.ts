import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          const localBook = ['/book', '/book.html', '/book/'].includes(pathname);
          // Loopback hosts are a local preview feature, never a deployed CSP permission.
          for (const [key, value] of Object.entries(headers))
            res.setHeader(
              key,
              key === 'Content-Security-Policy'
                ? value.replace(
                    'connect-src https:;',
                    'connect-src https: http://127.0.0.1:* http://localhost:* http://[::1]:*;',
                  ) + (localBook ? ", connect-src 'none';" : '')
                : value,
            );
          next();
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    sourcemap: false,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        book: fileURLToPath(new URL('./book.html', import.meta.url)),
      },
    },
  },
});
