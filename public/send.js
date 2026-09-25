(() => {
  'use strict';

  const els = {
    pairStep: document.getElementById('pairStep'),
    shareStep: document.getElementById('shareStep'),
    sharingStep: document.getElementById('sharingStep'),
    codeInput: document.getElementById('codeInput'),
    connectBtn: document.getElementById('connectBtn'),
    pairError: document.getElementById('pairError'),
    startShareBtn: document.getElementById('startShareBtn'),
    unsupportedHint: document.getElementById('unsupportedHint'),
    shareError: document.getElementById('shareError'),
    sharingStatus: document.getElementById('sharingStatus'),
    localPreview: document.getElementById('localPreview'),
    stopShareBtn: document.getElementById('stopShareBtn'),
  };

  let ws = null;
  let pc = null;
  let localStream = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let pairedCode = null;

  // ---- Prefill code from ?code=XXXX (e.g. from the QR code) ----
  const params = new URLSearchParams(location.search);
  if (params.get('code')) {
    els.codeInput.value = params.get('code').replace(/\D/g, '').slice(0, 4);
  }

  // ---- Capability detection (do this once, up front, honestly) ----
  const capabilities = {
    webRTC: typeof RTCPeerConnection !== 'undefined',
    displayCapture: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'),
    userMedia: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'),
  };

  function showStep(step) {
    els.pairStep.style.display = step === 'pair' ? 'block' : 'none';
    els.shareStep.style.display = step === 'share' ? 'block' : 'none';
    els.sharingStep.style.display = step === 'sharing' ? 'block' : 'none';
  }

  function showPairError(msg) {
    els.pairError.textContent = msg;
    els.pairError.style.display = 'block';
  }
  function clearPairError() { els.pairError.style.display = 'none'; }

  function showShareError(msg) {
    els.shareError.textContent = msg;
    els.shareError.style.display = 'block';
  }
  function clearShareError() { els.shareError.style.display = 'none'; }

  async function loadIceServers() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceServers = cfg.iceServers;
    } catch { /* keep default STUN */ }
  }

  function connectSignaling(code) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'register-sender', code }));
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleSignal(msg);
    });

    ws.addEventListener('close', () => {
      if (els.sharingStep.style.display !== 'none') {
        els.sharingStatus.textContent = 'Connection lost — reconnecting…';
      }
    });
  }

  function handleSignal(msg) {
    switch (msg.type) {
      case 'pair-success':
        pairedCode = msg.code;
        clearPairError();
        renderCapabilityStep();
        showStep('share');
        break;

      case 'pair-error':
        showPairError(`That code didn't work (${msg.reason.replace(/_/g, ' ')}). Check the Tesla screen and try again.`);
        break;

      case 'answer':
        if (pc) pc.setRemoteDescription(msg.sdp).catch(() => {});
        break;

      case 'ice-candidate':
        if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(() => {});
        break;

      case 'peer-connected':
        els.sharingStatus.textContent = 'Connected to Tesla';
        break;

      case 'peer-disconnected':
        stopSharing(false);
        showPairError('The Tesla receiver disconnected. Enter the code again to reconnect.');
        showStep('pair');
        break;

      case 'session-expired':
        stopSharing(false);
        showPairError('This session expired. Enter a fresh code from the Tesla screen.');
        showStep('pair');
        break;

      default:
        break;
    }
  }

  function renderCapabilityStep() {
    if (capabilities.displayCapture && capabilities.webRTC) {
      els.startShareBtn.disabled = false;
      els.startShareBtn.textContent = 'Start Screen Sharing';
      els.unsupportedHint.style.display = 'none';
      return;
    }

    // Honest, explicit limitation message instead of a fake working state.
    els.startShareBtn.disabled = true;
    els.startShareBtn.textContent = 'Screen Sharing Unavailable';
    els.unsupportedHint.style.display = 'block';
    els.unsupportedHint.innerHTML =
      'This browser does not expose the in-page screen capture API ' +
      '(<code>getDisplayMedia</code>) needed for true screen mirroring — this currently ' +
      'includes Safari and all browsers on iOS, since every iOS browser uses WebKit. ' +
      'There is no JavaScript workaround for this; it is a platform restriction, not a bug in this app.';

    if (capabilities.userMedia) {
      const camBtn = document.createElement('button');
      camBtn.className = 'btn-secondary';
      camBtn.style.marginTop = '10px';
      camBtn.textContent = 'Cast Camera Instead (not your screen)';
      camBtn.addEventListener('click', () => startSharing('camera'));
      els.shareStep.insertBefore(camBtn, els.unsupportedHint);
    }
  }

  async function startSharing(mode) {
    clearShareError();
    try {
      if (mode === 'camera') {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', frameRate: { ideal: 30, max: 30 } },
          audio: false,
        });
      } else {
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 } },
          audio: false,
        });
      }
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        showShareError('Permission was denied. Tap Start Sharing again and allow access when prompted.');
      } else {
        showShareError(`Could not start capture: ${err && err.message ? err.message : err}`);
      }
      return;
    }

    els.localPreview.srcObject = localStream;

    const track = localStream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      // The OS/browser stopped the share (e.g. user picked "Stop Sharing" in the browser UI).
      stopSharing(true);
    });

    pc = new RTCPeerConnection({ iceServers });
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        els.sharingStatus.textContent = 'Connected to Tesla';
      } else if (['disconnected', 'failed'].includes(pc.connectionState)) {
        els.sharingStatus.textContent = 'Connection interrupted… reconnecting';
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));

    showStep('sharing');
  }

  function stopSharing(notifyServer) {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (pc) {
      try { pc.close(); } catch {}
      pc = null;
    }
    els.localPreview.srcObject = null;
    if (notifyServer && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'disconnect' }));
    }
  }

  els.connectBtn.addEventListener('click', () => {
    const code = els.codeInput.value.trim();
    if (!/^\d{4}$/.test(code)) {
      showPairError('Enter the 4-digit code shown on your Tesla screen.');
      return;
    }
    clearPairError();
    connectSignaling(code);
  });

  els.startShareBtn.addEventListener('click', () => startSharing('display'));
  els.stopShareBtn.addEventListener('click', () => {
    stopSharing(true);
    showStep('share');
  });

  loadIceServers();
})();
