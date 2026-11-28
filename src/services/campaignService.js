import { config } from '../config/env.js';
import { getDatabase, runInTransaction } from '../database/db.js';
import { getSaoPauloTimestamp, isValidTimeFormat } from './timeService.js';

export function listCampaigns(db = getDatabase()) {
  return db.prepare(`
    SELECT
      c.*,
      COALESCE(stats.total_numeros_respondidos, 0) AS total_numeros_respondidos,
      COALESCE(stats.total_respostas, 0) AS total_respostas
    FROM campanhas c
    LEFT JOIN (
      SELECT
        campanha_id,
        COUNT(DISTINCT telefone) AS total_numeros_respondidos,
        COUNT(*) AS total_respostas
      FROM respostas_enviadas
      WHERE status = 'RESPONDIDO'
      GROUP BY campanha_id
    ) stats ON stats.campanha_id = c.id
    ORDER BY
      CASE WHEN c.status = 'ATIVA' THEN 0 ELSE 1 END,
      c.id DESC
  `).all();
}

export function getCampaignById(id, db = getDatabase()) {
  return db.prepare(`
    SELECT
      c.*,
      COALESCE((
        SELECT COUNT(DISTINCT telefone)
        FROM respostas_enviadas r
        WHERE r.campanha_id = c.id AND r.status = 'RESPONDIDO'
      ), 0) AS total_numeros_respondidos,
      COALESCE((
        SELECT COUNT(*)
        FROM respostas_enviadas r
        WHERE r.campanha_id = c.id AND r.status = 'RESPONDIDO'
      ), 0) AS total_respostas
    FROM campanhas c
    WHERE c.id = ?
  `).get(Number(id));
}

export function getActiveCampaign(db = getDatabase()) {
  return db.prepare(`
    SELECT
      c.*,
      COALESCE((
        SELECT COUNT(DISTINCT telefone)
        FROM respostas_enviadas r
        WHERE r.campanha_id = c.id AND r.status = 'RESPONDIDO'
      ), 0) AS total_numeros_respondidos
    FROM campanhas c
    WHERE c.status = 'ATIVA'
    ORDER BY c.data_ativacao DESC, c.id DESC
    LIMIT 1
  `).get() || null;
}

function validateCampaignInput({ nome, mensagem, horario_inicio, horario_fim }) {
  if (typeof nome !== 'string' || !nome.trim()) {
    throw new Error('O nome da campanha é obrigatório.');
  }
  if (typeof mensagem !== 'string' || !mensagem.trim()) {
    throw new Error('A mensagem automática é obrigatória.');
  }

  const start = (horario_inicio || config.defaultWindowStart).trim();
  const end = (horario_fim || config.defaultWindowEnd).trim();

  if (!isValidTimeFormat(start) || !isValidTimeFormat(end)) {
    throw new Error('Horários devem estar no formato HH:MM (ex: 17:00 e 00:00).');
  }
  if (start === end) {
    throw new Error('O horário inicial e final não podem ser iguais.');
  }

  return {
    nome: nome.trim(),
    // Preserve exact line breaks and intentional formatting in the message
    mensagem: mensagem.replace(/\r\n/g, '\n').trim(),
    horario_inicio: start,
    horario_fim: end,
  };
}

export function createCampaign(input, db = getDatabase()) {
  const clean = validateCampaignInput(input);
  const activateNow = Boolean(input.ativar);
  const now = getSaoPauloTimestamp();

  const createdId = runInTransaction(db, () => {
    if (activateNow) {
      db.prepare(`UPDATE campanhas SET status = 'INATIVA' WHERE status = 'ATIVA'`).run();
    }

    const result = db.prepare(`
      INSERT INTO campanhas (
        nome, mensagem, status, horario_inicio, horario_fim, data_criacao, data_ativacao
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      clean.nome,
      clean.mensagem,
      activateNow ? 'ATIVA' : 'INATIVA',
      clean.horario_inicio,
      clean.horario_fim,
      now,
      activateNow ? now : null
    );

    return Number(result.lastInsertRowid);
  });

  return getCampaignById(createdId, db);
}

export function updateCampaign(id, input, db = getDatabase()) {
  const existing = getCampaignById(id, db);
  if (!existing) {
    throw new Error('Campanha não encontrada.');
  }

  const clean = validateCampaignInput({
    nome: input.nome ?? existing.nome,
    mensagem: input.mensagem ?? existing.mensagem,
    horario_inicio: input.horario_inicio ?? existing.horario_inicio,
    horario_fim: input.horario_fim ?? existing.horario_fim,
  });

  db.prepare(`
    UPDATE campanhas
    SET nome = ?, mensagem = ?, horario_inicio = ?, horario_fim = ?
    WHERE id = ?
  `).run(clean.nome, clean.mensagem, clean.horario_inicio, clean.horario_fim, Number(id));

  return getCampaignById(id, db);
}

export function activateCampaign(id, db = getDatabase()) {
  const existing = getCampaignById(id, db);
  if (!existing) {
    throw new Error('Campanha não encontrada.');
  }

  const now = getSaoPauloTimestamp();
  runInTransaction(db, () => {
    db.prepare(`UPDATE campanhas SET status = 'INATIVA' WHERE status = 'ATIVA'`).run();
    db.prepare(`UPDATE campanhas SET status = 'ATIVA', data_ativacao = ? WHERE id = ?`).run(now, Number(id));
  });

  return getCampaignById(id, db);
}

export function deactivateCampaign(id, db = getDatabase()) {
  const existing = getCampaignById(id, db);
  if (!existing) {
    throw new Error('Campanha não encontrada.');
  }

  db.prepare(`UPDATE campanhas SET status = 'INATIVA' WHERE id = ?`).run(Number(id));
  return getCampaignById(id, db);
}
