import { WebSocket, WebSocketServer } from 'ws';
import { validId } from './store.mjs';

/** Keep OCR progress subscriptions scoped to an existing session and the same host. */
export function createProgress(server, store) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const channels = new Map();

  server.on('upgrade', async (request, socket, head) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const match = path.match(/^\/api\/sessions\/([^/]+)\/stream$/);
      if (!match || !validId(match[1])) {
        throw new Error('Invalid session');
      }

      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        throw new Error('Invalid origin');
      }

      const sessionId = match[1];
      await store.get(sessionId);
      sockets.handleUpgrade(request, socket, head, (client) => {
        if (!channels.has(sessionId)) {
          channels.set(sessionId, new Set());
        }
        channels.get(sessionId).add(client);

        client.on('error', () => client.close());
        client.on('close', () => {
          const subscribers = channels.get(sessionId);
          subscribers?.delete(client);
          if (!subscribers?.size) {
            channels.delete(sessionId);
          }
        });
      });
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });

  function broadcast(sessionId, event) {
    for (const client of channels.get(sessionId) || []) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
      }
    }
  }

  function close() {
    for (const client of sockets.clients) {
      client.close();
    }
  }

  return { broadcast, close };
}
