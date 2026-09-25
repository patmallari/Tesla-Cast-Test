// pairing.js
// In-memory pairing session store.
//
// A "session" is created when a Tesla receiver page connects and asks for a
// code. It is identified by a short numeric code (shown on the Tesla screen
// and typed on the iPhone) plus a longer random token (used internally so a
// guessed 4-digit code alone can't hijack an already-paired session).
//
// Sessions expire if nobody pairs within CODE_TTL_MS, and are destroyed on
// disconnect. Nothing here is persisted to disk.

const crypto = require('crypto');

const CODE_TTL_MS = 5 * 60 * 1000;       // pairing code valid for 5 min if unpaired
const PAIRED_IDLE_TTL_MS = 30 * 60 * 1000; // paired session reaped after 30 min idle (safety net)

class PairingStore {
  constructor() {
    /** @type {Map<string, Session>} */
    this.byCode = new Map();
    this._reapTimer = setInterval(() => this._reap(), 15 * 1000);
    this._reapTimer.unref?.();
  }

  _generateCode() {
    // 4-digit numeric code, avoid leading zero for readability, avoid collisions.
    let code;
    let attempts = 0;
    do {
      code = String(1000 + crypto.randomInt(0, 9000));
      attempts++;
    } while (this.byCode.has(code) && attempts < 50);
    return code;
  }

  createSession(receiverWs) {
    const code = this._generateCode();
    const token = crypto.randomBytes(16).toString('hex');
    const session = {
      code,
      token,
      receiverWs,
      senderWs: null,
      state: 'waiting', // waiting -> paired -> connected -> closed
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.byCode.set(code, session);
    return session;
  }

  getByCode(code) {
    return this.byCode.get(code) || null;
  }

  touch(session) {
    session.lastActivity = Date.now();
  }

  destroy(session) {
    if (!session) return;
    this.byCode.delete(session.code);
  }

  _reap() {
    const now = Date.now();
    for (const [code, session] of this.byCode.entries()) {
      const isUnpaired = session.state === 'waiting';
      const ttl = isUnpaired ? CODE_TTL_MS : PAIRED_IDLE_TTL_MS;
      if (now - session.lastActivity > ttl) {
        try {
          session.receiverWs?.readyState === 1 &&
            session.receiverWs.send(JSON.stringify({ type: 'code-expired' }));
          session.senderWs?.readyState === 1 &&
            session.senderWs.send(JSON.stringify({ type: 'session-expired' }));
        } catch (_) {
          /* socket already gone */
        }
        this.byCode.delete(code);
      }
    }
  }
}

module.exports = { PairingStore, CODE_TTL_MS };
