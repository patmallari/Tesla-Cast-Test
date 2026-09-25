// test/signaling.test.js
// Exercises the real server over actual WebSocket connections (not mocks):
// receiver registers -> gets a code, sender pairs with that code, offer/answer/
// ICE candidates relay correctly, stats relay, disconnect tears down both sides,
// and invalid/expired codes are rejected. Run with the server already listening.

const WebSocket = require('ws');

const BASE = process.env.TEST_BASE || 'http://localhost:3999';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function connect() {
  return new WebSocket(WS_URL);
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 4000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function main() {
  // ---- 1. Happy path: register receiver, pair sender, relay offer/answer/ICE, stats, disconnect ----
  const receiver = connect();
  await new Promise((r) => receiver.once('open', r));
  receiver.send(JSON.stringify({ type: 'register-receiver' }));
  const codeMsg = await nextMessage(receiver);
  assert(codeMsg.type === 'code-assigned', 'receiver gets code-assigned');
  assert(/^\d{4}$/.test(codeMsg.code), `code is 4 digits (got ${codeMsg.code})`);

  const sender = connect();
  await new Promise((r) => sender.once('open', r));
  sender.send(JSON.stringify({ type: 'register-sender', code: codeMsg.code }));

  const [pairAck, senderJoined] = await Promise.all([nextMessage(sender), nextMessage(receiver)]);
  assert(pairAck.type === 'pair-success', 'sender gets pair-success');
  assert(senderJoined.type === 'sender-joined', 'receiver gets sender-joined');

  // Sender sends a fake offer; receiver should get it relayed verbatim.
  const fakeOffer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\no=- fake' } };
  sender.send(JSON.stringify(fakeOffer));
  const relayedOffer = await nextMessage(receiver);
  assert(relayedOffer.type === 'offer', 'receiver gets relayed offer');
  assert(relayedOffer.sdp.sdp === fakeOffer.sdp.sdp, 'offer SDP content preserved through relay');
  assert(relayedOffer.from === 'sender', 'relayed offer tagged with from=sender');

  // Receiver answers back.
  const fakeAnswer = { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\no=- fake-answer' } };
  receiver.send(JSON.stringify(fakeAnswer));
  const relayedAnswer = await nextMessage(sender);
  assert(relayedAnswer.type === 'answer', 'sender gets relayed answer');
  assert(relayedAnswer.from === 'receiver', 'relayed answer tagged with from=receiver');

  // ICE candidates flow both directions.
  sender.send(JSON.stringify({ type: 'ice-candidate', candidate: { candidate: 'fake-cand-1' } }));
  const iceToReceiver = await nextMessage(receiver);
  assert(iceToReceiver.type === 'ice-candidate' && iceToReceiver.candidate.candidate === 'fake-cand-1', 'ICE candidate sender->receiver relayed');

  receiver.send(JSON.stringify({ type: 'ice-candidate', candidate: { candidate: 'fake-cand-2' } }));
  const iceToSender = await nextMessage(sender);
  assert(iceToSender.type === 'ice-candidate' && iceToSender.candidate.candidate === 'fake-cand-2', 'ICE candidate receiver->sender relayed');

  // "connected" notification relays as peer-connected to the other side.
  sender.send(JSON.stringify({ type: 'connected' }));
  const peerConnectedMsg = await nextMessage(receiver);
  assert(peerConnectedMsg.type === 'peer-connected', 'connected notification relays as peer-connected');

  // Stats relay sender -> receiver only.
  sender.send(JSON.stringify({ type: 'stats', stats: { width: 1280, height: 720, fps: 30, bitrateMbps: '2.1' } }));
  const statsMsg = await nextMessage(receiver);
  assert(statsMsg.type === 'stats' && statsMsg.stats.width === 1280, 'stats relayed sender->receiver');

  // Disconnect from sender tears down both sides.
  sender.send(JSON.stringify({ type: 'disconnect' }));
  const [receiverGetsDisc] = await Promise.all([nextMessage(receiver)]);
  assert(receiverGetsDisc.type === 'peer-disconnected', 'receiver notified on sender disconnect');

  receiver.close();
  sender.close();

  // ---- 2. Invalid code is rejected ----
  const receiver2 = connect();
  await new Promise((r) => receiver2.once('open', r));
  receiver2.send(JSON.stringify({ type: 'register-receiver' }));
  await nextMessage(receiver2); // code-assigned

  const badSender = connect();
  await new Promise((r) => badSender.once('open', r));
  badSender.send(JSON.stringify({ type: 'register-sender', code: '0000' }));
  const badMsg = await nextMessage(badSender);
  assert(badMsg.type === 'pair-error' && badMsg.reason === 'invalid_or_expired_code', 'wrong code rejected with invalid_or_expired_code');
  badSender.close();

  // ---- 3. Double-pairing (already paired) is rejected ----
  const receiver3 = connect();
  await new Promise((r) => receiver3.once('open', r));
  receiver3.send(JSON.stringify({ type: 'register-receiver' }));
  const code3Msg = await nextMessage(receiver3);

  const sender3a = connect();
  await new Promise((r) => sender3a.once('open', r));
  sender3a.send(JSON.stringify({ type: 'register-sender', code: code3Msg.code }));
  await nextMessage(sender3a); // pair-success
  await nextMessage(receiver3); // sender-joined

  const sender3b = connect();
  await new Promise((r) => sender3b.once('open', r));
  sender3b.send(JSON.stringify({ type: 'register-sender', code: code3Msg.code }));
  const dupMsg = await nextMessage(sender3b);
  assert(dupMsg.type === 'pair-error' && dupMsg.reason === 'already_paired', 'second sender on same code gets already_paired');

  receiver2.close();
  receiver3.close();
  sender3a.close();
  sender3b.close();

  // ---- 4. Receiver disconnecting (e.g. page closed) also notifies the sender ----
  const receiver4 = connect();
  await new Promise((r) => receiver4.once('open', r));
  receiver4.send(JSON.stringify({ type: 'register-receiver' }));
  const code4Msg = await nextMessage(receiver4);

  const sender4 = connect();
  await new Promise((r) => sender4.once('open', r));
  sender4.send(JSON.stringify({ type: 'register-sender', code: code4Msg.code }));
  await nextMessage(sender4);
  await nextMessage(receiver4);

  const senderDiscPromise = nextMessage(sender4);
  receiver4.close();
  const senderDiscMsg = await senderDiscPromise;
  assert(senderDiscMsg.type === 'peer-disconnected', 'sender notified when receiver socket closes');
  sender4.close();

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
