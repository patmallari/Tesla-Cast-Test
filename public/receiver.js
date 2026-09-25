(() => {
  'use strict';

  const els = {
    waitingView: document.getElementById('waitingView'),
    videoStage: document.getElementById('videoStage'),
    statusText: document.getElementById('statusText'),
    codeDisplay: document.getElementById('codeDisplay'),
    qrBox: document.getElementById('qrBox'),
    qrImg: document.getElementById('qrImg'),
    statusDot: document.getElementById('statusDot'),
    statusLine: document.getElementById('statusLine'),
    errorBox: document.getElementById('errorBox'),
    senderUrlText: document.getElementById('senderUrlText'),
    remoteVideo: document.getElementById('remoteVideo'),
    hudInfo: document.getElementById('hudInfo'),
    disconnectBtn: document.getElementById('disconnectBtn'),
  };

  let ws = null;
  let pc = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let currentCode = null;
  let reconnectDelay = 1000;
  let statsTimer = null;
  let lastBytes = 0;
  let lastStatsTime = 0;

  function setStatus(text, dotClass) {
    els.statusLine.textContent = text;
    els.statusDot.className = `dot ${dotClass}`;
  }

  function showError(msg) {
    els.errorBox.textContent = msg;
    els.errorBox.style.display = 'block';
  }
  function clearError() {
    els.errorBox.style.display = 'none';
  }

  function showWaiting() {
    els.waitingView.style.display = 'flex';
    els.videoStage.style.display = 'none';
    document.body.classList.remove('receiver-connected');
  }

  function showVideo() {
    els.waitingView.style.display = 'none';
    els.videoStage.style.display = 'flex';
    document.body.classList.add('receiver-connected');
  }

  async function loadIceServers() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
        iceServers = cfg.iceServers;
      }
    } catch {
      // fall back to default STUN already set above
    }
  }

  async function loadQr(code) {
    try {
      const res = await fetch(`/api/qr?code=${code}`);
      if (!res.ok) throw new Error('qr fetch failed');
      const { dataUrl, senderUrl } = await res.json();
      els.qrImg.src = dataUrl;
      els.qrBox.style.display = 'inline-block';
      els.senderUrlText.textContent = senderUrl.replace(/^https?:\/\//, '');
    } catch {
      els.qrBox.style.display = 'none';
    }
  }

  function connectSignaling() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'register-receiver' }));
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleSignal(msg);
    });

    ws.addEventListener('close', () => {
      setStatus('Reconnecting to server…', 'error');
      teardownPeer();
      showWaiting();
      setTimeout(connectSignaling, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
    });

    ws.addEventListener('error', () => ws.close());
  }

  async function handleSignal(msg) {
    switch (msg.type) {
      case 'code-assigned': {
        currentCode = msg.code;
        els.codeDisplay.textContent = msg.code;
        els.statusText.textContent = 'Ready to connect';
        setStatus('Waiting for iPhone…', 'waiting');
        clearError();
        loadQr(msg.code);
        break;
      }

      case 'code-expired': {
        setStatus('Code expired — refreshing…', 'error');
        ws.send(JSON.stringify({ type: 'register-receiver' }));
        break;
      }

      case 'sender-joined': {
        setStatus('Phone connecting…', 'waiting');
        break;
      }

      case 'offer': {
        await handleOffer(msg.sdp);
        break;
      }

      case 'ice-candidate': {
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch (e) { /* benign race */ }
        }
        break;
      }

      case 'stats': {
        if (msg.stats) {
          els.hudInfo.textContent =
            `Connected · ${msg.stats.width || '—'} × ${msg.stats.height || '—'} · ${msg.stats.fps || '—'} fps · ${msg.stats.bitrateMbps || '—'} Mbps`;
        }
        break;
      }

      case 'peer-disconnected': {
        setStatus('iPhone disconnected', 'error');
        teardownPeer();
        showWaiting();
        // Ask for a fresh code so a stale one can't be reused.
        ws.send(JSON.stringify({ type: 'register-receiver' }));
        break;
      }

      case 'pair-error': {
        showError(`Pairing failed: ${msg.reason.replace(/_/g, ' ')}`);
        break;
      }

      default:
        break;
    }
  }

  async function handleOffer(sdp) {
    teardownPeer(); // safety: only one active peer connection at a time
    pc = new RTCPeerConnection({ iceServers });

    pc.ontrack = (event) => {
      els.remoteVideo.srcObject = event.streams[0];
      showVideo();
      setStatus('Connected', 'connected');
      startLocalStatsLoop();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        ws.send(JSON.stringify({ type: 'connected' }));
      } else if (['disconnected', 'failed'].includes(pc.connectionState)) {
        els.hudInfo.textContent = 'Connection interrupted… reconnecting';
      } else if (pc.connectionState === 'closed') {
        showWaiting();
      }
    };

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
  }

  function startLocalStatsLoop() {
    stopLocalStatsLoop();
    statsTimer = setInterval(async () => {
      if (!pc) return;
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const now = report.timestamp;
          const bytes = report.bytesReceived || 0;
          let bitrateMbps = '—';
          if (lastStatsTime && now > lastStatsTime) {
            const bits = (bytes - lastBytes) * 8;
            const seconds = (now - lastStatsTime) / 1000;
            bitrateMbps = (bits / seconds / 1e6).toFixed(1);
          }
          lastBytes = bytes;
          lastStatsTime = now;
          els.hudInfo.textContent =
            `Connected · ${report.frameWidth || '—'} × ${report.frameHeight || '—'} · ${Math.round(report.framesPerSecond || 0)} fps · ${bitrateMbps} Mbps`;
        }
      });
    }, 2000);
  }
  function stopLocalStatsLoop() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    lastBytes = 0;
    lastStatsTime = 0;
  }

  function teardownPeer() {
    stopLocalStatsLoop();
    if (pc) {
      try { pc.close(); } catch {}
      pc = null;
    }
    els.remoteVideo.srcObject = null;
  }

  els.disconnectBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'disconnect' }));
    }
    teardownPeer();
    showWaiting();
    setStatus('Waiting for iPhone…', 'waiting');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'register-receiver' }));
    }
  });

  (async function init() {
    await loadIceServers();
    connectSignaling();
  })();
})();
