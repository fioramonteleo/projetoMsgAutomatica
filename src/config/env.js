import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const TIMEZONE = 'America/Sao_Paulo';

export const DEFAULT_CAMPAIGN_NAME = 'Aviso Fim de Semana — Novembro 2026';

export const DEFAULT_CAMPAIGN_MESSAGE =
  'Olá! Aqui é do Negão Lanches!\n\n' +
  'Informamos que não teremos atendimento neste fim de semana, do dia 26/11/2026 ao dia 29/11/2026.\n\n' +
  'Retornaremos normalmente no próximo fim de semana.\n\n' +
  'Desejamos a todos um ótimo fim de semana! Deus abençoe e muito obrigado pela preferência!';

export const WHATSAPP_STATES = {
  DISCONNECTED: 'Desconectado',
  WAITING_QR: 'Aguardando leitura do QR Code',
  CONNECTING: 'Conectando',
  CONNECTED: 'Conectado',
  RECONNECTING: 'Reconectando',
  ERROR: 'Erro de conexão',
};

export const HISTORY_STATUS = {
  RESPONDED: 'RESPONDIDO',
  IGNORED_OUT_OF_HOURS: 'IGNORADO — FORA DO HORÁRIO',
  IGNORED_DAILY_LIMIT: 'IGNORADO — LIMITE DIÁRIO',
  ERROR: 'ERRO',
  WAITING: 'AGUARDANDO',
  IGNORED_BOT_DISABLED: 'IGNORADO — BOT DESATIVADO',
  IGNORED_NO_CAMPAIGN: 'IGNORADO — SEM CAMPANHA ATIVA',
  IGNORED_OPT_OUT: 'IGNORADO — BLOQUEADO / OPT-OUT',
};

export const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  timezone: TIMEZONE,
  defaultWindowStart: process.env.DEFAULT_WINDOW_START || '17:00',
  defaultWindowEnd: process.env.DEFAULT_WINDOW_END || '00:00',
  dbPath: path.resolve(ROOT_DIR, process.env.DB_PATH || './storage/database/negao_lanches.db'),
  authDir: path.resolve(ROOT_DIR, process.env.AUTH_DIR || './storage/auth'),
  panelAccessKey: (process.env.PANEL_ACCESS_KEY || '').trim(),
  whatsappLogLevel: process.env.WHATSAPP_LOG_LEVEL || 'warn',
};
