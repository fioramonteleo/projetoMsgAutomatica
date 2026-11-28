import { createApp } from './src/app.js';
import { config } from './src/config/env.js';
import { closeDatabase, initDatabase } from './src/database/db.js';
import { sseService } from './src/services/sseService.js';
import { getReferenceDate, getWindowStatusInfo } from './src/services/timeService.js';
import { whatsappService } from './src/services/whatsappService.js';

let server = null;
let scheduleTicker = null;
let lastKnownDate = getReferenceDate();
let lastWindowOpen = null;

function startTimeMonitor() {
  // Checks every 15s for midnight rollover or 17:00 / 00:00 window boundary transitions
  // in America/Sao_Paulo so the dashboard and daily stats refresh automatically without restart.
  scheduleTicker = setInterval(() => {
    const currentDate = getReferenceDate();
    const info = getWindowStatusInfo(config.defaultWindowStart, config.defaultWindowEnd);

    if (currentDate !== lastKnownDate) {
      lastKnownDate = currentDate;
      console.log(`[Horário] Virada de meia-noite detectada (${currentDate} America/Sao_Paulo). Ciclo diário renovado.`);
      sseService.broadcast('dashboard_update', { reason: 'midnight_rollover', date: currentDate });
    } else if (lastWindowOpen !== null && lastWindowOpen !== info.isOpen) {
      sseService.broadcast('dashboard_update', { reason: 'window_transition', isOpen: info.isOpen });
    }

    lastWindowOpen = info.isOpen;
  }, 15000);
}

async function start() {
  console.log('==================================================');
  console.log('   NEGÃO LANCHES — BOT WHATSAPP (RESPOSTA AUTO)   ');
  console.log('==================================================');

  // 1 & 2. Verify SQLite database & restore settings/campaigns
  initDatabase();
  console.log(`[Banco] SQLite pronto em: ${config.dbPath}`);

  // 3, 4 & 5. Restore WhatsApp session and start incoming message listener
  whatsappService.initOnStartup().catch((err) => {
    console.error('[WhatsApp] Erro ao restaurar sessão inicial:', err?.message);
  });

  // 6. Start automatic America/Sao_Paulo time monitor
  startTimeMonitor();

  const app = createApp();
  server = app.listen(config.port, config.host, () => {
    console.log(`[Servidor] Painel disponível em: http://localhost:${config.port}`);
    console.log(`[Fuso Horário] ${config.timezone} | Janela padrão: ${config.defaultWindowStart} às ${config.defaultWindowEnd}`);
  });
}

async function gracefulShutdown(signal) {
  console.log(`\n[Sistema] Recebido ${signal}. Encerrando com segurança...`);
  if (scheduleTicker) {
    clearInterval(scheduleTicker);
    scheduleTicker = null;
  }
  await whatsappService.shutdown();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  closeDatabase();
  console.log('[Sistema] Encerrado com segurança.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start().catch((err) => {
  console.error('[Sistema] Falha fatal na inicialização:', err);
  process.exit(1);
});
