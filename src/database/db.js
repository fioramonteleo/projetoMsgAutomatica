import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  config,
  DEFAULT_CAMPAIGN_MESSAGE,
  DEFAULT_CAMPAIGN_NAME,
} from '../config/env.js';
import { getSaoPauloTimestamp } from '../services/timeService.js';

let dbInstance = null;

/**
 * Opens (or creates) the local SQLite database, ensures all required tables/constraints exist,
 * and seeds default settings and the initial Negão Lanches campaign if empty.
 */
export function initDatabase(customDbPath = config.dbPath) {
  if (dbInstance && customDbPath === config.dbPath) {
    return dbInstance;
  }

  if (customDbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(customDbPath), { recursive: true });
  }

  const db = new DatabaseSync(customDbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS campanhas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'INATIVA',
      horario_inicio TEXT NOT NULL DEFAULT '17:00',
      horario_fim TEXT NOT NULL DEFAULT '00:00',
      data_criacao DATETIME NOT NULL,
      data_ativacao DATETIME
    );

    CREATE TABLE IF NOT EXISTS respostas_enviadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanha_id INTEGER NOT NULL,
      telefone TEXT NOT NULL,
      data_referencia TEXT NOT NULL,
      data_recebimento DATETIME NOT NULL,
      data_resposta DATETIME,
      status TEXT NOT NULL,
      erro TEXT,
      FOREIGN KEY (campanha_id) REFERENCES campanhas(id) ON DELETE CASCADE,
      UNIQUE (campanha_id, telefone, data_referencia)
    );

    CREATE INDEX IF NOT EXISTS idx_respostas_data_ref
      ON respostas_enviadas (data_referencia, campanha_id);

    CREATE TABLE IF NOT EXISTS eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefone TEXT,
      tipo_evento TEXT NOT NULL,
      data_evento DATETIME NOT NULL,
      campanha_id INTEGER,
      descricao TEXT,
      data_referencia TEXT,
      data_resposta DATETIME,
      FOREIGN KEY (campanha_id) REFERENCES campanhas(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eventos_data_ref
      ON eventos (data_referencia, tipo_evento);

    CREATE INDEX IF NOT EXISTS idx_eventos_telefone
      ON eventos (telefone);

    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contatos_opt_out (
      telefone TEXT PRIMARY KEY,
      motivo TEXT,
      criado_em DATETIME NOT NULL
    );
  `);

  seedInitialData(db);

  if (customDbPath === config.dbPath) {
    dbInstance = db;
  }

  return db;
}

function seedInitialData(db) {
  const now = getSaoPauloTimestamp();

  const existingCampaigns = db.prepare('SELECT COUNT(*) AS total FROM campanhas').get();
  if (existingCampaigns.total === 0) {
    db.prepare(`
      INSERT INTO campanhas (
        nome, mensagem, status, horario_inicio, horario_fim, data_criacao, data_ativacao
      ) VALUES (?, ?, 'ATIVA', ?, ?, ?, ?)
    `).run(
      DEFAULT_CAMPAIGN_NAME,
      DEFAULT_CAMPAIGN_MESSAGE,
      config.defaultWindowStart,
      config.defaultWindowEnd,
      now,
      now
    );
  }

  const defaultSettings = [
    ['bot_ativo', 'true'],
    ['ultima_conexao', ''],
    ['numero_conectado', ''],
  ];

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO configuracoes (chave, valor, atualizado_em)
    VALUES (?, ?, ?)
  `);

  for (const [chave, valor] of defaultSettings) {
    insertSetting.run(chave, valor, now);
  }
}

export function getDatabase() {
  if (!dbInstance) {
    return initDatabase(config.dbPath);
  }
  return dbInstance;
}

export function closeDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors during shutdown
    }
    dbInstance = null;
  }
}

export function runInTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(key);
  return row ? row.valor : fallback;
}

export function setSetting(db, key, value) {
  const now = getSaoPauloTimestamp();
  db.prepare(`
    INSERT INTO configuracoes (chave, valor, atualizado_em)
    VALUES (?, ?, ?)
    ON CONFLICT(chave) DO UPDATE SET
      valor = excluded.valor,
      atualizado_em = excluded.atualizado_em
  `).run(key, String(value ?? ''), now);
}
