import fs from 'node:fs';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBot,
  isJidBroadcast,
  isJidGroup,
  isJidMetaAI,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { config, WHATSAPP_STATES } from '../config/env.js';
import { getDatabase, getSetting, setSetting } from '../database/db.js';
import { formatPhoneDisplay, normalizePhone, processIncomingMessage } from './replyService.js';
import { sseService } from './sseService.js';
import { getSaoPauloTimestamp } from './timeService.js';

const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_PROCESSED_IDS = 2000;
const STALE_MESSAGE_SECONDS = 180;
const PRESENCE_UPDATE_COOLDOWN_MS = 2000;
const POST_CONNECT_PRESENCE_DELAY_MS = 1500;
const CREDS_UPDATE_PRESENCE_DELAY_MS = 500;

const IGNORED_MESSAGE_KEYS = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'reactionMessage',
  'keepInChatMessage',
  'encReactionMessage',
  'messageContextInfo',
]);

function unwrapMessageContent(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.ephemeralMessage?.message) return unwrapMessageContent(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessageContent(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessageContent(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessageContent(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessageContent(message.documentWithCaptionMessage.message);
  return message;
}

export function extractTextFromMessage(message) {
  const unwrapped = unwrapMessageContent(message);
  if (!unwrapped) return '';
  if (typeof unwrapped.conversation === 'string') return unwrapped.conversation;
  if (typeof unwrapped.extendedTextMessage?.text === 'string') return unwrapped.extendedTextMessage.text;
  if (typeof unwrapped.imageMessage?.caption === 'string') return unwrapped.imageMessage.caption;
  if (typeof unwrapped.videoMessage?.caption === 'string') return unwrapped.videoMessage.caption;
  if (typeof unwrapped.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return unwrapped.buttonsResponseMessage.selectedDisplayText;
  }
  if (typeof unwrapped.listResponseMessage?.title === 'string') {
    return unwrapped.listResponseMessage.title;
  }
  return '';
}

export function isCustomerMessageContent(message) {
  const unwrapped = unwrapMessageContent(message);
  if (!unwrapped) return false;
  const keys = Object.keys(unwrapped).filter((k) => !IGNORED_MESSAGE_KEYS.has(k));
  return keys.length > 0;
}

/**
 * Pure filter for incoming Baileys message objects (also unit-tested directly).
 */
export function evaluateIncomingEnvelope(msg, { ownPhone = '', nowEpochSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!msg || !msg.key) {
    return { valid: false, reason: 'missing_key' };
  }
  if (msg.key.fromMe) {
    return { valid: false, reason: 'from_me' };
  }
  if (msg.messageStubType) {
    return { valid: false, reason: 'stub_message' };
  }

  const remoteJid = msg.key.remoteJid || '';
  if (!remoteJid) {
    return { valid: false, reason: 'missing_jid' };
  }

  if (
    isJidGroup(remoteJid) ||
    isJidBroadcast(remoteJid) ||
    isJidStatusBroadcast(remoteJid) ||
    isJidNewsletter(remoteJid) ||
    isJidBot(remoteJid) ||
    isJidMetaAI(remoteJid) ||
    remoteJid.endsWith('@g.us') ||
    remoteJid === 'status@broadcast'
  ) {
    return { valid: false, reason: 'non_individual_chat' };
  }

  if (!isCustomerMessageContent(msg.message)) {
    return { valid: false, reason: 'protocol_or_empty' };
  }

  const tsRaw = msg.messageTimestamp;
  if (tsRaw !== undefined && tsRaw !== null) {
    const msgTs = typeof tsRaw === 'object' && typeof tsRaw.toNumber === 'function'
      ? tsRaw.toNumber()
      : Number(tsRaw);
    if (Number.isFinite(msgTs) && msgTs > 0 && (nowEpochSec - msgTs) > STALE_MESSAGE_SECONDS) {
      return { valid: false, reason: 'stale_message' };
    }
  }

  const candidateJid =
    remoteJid.endsWith('@lid') && msg.key.remoteJidAlt
      ? msg.key.remoteJidAlt
      : remoteJid;

  const phone = normalizePhone(candidateJid);
  if (!phone) {
    return { valid: false, reason: 'invalid_phone' };
  }

  if (ownPhone && phone === normalizePhone(ownPhone)) {
    return { valid: false, reason: 'own_number' };
  }

  return {
    valid: true,
    replyJid: remoteJid,
    phone,
    messageId: msg.key.id || '',
    messageText: extractTextFromMessage(msg.message),
  };
}

export class WhatsAppService {
  constructor() {
    this.sock = null;
    this.status = WHATSAPP_STATES.DISCONNECTED;
    this.qrDataUrl = null;
    this.connectedPhone = '';
    this.lastError = '';
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.presenceTimer = null;
    this.lastPresenceUpdateAt = 0;
    this.manualDisconnect = false;
    this.isConnecting = false;
    this.processedMessageIds = new Set();
    this.logger = pino({ level: config.whatsappLogLevel });
  }

  hasSavedSession() {
    const credsPath = `${config.authDir}/creds.json`;
    return fs.existsSync(credsPath);
  }

  getState() {
    const db = getDatabase();
    const lastConnectedAt = getSetting(db, 'ultima_conexao', '');
    const savedPhone = this.connectedPhone || getSetting(db, 'numero_conectado', '');

    return {
      status: this.status,
      connected: this.status === WHATSAPP_STATES.CONNECTED,
      connectedPhone: savedPhone,
      connectedPhoneFormatted: savedPhone ? formatPhoneDisplay(savedPhone) : '',
      lastConnectedAt,
      qrDataUrl: this.status === WHATSAPP_STATES.WAITING_QR ? this.qrDataUrl : null,
      lastError: this.lastError,
      hasSavedSession: this.hasSavedSession(),
      unofficialNotice:
        'Conexão não oficial via WhatsApp Web (Baileys). Sujeita a desconexões temporárias, necessidade de leitura de QR Code e políticas do WhatsApp.',
    };
  }

  emitStatus() {
    sseService.broadcast('whatsapp_status', this.getState());
  }

  setStatus(newStatus, extra = {}) {
    this.status = newStatus;
    if ('qrDataUrl' in extra) this.qrDataUrl = extra.qrDataUrl;
    if ('lastError' in extra) this.lastError = extra.lastError;
    if ('connectedPhone' in extra) this.connectedPhone = extra.connectedPhone;
    this.emitStatus();
  }

  rememberMessageId(id) {
    if (!id) return false;
    if (this.processedMessageIds.has(id)) return true;
    this.processedMessageIds.add(id);
    if (this.processedMessageIds.size > MAX_PROCESSED_IDS) {
      const oldest = this.processedMessageIds.values().next().value;
      this.processedMessageIds.delete(oldest);
    }
    return false;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  clearPresenceTimer() {
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  /**
   * Keeps the linked Baileys session in 'unavailable' (offline/passive) presence so
   * WhatsApp does not suppress push notifications or notification sounds on the phone.
   * Never marks incoming messages as read.
   */
  async keepOfflinePresence(sock = this.sock, { force = false } = {}) {
    if (!sock || this.sock !== sock) return false;
    if (this.status !== WHATSAPP_STATES.CONNECTED) return false;
    if (typeof sock.sendPresenceUpdate !== 'function') return false;

    const now = Date.now();
    if (!force && (now - this.lastPresenceUpdateAt) < PRESENCE_UPDATE_COOLDOWN_MS) {
      return false;
    }

    this.lastPresenceUpdateAt = now;
    try {
      await sock.sendPresenceUpdate('unavailable');
      return true;
    } catch {
      // Socket may be closing or profile name not yet synced; never disrupt message flow
      return false;
    }
  }

  scheduleOfflinePresence(sock = this.sock, delayMs = CREDS_UPDATE_PRESENCE_DELAY_MS) {
    if (!sock || this.sock !== sock) return;
    this.clearPresenceTimer();
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.keepOfflinePresence(sock, { force: true }).catch(() => {});
    }, delayMs);
  }

  async initOnStartup() {
    fs.mkdirSync(config.authDir, { recursive: true });
    if (this.hasSavedSession()) {
      await this.connect();
    } else {
      this.setStatus(WHATSAPP_STATES.DISCONNECTED, { qrDataUrl: null, lastError: '' });
    }
  }

  async connect() {
    if (this.isConnecting || this.status === WHATSAPP_STATES.CONNECTED) {
      return this.getState();
    }

    this.clearReconnectTimer();
    this.manualDisconnect = false;
    this.isConnecting = true;
    this.setStatus(
      this.reconnectAttempts > 0 ? WHATSAPP_STATES.RECONNECTING : WHATSAPP_STATES.CONNECTING,
      { lastError: '' }
    );

    try {
      fs.mkdirSync(config.authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

      let version;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch {
        version = undefined;
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        logger: this.logger,
        browser: ['Negao Lanches Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
      });

      this.sock = sock;

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          console.error('[WhatsApp] Falha ao salvar credenciais:', err?.message);
        }
        // Baileys may emit an implicit presence frame during partial creds updates;
        // re-assert 'unavailable' presence so the phone keeps emitting notification sounds.
        if (this.sock === sock && this.status === WHATSAPP_STATES.CONNECTED) {
          this.scheduleOfflinePresence(sock, CREDS_UPDATE_PRESENCE_DELAY_MS);
        }
      });

      sock.ev.on('connection.update', async (update) => {
        if (this.sock !== sock) return;
        await this.handleConnectionUpdate(update, sock);
      });

      sock.ev.on('messages.upsert', async (event) => {
        if (this.sock !== sock) return;
        await this.handleMessagesUpsert(event, sock);
      });
    } catch (err) {
      this.lastError = err?.message || 'Erro ao iniciar cliente WhatsApp.';
      this.setStatus(WHATSAPP_STATES.ERROR, { qrDataUrl: null, lastError: this.lastError });
    } finally {
      this.isConnecting = false;
    }

    return this.getState();
  }

  async handleConnectionUpdate(update, sock) {
    const { connection, lastDisconnect, qr, isOnline } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
        this.reconnectAttempts = 0;
        this.setStatus(WHATSAPP_STATES.WAITING_QR, { qrDataUrl, lastError: '' });
      } catch (err) {
        this.setStatus(WHATSAPP_STATES.ERROR, {
          qrDataUrl: null,
          lastError: `Erro ao gerar QR Code: ${err?.message}`,
        });
      }
    }

    if (connection === 'connecting') {
      if (this.status !== WHATSAPP_STATES.WAITING_QR) {
        this.setStatus(
          this.reconnectAttempts > 0 ? WHATSAPP_STATES.RECONNECTING : WHATSAPP_STATES.CONNECTING
        );
      }
    }

    if (connection === 'open') {
      this.clearReconnectTimer();
      this.reconnectAttempts = 0;

      const rawId = sock.user?.id || '';
      const normalizedJid = rawId ? jidNormalizedUser(rawId) : '';
      const phone = normalizePhone(normalizedJid);
      const now = getSaoPauloTimestamp();

      const db = getDatabase();
      setSetting(db, 'numero_conectado', phone);
      setSetting(db, 'ultima_conexao', now);

      this.setStatus(WHATSAPP_STATES.CONNECTED, {
        qrDataUrl: null,
        lastError: '',
        connectedPhone: phone,
      });

      // Enforce offline/passive presence immediately on connect and shortly after
      // initial sync so WhatsApp preserves native notification sounds on the phone.
      await this.keepOfflinePresence(sock, { force: true });
      this.scheduleOfflinePresence(sock, POST_CONNECT_PRESENCE_DELAY_MS);

      sseService.broadcast('dashboard_update', { reason: 'whatsapp_connected' });
      return;
    }

    if (connection === 'close') {
      this.clearPresenceTimer();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reasonMsg = lastDisconnect?.error?.message || '';
      this.sock = null;

      if (this.manualDisconnect) {
        this.setStatus(WHATSAPP_STATES.DISCONNECTED, {
          qrDataUrl: null,
          lastError: '',
        });
        return;
      }

      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      if (isLoggedOut) {
        this.clearAuthFolder();
        const db = getDatabase();
        setSetting(db, 'numero_conectado', '');
        this.reconnectAttempts = 0;
        this.setStatus(WHATSAPP_STATES.DISCONNECTED, {
          qrDataUrl: null,
          connectedPhone: '',
          lastError: 'Sessão desconectada no WhatsApp. Escaneie o QR Code novamente.',
        });
        return;
      }

      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts += 1;
        const delayMs = Math.min(3000 * (2 ** (this.reconnectAttempts - 1)), 30000);
        this.setStatus(WHATSAPP_STATES.RECONNECTING, {
          qrDataUrl: null,
          lastError: `Tentativa de reconexão ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} (${reasonMsg || 'conexão interrompida'})`,
        });
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err) => {
            console.error('[WhatsApp] Erro na reconexão:', err?.message);
          });
        }, delayMs);
      } else {
        this.setStatus(WHATSAPP_STATES.ERROR, {
          qrDataUrl: null,
          lastError: `Não foi possível reconectar após ${MAX_RECONNECT_ATTEMPTS} tentativas. Clique em Conectar WhatsApp.`,
        });
      }
      return;
    }

    if (isOnline === true && this.status === WHATSAPP_STATES.CONNECTED) {
      this.scheduleOfflinePresence(sock, 300);
    }
  }

  async handleMessagesUpsert(event, sock) {
    if (!event || event.type !== 'notify' || !Array.isArray(event.messages)) {
      return;
    }

    const ownPhone = this.connectedPhone || normalizePhone(sock.user?.id || '');

    for (const msg of event.messages) {
      try {
        if (msg?.key?.id && this.rememberMessageId(msg.key.id)) {
          continue;
        }

        // Resolve LID -> PN if Baileys lidMapping is available and remoteJidAlt wasn't provided
        if (msg?.key?.remoteJid?.endsWith('@lid') && !msg.key.remoteJidAlt) {
          try {
            const mappedPn = await sock.signalRepository?.lidMapping?.getPNForLID(msg.key.remoteJid);
            if (mappedPn) {
              msg.key.remoteJidAlt = mappedPn;
            }
          } catch {
            // Fall back to remoteJid if mapping is unavailable
          }
        }

        const evaluated = evaluateIncomingEnvelope(msg, { ownPhone });
        if (!evaluated.valid) {
          continue;
        }

        const result = await processIncomingMessage({
          phone: evaluated.phone,
          messageText: evaluated.messageText,
          sendFn: async (text) => {
            if (!this.sock || this.status !== WHATSAPP_STATES.CONNECTED) {
              throw new Error('WhatsApp não está conectado no momento do envio.');
            }
            await this.sock.sendMessage(evaluated.replyJid, { text });
            // Re-assert unavailable presence after sending an automated reply without
            // ever marking incoming messages as read.
            await this.keepOfflinePresence(this.sock, { force: true });
          },
        });

        sseService.broadcast('dashboard_update', {
          reason: 'message_processed',
          result,
        });
      } catch (err) {
        console.error('[WhatsApp] Erro ao processar mensagem recebida:', err?.message);
      }
    }
  }

  clearAuthFolder() {
    try {
      if (fs.existsSync(config.authDir)) {
        fs.rmSync(config.authDir, { recursive: true, force: true });
      }
      fs.mkdirSync(config.authDir, { recursive: true });
    } catch (err) {
      console.error('[WhatsApp] Erro ao limpar pasta de sessão:', err?.message);
    }
  }

  async disconnect({ logout = false } = {}) {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.clearPresenceTimer();
    this.reconnectAttempts = 0;

    const currentSock = this.sock;
    this.sock = null;

    if (currentSock) {
      try {
        if (logout) {
          await currentSock.logout();
        } else {
          currentSock.end(undefined);
        }
      } catch {
        // Socket may already be closed
      }
    }

    if (logout) {
      this.clearAuthFolder();
      setSetting(getDatabase(), 'numero_conectado', '');
      this.setStatus(WHATSAPP_STATES.DISCONNECTED, {
        qrDataUrl: null,
        connectedPhone: '',
        lastError: '',
      });
    } else {
      this.setStatus(WHATSAPP_STATES.DISCONNECTED, {
        qrDataUrl: null,
        lastError: '',
      });
    }

    return this.getState();
  }

  async shutdown() {
    await this.disconnect({ logout: false });
  }
}

export const whatsappService = new WhatsAppService();
