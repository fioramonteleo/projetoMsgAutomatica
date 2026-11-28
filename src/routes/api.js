import express from 'express';
import { config, HISTORY_STATUS } from '../config/env.js';
import {
  activateCampaign,
  createCampaign,
  deactivateCampaign,
  getActiveCampaign,
  listCampaigns,
  updateCampaign,
} from '../services/campaignService.js';
import {
  addOptOut,
  getDashboardStats,
  getHistory,
  isBotEnabled,
  listOptOuts,
  removeOptOut,
  setBotEnabled,
} from '../services/replyService.js';
import { sseService } from '../services/sseService.js';
import { getWindowStatusInfo } from '../services/timeService.js';
import { whatsappService } from '../services/whatsappService.js';

export function buildDashboardPayload() {
  const activeCampaign = getActiveCampaign();
  const windowStart = activeCampaign?.horario_inicio || config.defaultWindowStart;
  const windowEnd = activeCampaign?.horario_fim || config.defaultWindowEnd;
  const windowInfo = getWindowStatusInfo(windowStart, windowEnd);

  return {
    whatsapp: whatsappService.getState(),
    bot: {
      ativo: isBotEnabled(),
      campanhaAtiva: activeCampaign,
      horarioPermitido: `${windowStart} às ${windowEnd}`,
      janelaAberta: windowInfo.isOpen,
      proximaAbertura: windowInfo.nextOpenText,
    },
    stats: getDashboardStats(),
    time: windowInfo,
    historyStatuses: Object.values(HISTORY_STATUS),
  };
}

export function createApiRouter() {
  const router = express.Router();

  // Optional local panel protection middleware when PANEL_ACCESS_KEY is configured in .env
  router.use((req, res, next) => {
    if (!config.panelAccessKey) {
      return next();
    }
    if (req.path === '/auth/status' || req.path === '/auth/verify') {
      return next();
    }
    const provided = req.headers['x-panel-key'] || req.query.panelKey || '';
    if (provided !== config.panelAccessKey) {
      return res.status(401).json({ error: 'Chave de acesso do painel inválida ou ausente.' });
    }
    return next();
  });

  router.get('/auth/status', (req, res) => {
    res.json({
      requiresKey: Boolean(config.panelAccessKey),
    });
  });

  router.post('/auth/verify', (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!config.panelAccessKey || key === config.panelAccessKey) {
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false, error: 'Chave incorreta.' });
  });

  router.get('/events', (req, res) => {
    sseService.addClient(res);
  });

  router.get('/dashboard', (req, res) => {
    res.json(buildDashboardPayload());
  });

  router.post('/whatsapp/connect', async (req, res, next) => {
    try {
      // Trigger connection without blocking HTTP response if QR arrives asynchronously
      const connectPromise = whatsappService.connect();
      await Promise.race([
        connectPromise,
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
      res.json(whatsappService.getState());
    } catch (err) {
      next(err);
    }
  });

  router.post('/whatsapp/disconnect', async (req, res, next) => {
    try {
      const logout = Boolean(req.body?.logout);
      const state = await whatsappService.disconnect({ logout });
      sseService.broadcast('dashboard_update', { reason: 'whatsapp_disconnected' });
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post('/bot/activate', (req, res) => {
    setBotEnabled(true);
    const payload = buildDashboardPayload();
    sseService.broadcast('dashboard_update', { reason: 'bot_activated' });
    res.json(payload);
  });

  router.post('/bot/deactivate', (req, res) => {
    setBotEnabled(false);
    const payload = buildDashboardPayload();
    sseService.broadcast('dashboard_update', { reason: 'bot_deactivated' });
    res.json(payload);
  });

  router.get('/campaigns', (req, res) => {
    res.json({ campaigns: listCampaigns() });
  });

  router.post('/campaigns', (req, res, next) => {
    try {
      const campaign = createCampaign(req.body || {});
      sseService.broadcast('dashboard_update', { reason: 'campaign_created' });
      res.status(201).json({ campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/campaigns/:id', (req, res) => {
    try {
      const campaign = updateCampaign(req.params.id, req.body || {});
      sseService.broadcast('dashboard_update', { reason: 'campaign_updated' });
      res.json({ campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/campaigns/:id/activate', (req, res) => {
    try {
      const campaign = activateCampaign(req.params.id);
      sseService.broadcast('dashboard_update', { reason: 'campaign_activated' });
      res.json({ campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/campaigns/:id/deactivate', (req, res) => {
    try {
      const campaign = deactivateCampaign(req.params.id);
      sseService.broadcast('dashboard_update', { reason: 'campaign_deactivated' });
      res.json({ campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/history', (req, res) => {
    const items = getHistory({
      data: req.query.data || '',
      telefone: req.query.telefone || '',
      campanhaId: req.query.campanhaId || '',
      status: req.query.status || '',
      limit: req.query.limit || 300,
    });
    res.json({ items });
  });

  router.get('/opt-outs', (req, res) => {
    res.json({ items: listOptOuts() });
  });

  router.post('/opt-outs', (req, res) => {
    try {
      const item = addOptOut(req.body?.telefone, req.body?.motivo || 'Bloqueado manualmente no painel');
      res.status(201).json({ item });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/opt-outs/:telefone', (req, res) => {
    removeOptOut(req.params.telefone);
    res.json({ ok: true });
  });

  return router;
}
