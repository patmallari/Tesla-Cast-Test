// signaling.js
// WebRTC signaling relay. This server never touches media - it only relays
// small JSON control messages (offer/answer/ICE candidates) between exactly
// two paired sockets. The actual audio/video goes peer-to-peer over WebRTC
// (or via TURN relay if configured and NAT requires it), not through here.

const { WebSocketServer } = require('ws');
const { PairingStore } = require('./pairing');

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

function attachSignaling(server, { path = '/ws' } = {}) {
  const wss = new WebSocketServer({ server, path });
  const store = new PairingStore();

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.role = null;   // 'receiver' | 'sender'
    ws.session = null; // reference to the paired Session object

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return safeSend(ws, { type: 'error', message: 'Malformed message' });
      }

      switch (msg.type) {
        // ---- Tesla receiver asks for a fresh pairing code ----
        case 'register-receiver': {
          const session = store.createSession(ws);
          ws.role = 'receiver';
          ws.session = session;
          safeSend(ws, {
            type: 'code-assigned',
            code: session.code,
            token: session.token,
          });
          break;
        }

        // ---- iPhone sender enters the code shown on the Tesla screen ----
        case 'register-sender': {
          const session = store.getByCode(msg.code);
          if (!session) {
            return safeSend(ws, { type: 'pair-error', reason: 'invalid_or_expired_code' });
          }
          if (session.state !== 'waiting') {
            return safeSend(ws, { type: 'pair-error', reason: 'already_paired' });
          }
          session.senderWs = ws;
          session.state = 'paired';
          store.touch(session);
          ws.role = 'sender';
          ws.session = session;

          safeSend(ws, { type: 'pair-success', code: session.code });
          safeSend(session.receiverWs, { type: 'sender-joined' });
          break;
        }

        // ---- WebRTC signaling relay (offer / answer / ice-candidate) ----
        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          const session = ws.session;
          if (!session) return;
          store.touch(session);
          const target = ws.role === 'sender' ? session.receiverWs : session.senderWs;
          safeSend(target, { ...msg, from: ws.role });
          if (msg.type === 'offer') session.state = 'connecting';
          break;
        }

        // ---- Either side reports the media connection is fully up ----
        case 'connected': {
          const session = ws.session;
          if (!session) return;
          session.state = 'connected';
          store.touch(session);
          const other = ws.role === 'sender' ? session.receiverWs : session.senderWs;
          safeSend(other, { type: 'peer-connected' });
          break;
        }

        // ---- Stats relay for the receiver's on-screen readout ----
        case 'stats': {
          const session = ws.session;
          if (!session || ws.role !== 'sender') return;
          safeSend(session.receiverWs, { type: 'stats', stats: msg.stats });
          break;
        }

        // ---- Explicit disconnect from either side ----
        case 'disconnect': {
          endSession(ws.session, store);
          break;
        }

        default:
          safeSend(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      endSession(ws.session, store);
    });

    ws.on('error', () => {
      endSession(ws.session, store);
    });
  });

  function endSession(session, store) {
    if (!session) return;
    safeSend(session.receiverWs, { type: 'peer-disconnected' });
    safeSend(session.senderWs, { type: 'peer-disconnected' });
    store.destroy(session);
  }

  // Heartbeat to drop dead sockets (Tesla / mobile networks can drop silently).
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        endSession(ws.session, store);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 20000);
  interval.unref?.();

  wss.on('close', () => clearInterval(interval));

  return { wss, store };
}

module.exports = { attachSignaling };
