(() => {
  'use strict';

  function row(label, ok, detail = '') {
    const tr = document.createElement('tr');
    const pillClass = ok === null ? '' : ok ? 'yes' : 'no';
    const pillText = ok === null ? detail : (ok ? 'Yes' : 'No');
    tr.innerHTML = `<td>${label}</td><td>${
      ok === null ? detail : `<span class="pill ${pillClass}">${pillText}</span> ${detail}`
    }</td>`;
    return tr;
  }

  function fillTable(id, rows) {
    const tbody = document.querySelector(`#${id} tbody`);
    tbody.innerHTML = '';
    rows.forEach((r) => tbody.appendChild(r));
  }

  async function runBrowserChecks() {
    const ua = navigator.userAgent;
    const webRTC = typeof RTCPeerConnection !== 'undefined';
    const displayCapture = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
    const userMedia = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    const webSocket = typeof WebSocket !== 'undefined';

    let autoplaySupported = null;
    try {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      autoplaySupported = typeof v.play === 'function';
    } catch { autoplaySupported = false; }

    fillTable('browserTable', [
      row('User agent', null, `<span style="word-break:break-all; color:var(--muted); font-size:0.8rem;">${ua}</span>`),
      row('WebRTC (RTCPeerConnection)', webRTC),
      row('Screen capture (getDisplayMedia)', displayCapture),
      row('Camera/mic capture (getUserMedia)', userMedia),
      row('WebSocket', webSocket),
      row('Muted autoplay video', autoplaySupported),
    ]);
  }

  async function runNetworkChecks() {
    const rows = [];

    // WebSocket reachability
    const wsOk = await new Promise((resolve) => {
      try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const testWs = new WebSocket(`${proto}://${location.host}/ws`);
        const timer = setTimeout(() => { testWs.close(); resolve(false); }, 4000);
        testWs.onopen = () => { clearTimeout(timer); testWs.close(); resolve(true); };
        testWs.onerror = () => { clearTimeout(timer); resolve(false); };
      } catch { resolve(false); }
    });
    rows.push(row('Signaling WebSocket (/ws)', wsOk));

    // STUN / ICE gathering check
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const cfg = await (await fetch('/api/config')).json();
      if (cfg.iceServers?.length) iceServers = cfg.iceServers;
    } catch { /* use default */ }

    const iceOk = await new Promise((resolve) => {
      try {
        const pc = new RTCPeerConnection({ iceServers });
        let resolved = false;
        const timer = setTimeout(() => { if (!resolved) { resolved = true; pc.close(); resolve(false); } }, 5000);
        pc.onicecandidate = (e) => {
          if (e.candidate && e.candidate.candidate.includes('srflx')) {
            if (!resolved) { resolved = true; clearTimeout(timer); pc.close(); resolve(true); }
          }
        };
        pc.createDataChannel('probe');
        pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      } catch { resolve(false); }
    });
    rows.push(row('STUN connectivity (srflx candidate)', iceOk, iceOk ? '' : 'may still work via TURN or on a shared LAN'));

    fillTable('networkTable', rows);
  }

  async function runServerChecks() {
    const rows = [];
    try {
      const health = await (await fetch('/api/health')).json();
      rows.push(row('Server reachable', true, `uptime ${Math.round(health.uptime)}s`));
    } catch {
      rows.push(row('Server reachable', false));
    }
    try {
      const stats = await (await fetch('/api/stats')).json();
      rows.push(row('Active pairing sessions', null, String(stats.activeSessions)));
    } catch {
      rows.push(row('Active pairing sessions', null, 'unavailable'));
    }
    fillTable('serverTable', rows);
  }

  runBrowserChecks();
  runNetworkChecks();
  runServerChecks();
})();
