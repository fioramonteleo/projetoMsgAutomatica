import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config, DEFAULT_CAMPAIGN_MESSAGE, HISTORY_STATUS, WHATSAPP_STATES } from '../src/config/env.js';
import { closeDatabase, initDatabase } from '../src/database/db.js';
import { activateCampaign, createCampaign, getActiveCampaign, listCampaigns } from '../src/services/campaignService.js';
import { getDashboardStats, getHistory, processIncomingMessage, setBotEnabled } from '../src/services/replyService.js';
import { getReferenceDate, isWithinAllowedWindow } from '../src/services/timeService.js';
import { evaluateIncomingEnvelope, WhatsAppService } from '../src/services/whatsappService.js';

function spDate(isoWithoutOffset) {
  return new Date(`${isoWithoutOffset}-03:00`);
}

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'negao-lanches-test-'));
  return { dir, dbPath: path.join(dir, 'test.db') };
}

test('Fluxo diário completo, horários America/Sao_Paulo e virada de meia-noite (Testes 1 a 9)', async () => {
  const { dir, dbPath } = createTempDbPath();
  const db = initDatabase(dbPath);
  let sentCount = 0;
  const sentPayloads = [];

  const sendFn = async (msg) => {
    sentCount += 1;
    sentPayloads.push(msg);
  };

  try {
    const clientA = '5511988881111';
    const clientB = '5511977772222';

    // Teste 8: Mensagem recebida às 16h não gera resposta
    const r16h = await processIncomingMessage({
      phone: clientA,
      messageText: 'Oi, tem lanche hoje?',
      sendFn,
      db,
      now: spDate('2026-11-26T16:00:00'),
    });
    assert.equal(r16h.action, 'ignored');
    assert.equal(r16h.reason, 'out_of_hours');
    assert.equal(sentCount, 0);

    // Teste 1: Mesmo cliente envia mensagem às 18h e recebe resposta normalmente
    const r18h = await processIncomingMessage({
      phone: clientA,
      messageText: 'Boa noite!',
      sendFn,
      db,
      now: spDate('2026-11-26T18:00:00'),
    });
    assert.equal(r18h.action, 'responded');
    assert.equal(sentCount, 1);
    assert.equal(sentPayloads[0], DEFAULT_CAMPAIGN_MESSAGE);

    // Teste 2: Mesmo cliente envia outra mensagem às 19h e não recebe resposta
    const r19h = await processIncomingMessage({
      phone: clientA,
      messageText: 'Ainda estão abertos?',
      sendFn,
      db,
      now: spDate('2026-11-26T19:00:00'),
    });
    assert.equal(r19h.action, 'ignored');
    assert.equal(r19h.reason, 'daily_limit');
    assert.equal(sentCount, 1);

    // Teste 3: Mesmo cliente envia mensagem às 23h e não recebe resposta
    const r23h = await processIncomingMessage({
      phone: clientA,
      messageText: 'Alô?',
      sendFn,
      db,
      now: spDate('2026-11-26T23:00:00'),
    });
    assert.equal(r23h.action, 'ignored');
    assert.equal(r23h.reason, 'daily_limit');
    assert.equal(sentCount, 1);

    // Teste 7: Outro cliente envia mensagem às 18h e recebe resposta normalmente
    const rClientB = await processIncomingMessage({
      phone: clientB,
      messageText: 'Quero fazer um pedido',
      sendFn,
      db,
      now: spDate('2026-11-26T18:30:00'),
    });
    assert.equal(rClientB.action, 'responded');
    assert.equal(sentCount, 2);

    // Teste 4 & 9: O relógio vira meia-noite (00:00 / 00:01) — data muda e janela fecha imediatamente
    assert.equal(getReferenceDate(spDate('2026-11-27T00:00:00')), '2026-11-27');
    assert.equal(isWithinAllowedWindow('17:00', '00:00', spDate('2026-11-27T00:00:00')), false);

    const r00h01 = await processIncomingMessage({
      phone: clientA,
      messageText: 'Oi de madrugada',
      sendFn,
      db,
      now: spDate('2026-11-27T00:01:00'),
    });
    assert.equal(r00h01.action, 'ignored');
    assert.equal(r00h01.reason, 'out_of_hours');
    assert.equal(sentCount, 2);

    // Teste 5: Mesmo cliente envia mensagem às 10h do dia seguinte e não recebe resposta
    const rNext10h = await processIncomingMessage({
      phone: clientA,
      messageText: 'Bom dia!',
      sendFn,
      db,
      now: spDate('2026-11-27T10:00:00'),
    });
    assert.equal(rNext10h.action, 'ignored');
    assert.equal(rNext10h.reason, 'out_of_hours');
    assert.equal(sentCount, 2);

    // Teste 6: Mesmo cliente envia mensagem às 18h do dia seguinte e recebe novamente
    const rNext18h = await processIncomingMessage({
      phone: clientA,
      messageText: 'Boa noite de novo!',
      sendFn,
      db,
      now: spDate('2026-11-27T18:00:00'),
    });
    assert.equal(rNext18h.action, 'responded');
    assert.equal(sentCount, 3);

    // Verifica histórico e estatísticas do dia seguinte
    const statsDay2 = getDashboardStats(db, spDate('2026-11-27T19:00:00'));
    assert.equal(statsDay2.totalRespostasHoje, 1);
    assert.equal(statsDay2.totalNumerosRespondidosHoje, 1);
    assert.equal(statsDay2.totalIgnoradasLimiteDiario, 2);
    assert.equal(statsDay2.totalIgnoradasHorario, 3);

    const historyResponded = getHistory({ status: HISTORY_STATUS.RESPONDED }, db);
    assert.equal(historyResponded.length, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Persistência após reiniciar Node.js e reconectar WhatsApp (Testes 10 e 11)', async () => {
  const { dir, dbPath } = createTempDbPath();
  let sentCount = 0;
  const sendFn = async () => {
    sentCount += 1;
  };

  try {
    // Sessão 1 antes de reiniciar
    const db1 = initDatabase(dbPath);
    const first = await processIncomingMessage({
      phone: '5511966663333',
      messageText: 'Oi',
      sendFn,
      db: db1,
      now: spDate('2026-11-26T18:10:00'),
    });
    assert.equal(first.action, 'responded');
    assert.equal(sentCount, 1);
    db1.close();

    // Simula reinício do Node.js / reconexão do WhatsApp reabrindo o mesmo arquivo SQLite
    const db2 = initDatabase(dbPath);
    const afterRestart = await processIncomingMessage({
      phone: '5511966663333',
      messageText: 'Oi de novo após reinício',
      sendFn,
      db: db2,
      now: spDate('2026-11-26T20:15:00'),
    });
    assert.equal(afterRestart.action, 'ignored');
    assert.equal(afterRestart.reason, 'daily_limit');
    assert.equal(sentCount, 1);

    // Mensagem antiga entregue na reconexão (> 180s) é descartada no envelope
    const staleEnvelope = evaluateIncomingEnvelope(
      {
        key: { id: 'MSG-OLD-1', remoteJid: '5511955554444@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Mensagem atrasada durante desconexão' },
        messageTimestamp: 1000,
      },
      { nowEpochSec: 2000 }
    );
    assert.equal(staleEnvelope.valid, false);
    assert.equal(staleEnvelope.reason, 'stale_message');

    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Desativar bot, criar nova campanha e manter integridade (Testes 12 e 13)', async () => {
  const { dir, dbPath } = createTempDbPath();
  const db = initDatabase(dbPath);
  let lastMessage = '';
  let sentCount = 0;

  const sendFn = async (msg) => {
    sentCount += 1;
    lastMessage = msg;
  };

  try {
    const phone = '5511944445555';

    // Responde na campanha inicial
    const res1 = await processIncomingMessage({
      phone,
      messageText: 'Olá',
      sendFn,
      db,
      now: spDate('2026-11-26T18:00:00'),
    });
    assert.equal(res1.action, 'responded');
    assert.equal(sentCount, 1);

    // Teste 12: Desativar bot impede novos envios
    setBotEnabled(false, db);
    const resDisabled = await processIncomingMessage({
      phone: '5511933334444',
      messageText: 'Olá',
      sendFn,
      db,
      now: spDate('2026-11-26T18:05:00'),
    });
    assert.equal(resDisabled.action, 'ignored');
    assert.equal(resDisabled.reason, 'bot_disabled');
    assert.equal(sentCount, 1);

    // Reativa bot e cria nova campanha (mantendo integridade da anterior)
    setBotEnabled(true, db);
    const newCamp = createCampaign(
      {
        nome: 'Aviso Feriado Especial',
        mensagem: 'Voltaremos amanhã às 18h!',
        horario_inicio: '17:00',
        horario_fim: '00:00',
        ativar: true,
      },
      db
    );
    assert.equal(newCamp.status, 'ATIVA');
    assert.equal(getActiveCampaign(db).id, newCamp.id);

    // Teste 13: Nova campanha tem controle independente, mas limita a 1 por dia dentro dela
    const resNewCamp1 = await processIncomingMessage({
      phone,
      messageText: 'Novo contato',
      sendFn,
      db,
      now: spDate('2026-11-26T18:20:00'),
    });
    assert.equal(resNewCamp1.action, 'responded');
    assert.equal(sentCount, 2);
    assert.equal(lastMessage, 'Voltaremos amanhã às 18h!');

    const resNewCamp2 = await processIncomingMessage({
      phone,
      messageText: 'Segunda msg na mesma campanha',
      sendFn,
      db,
      now: spDate('2026-11-26T19:20:00'),
    });
    assert.equal(resNewCamp2.action, 'ignored');
    assert.equal(resNewCamp2.reason, 'daily_limit');
    assert.equal(sentCount, 2);

    // Integridade dos registros da primeira campanha preservada
    const allCampaigns = listCampaigns(db);
    assert.equal(allCampaigns.length, 2);
    const initialCamp = allCampaigns.find((c) => c.id !== newCamp.id);
    assert.equal(initialCamp.status, 'INATIVA');
    assert.equal(initialCamp.total_numeros_respondidos, 1);

    // Reativar a primeira campanha desativa a segunda automaticamente
    activateCampaign(initialCamp.id, db);
    assert.equal(getActiveCampaign(db).id, initialCamp.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Ignorar grupos, próprias mensagens, status e mensagens de protocolo (Testes 14 e 15)', () => {
  const nowEpochSec = Math.floor(Date.now() / 1000);

  // Teste 14: Mensagens de grupos são ignoradas
  const groupMsg = evaluateIncomingEnvelope(
    {
      key: { id: 'G1', remoteJid: '1203630123456789@g.us', fromMe: false },
      message: { conversation: 'Oi grupo' },
      messageTimestamp: nowEpochSec,
    },
    { ownPhone: '5511999990000', nowEpochSec }
  );
  assert.equal(groupMsg.valid, false);
  assert.equal(groupMsg.reason, 'non_individual_chat');

  // Teste 15: Mensagens enviadas pelo próprio número são ignoradas
  const selfFromMe = evaluateIncomingEnvelope(
    {
      key: { id: 'S1', remoteJid: '5511988881111@s.whatsapp.net', fromMe: true },
      message: { conversation: 'Resposta manual do atendente' },
      messageTimestamp: nowEpochSec,
    },
    { ownPhone: '5511999990000', nowEpochSec }
  );
  assert.equal(selfFromMe.valid, false);
  assert.equal(selfFromMe.reason, 'from_me');

  const selfSameNumber = evaluateIncomingEnvelope(
    {
      key: { id: 'S2', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Outro dispositivo da mesma conta' },
      messageTimestamp: nowEpochSec,
    },
    { ownPhone: '5511999990000', nowEpochSec }
  );
  assert.equal(selfSameNumber.valid, false);
  assert.equal(selfSameNumber.reason, 'own_number');

  // Status/Broadcast e protocolo ignorados
  const statusMsg = evaluateIncomingEnvelope(
    {
      key: { id: 'ST1', remoteJid: 'status@broadcast', fromMe: false },
      message: { conversation: 'Status' },
      messageTimestamp: nowEpochSec,
    },
    { ownPhone: '5511999990000', nowEpochSec }
  );
  assert.equal(statusMsg.valid, false);

  const protocolMsg = evaluateIncomingEnvelope(
    {
      key: { id: 'PR1', remoteJid: '5511988881111@s.whatsapp.net', fromMe: false },
      message: { protocolMessage: { type: 0 } },
      messageTimestamp: nowEpochSec,
    },
    { ownPhone: '5511999990000', nowEpochSec }
  );
  assert.equal(protocolMsg.valid, false);

  // Mensagem individual válida usando @lid com remoteJidAlt
  const lidValid = evaluateIncomingEnvelope(
    {
      key: {
        id: 'OK1',
        remoteJid: '12345678901234@lid',
        remoteJidAlt: '5511912345678@s.whatsapp.net',
        fromMe: false,
      },
      message: { extendedTextMessage: { text: 'Boa noite!' } },
      messageTimestamp: nowEpochSec,
    },
    { ownPhone: '5511999990000', nowEpochSec }
  );
  assert.equal(lidValid.valid, true);
  assert.equal(lidValid.phone, '5511912345678');
  assert.equal(lidValid.replyJid, '12345678901234@lid');
});

test('Concorrência simultânea, falha de envio e proteção de opt-out', async () => {
  const { dir, dbPath } = createTempDbPath();
  const db = initDatabase(dbPath);
  let sentCount = 0;

  try {
    // Duas mensagens simultâneas do mesmo número -> apenas 1 envio permitido atomicamente
    const slowSend = async () => {
      await new Promise((r) => setTimeout(r, 30));
      sentCount += 1;
    };

    const [c1, c2] = await Promise.all([
      processIncomingMessage({
        phone: '5511911110000',
        messageText: 'Msg 1',
        sendFn: slowSend,
        db,
        now: spDate('2026-11-26T18:00:00'),
      }),
      processIncomingMessage({
        phone: '5511911110000',
        messageText: 'Msg 2',
        sendFn: slowSend,
        db,
        now: spDate('2026-11-26T18:00:00'),
      }),
    ]);

    assert.equal(sentCount, 1);
    const actions = [c1.action, c2.action].sort();
    assert.deepEqual(actions, ['ignored', 'responded']);

    // Opt-out: contato pede para sair e não recebe mais respostas
    const optOutRes = await processIncomingMessage({
      phone: '5511922220000',
      messageText: 'SAIR',
      sendFn: async () => {
        sentCount += 1;
      },
      db,
      now: spDate('2026-11-26T18:10:00'),
    });
    assert.equal(optOutRes.action, 'ignored');
    assert.equal(optOutRes.reason, 'opt_out_requested');
    assert.equal(sentCount, 1);

    const afterOptOut = await processIncomingMessage({
      phone: '5511922220000',
      messageText: 'Oi novamente',
      sendFn: async () => {
        sentCount += 1;
      },
      db,
      now: spDate('2026-11-26T18:15:00'),
    });
    assert.equal(afterOptOut.action, 'ignored');
    assert.equal(afterOptOut.reason, 'opt_out');
    assert.equal(sentCount, 1);

    // Erro de envio é registrado e bloqueia duplicidade controlada no mesmo dia
    const errRes = await processIncomingMessage({
      phone: '5511933330000',
      messageText: 'Oi',
      sendFn: async () => {
        throw new Error('Falha de rede simulada');
      },
      db,
      now: spDate('2026-11-26T18:20:00'),
    });
    assert.equal(errRes.action, 'error');

    const retrySameDay = await processIncomingMessage({
      phone: '5511933330000',
      messageText: 'Oi de novo',
      sendFn: async () => {
        sentCount += 1;
      },
      db,
      now: spDate('2026-11-26T18:25:00'),
    });
    assert.equal(retrySameDay.action, 'ignored');
    assert.equal(retrySameDay.reason, 'previous_error_locked');
    assert.equal(sentCount, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Preserva notificações do celular (presença unavailable e sem marcar mensagens como lidas)', async () => {
  const { dir, dbPath } = createTempDbPath();
  const previousDbPath = config.dbPath;
  config.dbPath = dbPath;
  closeDatabase();
  const db = initDatabase(dbPath);

  const service = new WhatsAppService();
  const presenceCalls = [];
  const readCalls = [];
  const sentMessages = [];

  const createMockSocket = () => ({
    user: { id: '5511999990000:1@s.whatsapp.net' },
    sendPresenceUpdate: async (type) => {
      presenceCalls.push(type);
    },
    readMessages: async (keys) => {
      readCalls.push(keys);
    },
    sendReceipt: async (...args) => {
      readCalls.push(args);
    },
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
    },
    end: () => {},
  });

  try {
    // 1. Conexão inicial deve enviar presença 'unavailable'
    const sock1 = createMockSocket();
    service.sock = sock1;
    await service.handleConnectionUpdate({ connection: 'open' }, sock1);

    assert.equal(service.status, WHATSAPP_STATES.CONNECTED);
    assert.deepEqual(presenceCalls, ['unavailable']);
    assert.equal(readCalls.length, 0);

    // 2. Se um evento indicar isOnline=true, agenda retorno imediato para 'unavailable'
    await service.handleConnectionUpdate({ isOnline: true }, sock1);
    assert.ok(service.presenceTimer !== null);
    service.clearPresenceTimer();

    // 3. Mensagem recebida nunca chama readMessages/sendReceipt
    const nowEpochSec = Math.floor(Date.now() / 1000);
    await service.handleMessagesUpsert(
      {
        type: 'notify',
        messages: [
          {
            key: {
              id: 'MSG-NOTIF-1',
              remoteJid: '5511988881111@s.whatsapp.net',
              fromMe: false,
            },
            message: { conversation: 'Oi, boa noite!' },
            messageTimestamp: nowEpochSec,
          },
        ],
      },
      sock1
    );
    assert.equal(readCalls.length, 0);

    // Se houve envio automático (dentro da janela), presença deve ser reafirmada como 'unavailable'
    if (sentMessages.length > 0) {
      assert.equal(presenceCalls.at(-1), 'unavailable');
    }

    // 4. Após desconectar e reconectar, timers são limpos e a nova conexão reafirma 'unavailable'
    await service.disconnect({ logout: false });
    assert.equal(service.presenceTimer, null);
    assert.equal(service.status, WHATSAPP_STATES.DISCONNECTED);

    const beforeReconnectCount = presenceCalls.length;
    const sock2 = createMockSocket();
    service.sock = sock2;
    await service.handleConnectionUpdate({ connection: 'open' }, sock2);

    assert.equal(service.status, WHATSAPP_STATES.CONNECTED);
    assert.equal(presenceCalls.length, beforeReconnectCount + 1);
    assert.equal(presenceCalls.at(-1), 'unavailable');
    assert.equal(readCalls.length, 0);
  } finally {
    service.clearPresenceTimer();
    service.clearReconnectTimer();
    closeDatabase();
    config.dbPath = previousDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
