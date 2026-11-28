import path from 'node:path';
import express from 'express';
import { ROOT_DIR } from './config/env.js';
import { createApiRouter } from './routes/api.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Basic local security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Never serve auth or database folders; only serve static frontend assets from /public
  const publicDir = path.join(ROOT_DIR, 'public');
  app.use(express.static(publicDir));

  app.use('/api', createApiRouter());

  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, req, res, _next) => {
    console.error('[Express] Erro interno:', err);
    res.status(500).json({
      error: err?.message || 'Erro interno do servidor.',
    });
  });

  return app;
}
