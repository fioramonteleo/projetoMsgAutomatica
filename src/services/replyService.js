import { HISTORY_STATUS } from '../config/env.js';
import { getDatabase, getSetting, runInTransaction, setSetting } from '../database/db.js';
import { getActiveCampaign } from './campaignService.js';
import { getReferenceDate, getSaoPauloTimestamp, isWithinAllowedWindow } from './timeService.js';

const OPT_OUT_KEYWORDS = new Set([
  'SAIR',
  'PARAR',
  'PARE',
  'CANCELAR',
  'STOP',
  'REMOVER',
  'DESCADASTRAR',
  'NAO QUERO',
  'NÃO QUERO',
]);

export function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  const str = String(rawPhone);
  const beforeAt = str.includes('@') ? str.split('@')[0] : str;
  const beforeColon = beforeAt.includes(':') ? beforeAt.split(':')[0] : beforeAt;
  const digits = beforeColon.replace(/\D/g, '');
  return digits || beforeColon.trim();
}

export function formatPhoneDisplay(phone) {
  const digits = normalizePhone(phone);
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (num.length === 9) {
      return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
    }
    if (num.length === 8) {
      return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
    }
  }
  return digits ? `+${digits}` : 'Desconhecido';
}

export function isBotEnabled(db = getDatabase()) {
  return getSetting(db, 'bot_ativo', 'true') === 'true';
}

export function setBotEnabled(enabled, db = getDatabase()) {
  setSetting(db, 'bot_ativo', enabled ? 'true' : 'false');
  return isBotEnabled(db);
}

export function isOptedOut(phone, db = getDatabase()) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const row = db.prepare('SELECT telefone FROM contatos_opt_out WHERE telefone = ?').get(normalized);
  return Boolean(row);
}

export function addOptOut(phone, motivo = 'Solicitado pelo contato', db = getDatabase(), now = new Date()) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error('Telefone inválido para bloqueio.');
  }
  const timestamp = getSaoPauloTimestamp(now);
  db.prepare(`
    INSERT INTO contatos_opt_out (telefone, motivo, criado_em)
    VALUES (?, ?, ?)
    ON CONFLICT(telefone) DO UPDATE SET
      motivo = excluded.motivo
  `).run(normalized, motivo, timestamp);
  return { telefone: normalized, motivo, criado_em: timestamp };
}

export function removeOptOut(phone, db = getDatabase()) {
  const normalized = normalizePhone(phone);
  db.prepare('DELETE FROM contatos_opt_out WHERE telefone = ?').run(normalized);
}

export function listOptOuts(db = getDatabase()) {
  return db.prepare('SELECT * FROM contatos_opt_out ORDER BY criado_em DESC').all();
}

function logEvent(db, { telefone, tipoEvento, dataEvento, campanhaId = null, descricao = '', dataReferencia, dataResposta = null }) {
  db.prepare(`
    INSERT INTO eventos (
      telefone, tipo_evento, data_evento, campanha_id, descricao, data_referencia, data_resposta
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    telefone || null,
    tipoEvento,
    dataEvento,
    campanhaId,
    descricao,
    dataReferencia,
    dataResposta
  );
}

function isOptOutMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.trim().toUpperCase().replace(/[.!?]+$/g, '').trim();
  return OPT_OUT_KEYWORDS.has(normalized);
}

/**
 * Core message-handling pipeline with atomic SQLite duplicate prevention.
 * Never queues out-of-hours messages and guarantees at most 1 reply per number per day per campaign.
 */
export async function processIncomingMessage({
  phone,
  messageText = '',
  sendFn,
  db = getDatabase(),
  now = new Date(),
}) {
  const telefone = normalizePhone(phone);
  if (!telefone) {
    return { action: 'ignored', reason: 'invalid_phone' };
  }

  const instant = now instanceof Date ? now : new Date(now);
  const dataReferencia = getReferenceDate(instant);
  const dataRecebimento = getSaoPauloTimestamp(instant);
  const campaign = getActiveCampaign(db);
  const campanhaId = campaign ? campaign.id : null;

  // 1. Respect opt-out requests
  if (isOptOutMessage(messageText)) {
    addOptOut(telefone, 'Cliente solicitou interromper mensagens automáticas', db, instant);
    logEvent(db, {
      telefone,
      tipoEvento: HISTORY_STATUS.IGNORED_OPT_OUT,
      dataEvento: dataRecebimento,
      campanhaId,
      descricao: 'Contato solicitou não receber mais mensagens (opt-out registrado).',
      dataReferencia,
    });
    return { action: 'ignored', reason: 'opt_out_requested', telefone };
  }

  if (isOptedOut(telefone, db)) {
    logEvent(db, {
      telefone,
      tipoEvento: HISTORY_STATUS.IGNORED_OPT_OUT,
      dataEvento: dataRecebimento,
      campanhaId,
      descricao: 'Contato está na lista de opt-out / bloqueados.',
      dataReferencia,
    });
    return { action: 'ignored', reason: 'opt_out', telefone };
  }

  // 2. Check if bot is active
  if (!isBotEnabled(db)) {
    logEvent(db, {
      telefone,
      tipoEvento: HISTORY_STATUS.IGNORED_BOT_DISABLED,
      dataEvento: dataRecebimento,
      campanhaId,
      descricao: 'Bot está desativado no painel.',
      dataReferencia,
    });
    return { action: 'ignored', reason: 'bot_disabled', telefone };
  }

  // 3. Check if there is an active campaign
  if (!campaign) {
    logEvent(db, {
      telefone,
      tipoEvento: HISTORY_STATUS.IGNORED_NO_CAMPAIGN,
      dataEvento: dataRecebimento,
      campanhaId: null,
      descricao: 'Nenhuma campanha ativa no momento.',
      dataReferencia,
    });
    return { action: 'ignored', reason: 'no_active_campaign', telefone };
  }

  // 4. Check allowed hours in America/Sao_Paulo (e.g. 17:00 to 00:00)
  if (!isWithinAllowedWindow(campaign.horario_inicio, campaign.horario_fim, instant)) {
    logEvent(db, {
      telefone,
      tipoEvento: HISTORY_STATUS.IGNORED_OUT_OF_HOURS,
      dataEvento: dataRecebimento,
      campanhaId: campaign.id,
      descricao: `Mensagem recebida fora do horário permitido (${campaign.horario_inicio} às ${campaign.horario_fim}).`,
      dataReferencia,
    });
    return { action: 'ignored', reason: 'out_of_hours', telefone, campaignId: campaign.id };
  }

  // 5. Atomic reservation for (campanha_id, telefone, data_referencia)
  const reservation = runInTransaction(db, () => {
    const existing = db.prepare(`
      SELECT id, status
      FROM respostas_enviadas
      WHERE campanha_id = ? AND telefone = ? AND data_referencia = ?
    `).get(campaign.id, telefone, dataReferencia);

    if (existing) {
      return { reserved: false, existingStatus: existing.status };
    }

    const insertResult = db.prepare(`
      INSERT INTO respostas_enviadas (
        campanha_id, telefone, data_referencia, data_recebimento, data_resposta, status, erro
      ) VALUES (?, ?, ?, ?, NULL, ?, NULL)
    `).run(campaign.id, telefone, dataReferencia, dataRecebimento, HISTORY_STATUS.WAITING);

    return { reserved: true, respostaId: Number(insertResult.lastInsertRowid) };
  });

  if (!reservation.reserved) {
    const isPrevError = reservation.existingStatus === HISTORY_STATUS.ERROR;
    const desc = isPrevError
      ? 'Tentativa anterior hoje terminou com erro; envio bloqueado para evitar duplicidade.'
      : 'Número já recebeu resposta automática hoje nesta campanha.';

    logEvent(db, {
      telefone,
      tipoEvento: HISTORY_STATUS.IGNORED_DAILY_LIMIT,
      dataEvento: dataRecebimento,
      campanhaId: campaign.id,
      descricao: desc,
      dataReferencia,
    });

    return {
      action: 'ignored',
      reason: isPrevError ? 'previous_error_locked' : 'daily_limit',
      existingStatus: reservation.existingStatus,
      telefone,
      campaignId: campaign.id,
    };
  }

  // 6. Send message via WhatsApp outside SQLite write lock
  try {
    await sendFn(campaign.mensagem);
    const dataResposta = getSaoPauloTimestamp(now instanceof Date && now.getTime() !== Date.now() ? now : new Date());

    runInTransaction(db, () => {
      db.prepare(`
        UPDATE respostas_enviadas
        SET status = ?, data_resposta = ?, erro = NULL
        WHERE id = ?
      `).run(HISTORY_STATUS.RESPONDED, dataResposta, reservation.respostaId);

      logEvent(db, {
        telefone,
        tipoEvento: HISTORY_STATUS.RESPONDED,
        dataEvento: dataRecebimento,
        campanhaId: campaign.id,
        descricao: 'Resposta automática enviada com sucesso.',
        dataReferencia,
        dataResposta,
      });
    });

    return {
      action: 'responded',
      respostaId: reservation.respostaId,
      telefone,
      campaignId: campaign.id,
      dataReferencia,
      dataResposta,
    };
  } catch (err) {
    const errorMsg = err?.message || 'Erro desconhecido ao enviar mensagem pelo WhatsApp.';

    runInTransaction(db, () => {
      db.prepare(`
        UPDATE respostas_enviadas
        SET status = ?, erro = ?
        WHERE id = ?
      `).run(HISTORY_STATUS.ERROR, errorMsg, reservation.respostaId);

      logEvent(db, {
        telefone,
        tipoEvento: HISTORY_STATUS.ERROR,
        dataEvento: dataRecebimento,
        campanhaId: campaign.id,
        descricao: errorMsg,
        dataReferencia,
      });
    });

    return {
      action: 'error',
      respostaId: reservation.respostaId,
      error: errorMsg,
      telefone,
      campaignId: campaign.id,
    };
  }
}

export function getDashboardStats(db = getDatabase(), now = new Date()) {
  const today = getReferenceDate(now);

  const repliedToday = db.prepare(`
    SELECT
      COUNT(*) AS total_respostas_hoje,
      COUNT(DISTINCT telefone) AS total_numeros_respondidos_hoje
    FROM respostas_enviadas
    WHERE data_referencia = ? AND status = ?
  `).get(today, HISTORY_STATUS.RESPONDED);

  const eventCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_mensagens_recebidas,
      SUM(CASE WHEN tipo_evento = ? THEN 1 ELSE 0 END) AS total_ignoradas_limite_diario,
      SUM(CASE WHEN tipo_evento = ? THEN 1 ELSE 0 END) AS total_ignoradas_horario,
      SUM(CASE WHEN tipo_evento = ? THEN 1 ELSE 0 END) AS total_erros
    FROM eventos
  `).get(
    HISTORY_STATUS.IGNORED_DAILY_LIMIT,
    HISTORY_STATUS.IGNORED_OUT_OF_HOURS,
    HISTORY_STATUS.ERROR
  );

  const waitingCount = db.prepare(`
    SELECT COUNT(*) AS total_aguardando
    FROM respostas_enviadas
    WHERE status = ?
  `).get(HISTORY_STATUS.WAITING);

  return {
    dataReferencia: today,
    totalRespostasHoje: repliedToday.total_respostas_hoje || 0,
    totalNumerosRespondidosHoje: repliedToday.total_numeros_respondidos_hoje || 0,
    totalMensagensRecebidas: eventCounts.total_mensagens_recebidas || 0,
    totalIgnoradasLimiteDiario: eventCounts.total_ignoradas_limite_diario || 0,
    totalIgnoradasHorario: eventCounts.total_ignoradas_horario || 0,
    totalErros: eventCounts.total_erros || 0,
    totalAguardando: waitingCount.total_aguardando || 0,
  };
}

export function getHistory({ data = '', telefone = '', campanhaId = '', status = '', limit = 200 } = {}, db = getDatabase()) {
  const conditions = [];
  const params = [];

  if (data) {
    conditions.push('e.data_referencia = ?');
    params.push(data.trim());
  }
  if (telefone) {
    const cleanPhone = normalizePhone(telefone);
    conditions.push('e.telefone LIKE ?');
    params.push(`%${cleanPhone || telefone.trim()}%`);
  }
  if (campanhaId) {
    conditions.push('e.campanha_id = ?');
    params.push(Number(campanhaId));
  }
  if (status) {
    conditions.push('e.tipo_evento = ?');
    params.push(status.trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  const rows = db.prepare(`
    SELECT
      e.id,
      e.telefone,
      e.tipo_evento AS status,
      e.data_evento AS data_recebimento,
      e.data_resposta,
      e.data_referencia,
      e.campanha_id,
      c.nome AS campanha_nome,
      e.descricao
    FROM eventos e
    LEFT JOIN campanhas c ON c.id = e.campanha_id
    ${whereClause}
    ORDER BY e.id DESC
    LIMIT ?
  `).all(...params, safeLimit);

  return rows.map((row) => {
    const [dataMsg = '', horaMsg = ''] = (row.data_recebimento || '').split(' ');
    const [dataResp = '', horaResp = ''] = (row.data_resposta || '').split(' ');
    return {
      ...row,
      telefone_formatado: formatPhoneDisplay(row.telefone),
      data_mensagem: dataMsg,
      horario_mensagem: horaMsg,
      data_resposta_dia: dataResp || '-',
      horario_resposta: horaResp || '-',
    };
  });
}
