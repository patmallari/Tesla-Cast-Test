require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { attachSignaling } = require('./signaling');

const PORT = process.env.PORT || 3000;
// PUBLIC_URL is optional. If it's not set (the out-of-the-box default), the
// server figures out the right base URL from each incoming request instead
// (using the Host header, and X-Forwarded-Proto if you're behind a reverse
// proxy/load balancer). That means the QR code and sender link work
// correctly on localhost, on a bare IP, or on a real domain without editing
// any config file. Set PUBLIC_URL explicitly only if you want to force a
// specific external URL (e.g. a domain that differs from what the proxy
// reports).
const PUBLIC_URL_OVERRIDE = process.env.PUBLIC_URL || '';
const STUN_SERVER = process.env.STUN_SERVER || 'stun:stun.l.google.com:19302';
const TURN_SERVER = process.env.TURN_SERVER || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';

const app = express();

// Basic hardening / hygiene
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

function resolveBaseUrl(req) {
  if (PUBLIC_URL_OVERRIDE) return PUBLIC_URL_OVERRIDE.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// ICE server config handed to both sender and receiver at runtime, so
// STUN/TURN can be changed via environment variables without touching code.
app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: STUN_SERVER }];
  if (TURN_SERVER) {
    iceServers.push({
      urls: TURN_SERVER,
      username: TURN_USERNAME || undefined,
      credential: TURN_PASSWORD || undefined,
    });
  }
  res.json({ iceServers });
});

// Server-rendered QR code for a given sender URL, shown on the Tesla screen.
// Generating it server-side means the receiver page needs zero extra
// client-side QR library.
app.get('/api/qr', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!/^\d{4}$/.test(code)) {
    return res.status(400).json({ error: 'invalid code' });
  }
  const senderUrl = `${resolveBaseUrl(req)}/send?code=${code}`;
  try {
    const dataUrl = await QRCode.toDataURL(senderUrl, {
      margin: 1,
      width: 220,
      color: { dark: '#111111', light: '#ffffff' },
    });
    res.json({ dataUrl, senderUrl });
  } catch (err) {
    res.status(500).json({ error: 'qr generation failed' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);
const { store } = attachSignaling(server, { path: '/ws' });

// Lightweight live counters for the diagnostics page.
app.get('/api/stats', (req, res) => {
  res.json({
    activeSessions: store.byCode.size,
  });
});

server.listen(PORT, () => {
  const shown = PUBLIC_URL_OVERRIDE || `http://localhost:${PORT}`;
  console.log(`Tesla-cast server listening on port ${PORT}`);
  console.log(`  Receiver:    ${shown}/receiver`);
  console.log(`  Sender:      ${shown}/send`);
  console.log(`  Diagnostics: ${shown}/diagnostics`);
  console.log(`  STUN:        ${STUN_SERVER}`);
  console.log(`  TURN:        ${TURN_SERVER || '(none configured)'}`);
  if (!PUBLIC_URL_OVERRIDE) {
    console.log('  PUBLIC_URL not set — auto-detecting the base URL from each request (works fine for most setups).');
  }
  console.log('\nOpen the Receiver URL above in the Tesla browser, and the Sender URL on your phone.');
});
