import { defineConfig, type Plugin } from 'vite';

// In dev the page is served from http://localhost:<port>. The app's lib/api
// code calls apiFetch() (see src/lib/platform.ts), which rewrites every
// cross-origin request into a same-origin GET/POST to /proxy?url=<target>
// carrying the original method, headers and body. A normal web page cannot
// fetch those endpoints directly because of CORS; the browser extension
// version could via host_permissions. This middleware performs the real
// request from Node (where no CORS applies) and streams the upstream response
// back unchanged with permissive CORS headers — mirroring how the extension's
// background/offscreen handled cross-origin traffic.
function proxyPlugin(): Plugin {
  const HOP_BY_HOP = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'content-length',
  ]);

  return {
    name: 'feedtube-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith('/proxy?')) return next();

        let u: URL;
        try {
          u = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'bad proxy url' }));
          return;
        }

        const target = u.searchParams.get('url');
        if (!target || !/^https?:\/\//i.test(target)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'missing or invalid ?url= parameter' }));
          return;
        }

        const method = (req.method ?? 'GET').toUpperCase();

        void (async () => {
          let body: Blob | undefined;
          if (method !== 'GET' && method !== 'HEAD') {
            const chunks: Uint8Array[] = [];
            for await (const chunk of req) chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            if (buf.length > 0) body = new Blob([buf]);
          }

          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (!v || HOP_BY_HOP.has(k.toLowerCase())) continue;
            headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }

          // The browser auto-attaches Origin/Referer pointing at the local dev
          // server. Upstream APIs (especially YouTube's InnerTube) treat that as
          // automated/bot traffic and serve a "Sorry..." block page, so strip the
          // origin header and present a referer from the target site itself.
          delete headers['origin'];
          const tu = new URL(target);
          headers['referer'] = `${tu.origin}/`;
          if (!headers['accept']) headers['accept'] = '*/*';

          try {
            const up = await fetch(target, {
              method: (method as 'GET' | 'POST') === 'POST' ? 'POST' : 'GET',
              headers,
              body,
              redirect: 'follow',
              signal: AbortSignal.timeout(30000),
            });
            const buf = Buffer.from(await up.arrayBuffer());
            res.writeHead(up.status, {
              'content-type': up.headers.get('content-type') ?? 'application/octet-stream',
              'access-control-allow-origin': '*',
              'cache-control': 'no-store',
            });
            res.end(buf);
          } catch (e) {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, message: `proxy fetch failed: ${String(e)}` }));
            } else {
              res.destroy();
            }
          }
        })();
      });
    },
  };
}

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  plugins: [proxyPlugin()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5198',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
