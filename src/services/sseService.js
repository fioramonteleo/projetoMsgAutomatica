/**
 * Lightweight Server-Sent Events (SSE) broadcaster so the local web panel
 * updates connection state, QR code, stats, and events in real time.
 */
class SseService {
  constructor() {
    this.clients = new Set();
  }

  addClient(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    this.clients.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.removeClient(res);
      }
    }, 25000);

    res.on('close', () => {
      clearInterval(keepAlive);
      this.removeClient(res);
    });
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  broadcast(event, payload) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const sseService = new SseService();
