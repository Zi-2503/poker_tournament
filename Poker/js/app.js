// 主控制器：房主权威牌局 + MQTT 中继的角色编排。

import { Relay, loadMqttSdk, wait } from "./net.js";
import { MSG, ACTION, BROKERS, controlTopic, hostTopic, randomRoomCode, normalizeRoomCode } from "./protocol.js";
import * as ui from "./ui.js";
import { HostGame, PHASE, STATUS } from "./engine.js";
import { computeDeck, verifyDeck, verifyDeal } from "./shuffle.js";
import { loadIdentity } from "./identity.js";
import {
  deriveSharedKey, encryptJson, decryptJson,
  sha256Hex, randomHex
} from "./crypto.js";

const HOST_SAVE_KEY = "riverguard:hostState";
const SEED_WAIT_MS = 900;
const HEARTBEAT_MS = 2500;
const STATE_BROADCAST_MS = 4000;
const HOST_TIMEOUT_MS = 12000;
const PRESENCE_MS = 5000;
const HAND_PAUSE_MS = 4000;

const app = {
  role: null,
  roomCode: null,
  identity: null,
  relay: null,
  game: null,
  hostKey: null,
  token: null,
  sharedKey: null,
  hostTopicName: null,
  state: null,
  myCards: [],
  myCardsHandNo: null,
  seq: -1,
  clockOffset: 0,
  hostOnline: true,
  lastHostSeen: 0,
  verification: null,
  handReveals: [],
  peers: new Map(),
  timers: [],
  dealing: false,
  nextHandScheduled: false,
  roomRevealed: false,
  relayLabel: "Disconnected",
  preferredBrokerIndex: 0,
  handshake: null
};

function context() {
  return {
    state: app.state,
    myId: app.identity.playerId,
    myCards: app.myCards,
    role: app.role,
    hostOnline: app.hostOnline,
    relayLabel: app.relayLabel,
    verification: app.verification,
    roomCode: app.roomCode,
    clockOffset: app.clockOffset || 0
  };
}

function onRelayStatus(status) {
  const offline = status.state === "offline";
  if (offline && !app.relayOffline) ui.toast("Connection lost. Reconnecting…", true);
  app.relayOffline = offline;
  app.relayLabel = status.broker || "";
}

function pushTimer(fn, ms) {
  app.timers.push(setInterval(fn, ms));
}

function clearTimers() {
  app.timers.forEach((timer) => clearInterval(timer));
  app.timers = [];
}

// ---------------------------------------------------------------- 房主角色

async function startAsHost({ nickname, startingChips, blindLevelMinutes }) {
  const me = app.identity;
  const roomCode = randomRoomCode();
  const hostSecretHex = randomHex(32);
  const hostSecretCommit = await sha256Hex(hostSecretHex);
  const hostKey = randomHex(8);

  app.role = "host";
  app.roomCode = roomCode;
  app.hostKey = hostKey;
  app.hostTopicName = hostTopic(roomCode, hostKey);
  app.verification = null;
  app.handReveals = [];
  app.roomRevealed = false;
  app.myCardsHandNo = null;
  app.game = new HostGame({
    roomId: roomCode,
    hostId: me.playerId,
    hostSecretHex,
    hostSecretCommit,
    settings: { startingChips, blindLevelMinutes, maxPlayers: 9 }
  });
  app.game.addPlayer({
    playerId: me.playerId,
    name: nickname,
    publicKey: me.publicKeyB64,
    token: randomHex(16),
    isHost: true
  });

  app.relay = new Relay({ roomCode, onMessage: onHostMessage, onStatus: onRelayStatus });
  await app.relay.connect();
  await app.relay.subscribe([controlTopic(roomCode), app.hostTopicName]);
  app.state = app.game.publicState();
  app.myCards = app.game.privateCards(me.playerId).cards;

  storeHostSnapshot();
  startHostLoops();
  ui.setScreen("table");
  ui.renderTable(context());
  ui.toast(`Room ${roomCode} created. Share the code or invite link.`);
}

async function restoreHostRoom() {
  const raw = sessionStorage.getItem(HOST_SAVE_KEY);
  if (!raw) return false;
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!saved?.state) return false;
  app.role = "host";
  app.roomCode = saved.roomCode;
  app.hostKey = saved.hostKey;
  app.hostTopicName = hostTopic(saved.roomCode, saved.hostKey);
  app.game = HostGame.restore(saved.state);
  app.handReveals = saved.handReveals || [];
  app.peers = new Map();
  for (const player of Object.values(app.game.s.players)) {
    if (!player.publicKey || player.id === app.identity.playerId) continue;
    const sharedKey = await deriveSharedKey(app.identity.privateKey, player.publicKey);
    app.peers.set(player.id, { publicKey: player.publicKey, sharedKey, token: player.token, seed: null });
  }
  app.relay = new Relay({ roomCode: app.roomCode, onMessage: onHostMessage, onStatus: onRelayStatus });
  await app.relay.connect();
  await app.relay.subscribe([controlTopic(app.roomCode), app.hostTopicName]);
  app.state = app.game.publicState();
  app.myCards = app.game.privateCards(app.identity.playerId).cards;
  startHostLoops();
  ui.setScreen("table");
  ui.renderTable(context());
  await broadcastState();
  await sendPrivateCards();
  ui.toast(`Room ${app.roomCode} restored.`);
  return true;
}

async function broadcastState() {
  if (app.role !== "host") return;
  app.state = app.game.publicState();
  app.seq += 1;
  await app.relay.send(app.hostTopicName, MSG.STATE_UPDATE, {
    state: app.state, seq: app.seq, hostTime: Date.now()
  }, app.identity.playerId);
  ui.renderTable(context());
}

async function sendPrivateCards() {
  const handNo = app.game.s.handNo;
  for (const [playerId, peer] of app.peers) {
    // 即使没有底牌也要下发，让客户端清空上一手的显示
    const { cards } = app.game.privateCards(playerId);
    const sealed = await encryptJson(peer.sharedKey, { handNo, cards });
    await app.relay.send(app.hostTopicName, MSG.PRIVATE_CARDS, { to: playerId, sealed }, app.identity.playerId);
  }
  app.myCards = app.game.privateCards(app.identity.playerId).cards;
  app.myCardsHandNo = handNo;
  ui.renderTable(context());
}

function startHostLoops() {
  clearTimers();

  pushTimer(() => {
    if (app.game.tick(Date.now())) hostAfterChange();
  }, 1000);

  pushTimer(() => ui.updateBlindTimer(app.state, 0), 1000);

  pushTimer(() => {
    app.relay.send(app.hostTopicName, MSG.HEARTBEAT, {
      roomId: app.roomCode, seq: app.seq, phase: app.game.s.phase,
      status: app.game.s.status, hostTime: Date.now()
    }, app.identity.playerId).catch(() => {});
  }, HEARTBEAT_MS);

  pushTimer(() => {
    if (app.game.s.status !== STATUS.LOBBY) broadcastState();
  }, STATE_BROADCAST_MS);

  pushTimer(() => {
    const now = Date.now();
    let changed = false;
    for (const player of Object.values(app.game.s.players)) {
      // 房主自己永远在线：牌局就运行在这个页面里
      if (player.isHost || player.id === app.identity.playerId) {
        player.lastSeen = now;
        player.connected = true;
        continue;
      }
      const silent = now - (player.lastSeen || 0) > 15000;
      if (player.connected && silent) {
        app.game.setConnected(player.id, false, player.lastSeen);
        changed = true;
      }
    }
    if (app.game.s.status === STATUS.LOBBY) {
      for (const player of Object.values(app.game.s.players)) {
        if (!player.connected && !player.isHost && now - (player.lastSeen || 0) > 45000) {
          app.game.removeFromLobby(player.id);
          app.peers.delete(player.id);
          changed = true;
        }
      }
    }
    if (changed) broadcastState();
  }, PRESENCE_MS);
}

async function hostAfterChange() {
  await broadcastState();
  collectHandReveal();
  storeHostSnapshot();
  const s = app.game.s;
  if (s.status === STATUS.RUNNING && s.phase === PHASE.HAND_COMPLETE && !app.nextHandScheduled) {
    app.nextHandScheduled = true;
    setTimeout(async () => {
      app.nextHandScheduled = false;
      await hostDealNextHand();
    }, HAND_PAUSE_MS);
  }
  if (s.status === STATUS.FINISHED && !app.roomRevealed) {
    app.roomRevealed = true;
    await app.relay.send(app.hostTopicName, MSG.HAND_REVEAL, {
      final: true,
      hostSecretHex: s.hostSecretHex,
      hostSecretCommit: s.hostSecretCommit,
      hands: app.handReveals
    }, app.identity.playerId);
  }
}

/**
 * 每手只公开牌堆哈希（已随 STATE_UPDATE 广播），完整牌堆与房主密钥留到锦标赛
 * 结束后一次性公开。这样既能事后复算，也不会提前泄露弃牌玩家的底牌。
 */
function collectHandReveal() {
  const reveal = app.game.handReveal();
  if (!reveal) return;
  if (app.handReveals.some((item) => item.handNo === reveal.handNo)) return;
  app.handReveals.push(reveal);
}

function storeHostSnapshot() {
  if (app.role !== "host" || !app.game) return;
  try {
    sessionStorage.setItem(HOST_SAVE_KEY, JSON.stringify({
      roomCode: app.roomCode,
      hostKey: app.hostKey,
      state: app.game.snapshot(),
      handReveals: app.handReveals
    }));
  } catch { /* 忽略容量问题 */ }
}

async function hostDealNextHand() {
  if (app.dealing || app.role !== "host") return;
  if (app.game.s.status !== STATUS.RUNNING) return;
  if (app.game.s.phase !== PHASE.LOBBY && app.game.s.phase !== PHASE.HAND_COMPLETE) return;
  app.dealing = true;
  try {
    const handNo = app.game.s.handNo + 1;
    for (const peer of app.peers.values()) peer.seed = null;
    await app.relay.send(app.hostTopicName, MSG.SEED_REQUEST, { handNo }, app.identity.playerId);
    await wait(SEED_WAIT_MS);
    const seeds = [...app.peers.values()].map((peer) => peer.seed).filter(Boolean);
    const { deck, deckHash } = await computeDeck({ hostSecretHex: app.game.s.hostSecretHex, handNo, seeds });
    const result = app.game.beginHand({ deck, seeds, deckHash });
    if (!result.ok) {
      ui.toast(result.error, true);
      return;
    }
    app.myCards = app.game.privateCards(app.identity.playerId).cards;
    app.myCardsHandNo = app.game.s.handNo;
    await broadcastState();
    await sendPrivateCards();
    collectHandReveal();
    storeHostSnapshot();
  } finally {
    app.dealing = false;
  }
}

async function onHostMessage(message) {
  if (message.from === app.identity.playerId) return;
  const payload = message.payload || {};
  try {
    switch (message.type) {
      case MSG.HELLO: await handleHello(payload); break;
      case MSG.JOIN_ROOM: await handleRejoin(payload); break;
      case MSG.PLAYER_ACTION: await handlePlayerAction(payload); break;
      case MSG.SEED_REVEAL: handleSeedReveal(payload); break;
      case MSG.RESYNC: await handleResync(payload); break;
      case MSG.PING: handlePing(payload); break;
      default: break;
    }
  } catch (error) {
    console.warn("Host message failed", message.type, error);
  }
}

async function handleHello(payload) {
  const { playerId, name, publicKey } = payload || {};
  if (!playerId || !publicKey || !name) return;
  if (playerId === app.identity.playerId) {
    await app.relay.send(controlTopic(app.roomCode), MSG.JOIN_DENIED, {
      to: playerId,
      reason: "This tab shares the host identity. Join from a new tab or another device."
    }, app.identity.playerId);
    return;
  }
  const sharedKey = await deriveSharedKey(app.identity.privateKey, publicKey);
  const add = app.game.addPlayer({ playerId, name, publicKey, token: randomHex(16) });
  if (!add.ok) {
    await app.relay.send(controlTopic(app.roomCode), MSG.JOIN_DENIED, { to: playerId, reason: add.error }, app.identity.playerId);
    return;
  }
  app.peers.set(playerId, { publicKey, sharedKey, token: add.player.token, seed: null });
  const sealed = await encryptJson(sharedKey, { token: add.player.token, state: app.game.publicState() });
  await app.relay.send(controlTopic(app.roomCode), MSG.HELLO_ACK, {
    to: playerId,
    hostId: app.identity.playerId,
    hostPublicKey: app.identity.publicKeyB64,
    hostKey: app.hostKey,
    hostSecretCommit: app.game.s.hostSecretCommit,
    brokerUrl: app.relay.currentBroker?.url || null,
    sealed
  }, app.identity.playerId);
  await broadcastState();
  if (app.game.s.handNo > 0) await sendPrivateCards();
  ui.toast(`${String(name).slice(0, 16)} joined the room`);
}

async function handleRejoin(payload) {
  const peer = app.peers.get(payload?.playerId);
  if (!peer || peer.token !== payload.token) {
    await app.relay.send(controlTopic(app.roomCode), MSG.JOIN_DENIED, {
      to: payload?.playerId, reason: "Your session expired. Please rejoin."
    }, app.identity.playerId);
    return;
  }
  app.game.setConnected(payload.playerId, true);
  await app.relay.send(controlTopic(app.roomCode), MSG.JOIN_ACK, {
    to: payload.playerId, state: app.game.publicState()
  }, app.identity.playerId);
  await broadcastState();
  if (app.game.s.handNo > 0) await sendPrivateCards();
}

async function handlePlayerAction(payload) {
  const peer = app.peers.get(payload?.playerId);
  if (!peer || peer.token !== payload.token) return;
  app.game.setConnected(payload.playerId, true);
  const result = app.game.applyAction(payload.playerId, payload.action, payload.amount);
  if (!result.ok) {
    await app.relay.send(app.hostTopicName, MSG.JOIN_DENIED, {
      to: payload.playerId, reason: result.error
    }, app.identity.playerId);
    return;
  }
  await hostAfterChange();
}

function handleSeedReveal(payload) {
  const peer = app.peers.get(payload?.playerId);
  if (!peer || peer.token !== payload.token) return;
  app.game.setConnected(payload.playerId, true);
  if (typeof payload.seed === "string" && payload.seed.length >= 8) peer.seed = payload.seed;
}

/** 轻量在线心跳：只更新房主侧的在线状态，不触发广播。 */
function handlePing(payload) {
  const peer = app.peers.get(payload?.playerId);
  if (!peer || peer.token !== payload.token) return;
  app.game.setConnected(payload.playerId, true);
}

async function handleResync(payload) {
  const peer = app.peers.get(payload?.playerId);
  if (!peer || (payload.token && peer.token !== payload.token)) return;
  app.game.setConnected(payload.playerId, true);
  await broadcastState();
  await sendPrivateCards();
}

// ---------------------------------------------------------------- 玩家角色

/** 在某一个中继节点上完成一次完整的加入握手。 */
async function tryJoinOnce(roomCode, nickname, brokerIndex) {
  const me = app.identity;
  const relay = new Relay({
    roomCode, onMessage: onClientMessage, onStatus: onRelayStatus, startIndex: brokerIndex
  });
  app.relay = relay;
  await relay.connect();
  await relay.subscribe([controlTopic(roomCode)]);

  const ackPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The host did not respond.")), 7000);
    app.handshake = {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    };
  });
  await relay.send(controlTopic(roomCode), MSG.HELLO, {
    playerId: me.playerId, name: nickname, publicKey: me.publicKeyB64
  }, me.playerId);
  const message = await ackPromise;
  app.handshake = null;
  return { relay, message };
}

/** 握手成功后切换到房主频道、领取身份令牌并开始监听牌局。 */
async function completeJoin(relay, payload, roomCode, nickname) {
  const me = app.identity;
  app.hostKey = payload.hostKey;
  app.hostTopicName = hostTopic(roomCode, payload.hostKey);
  app.sharedKey = await deriveSharedKey(me.privateKey, payload.hostPublicKey);
  const inner = await decryptJson(app.sharedKey, payload.sealed);
  app.token = inner.token;
  app.state = inner.state;
  await relay.subscribe([app.hostTopicName]);
  await relay.send(controlTopic(roomCode), MSG.JOIN_ROOM, {
    playerId: me.playerId, token: app.token, name: nickname
  }, me.playerId);
  startClientLoops();
  ui.setScreen("table");
  ui.renderTable(context());
  ui.toast(`Joined room ${roomCode}.`);
}

/**
 * 依次尝试各个中继节点：房主与玩家必须连在同一个节点上才能互相通信，
 * 所以握手失败或发现房主在别的节点时会自动切换。
 */
async function startAsPlayer({ nickname, roomCode }) {
  const me = app.identity;
  app.role = "player";
  app.roomCode = roomCode;
  app.state = null;
  app.myCards = [];
  app.myCardsHandNo = null;
  app.verification = null;
  app.handReveals = [];
  app.seq = -1;
  app.token = null;
  app.sharedKey = null;
  app.hostOnline = true;
  app.lastHostSeen = Date.now();

  const startIndex = app.preferredBrokerIndex || 0;
  const queue = Array.from({ length: BROKERS.length }, (_, offset) => (startIndex + offset) % BROKERS.length);
  const tried = new Set();
  let lastError = null;
  let attempt = 0;

  while (queue.length) {
    const index = queue.shift();
    if (tried.has(index)) continue;
    tried.add(index);
    attempt += 1;
    if (attempt > 1) ui.toast(`Trying another connection: ${BROKERS[index].label}`);

    let session;
    try {
      session = await tryJoinOnce(roomCode, nickname, index);
    } catch (error) {
      lastError = error;
      app.handshake = null;
      app.relay?.close();
      continue;
    }

    const payload = session.message.payload;
    const hostBrokerUrl = payload.brokerUrl;
    if (hostBrokerUrl && session.relay.currentBroker?.url !== hostBrokerUrl) {
      const hostIndex = BROKERS.findIndex((broker) => broker.url === hostBrokerUrl);
      if (hostIndex >= 0 && !tried.has(hostIndex)) {
        session.relay.close();
        queue.unshift(hostIndex);
        continue;
      }
    }

    app.preferredBrokerIndex = index;
    await completeJoin(session.relay, payload, roomCode, nickname);
    return;
  }

  throw new Error(lastError
    ? `Room ${roomCode} not found. Make sure the host is online and try again.`
    : `Room ${roomCode} not found. Check the room code.`);
}

function startClientLoops() {
  clearTimers();
  pushTimer(() => {
    const offline = Date.now() - app.lastHostSeen > HOST_TIMEOUT_MS;
    if (offline === app.hostOnline) {
      app.hostOnline = !offline;
      ui.renderTable(context());
      if (offline) ui.toast("The host is not responding.", true);
    }
    if (app.hostOnline && Date.now() - app.lastHostSeen > 8000) {
      app.relay.send(controlTopic(app.roomCode), MSG.RESYNC, {
        playerId: app.identity.playerId, token: app.token
      }, app.identity.playerId).catch(() => {});
    }
  }, 2000);
  pushTimer(() => {
    app.relay.send(controlTopic(app.roomCode), MSG.PING, {
      playerId: app.identity.playerId, token: app.token
    }, app.identity.playerId).catch(() => {});
  }, 5000);
  pushTimer(() => ui.updateBlindTimer(app.state, app.clockOffset), 1000);
}

async function onClientMessage(message) {
  if (message.from === app.identity.playerId) return;
  const payload = message.payload || {};
  switch (message.type) {
    case MSG.HELLO_ACK:
      if (app.handshake && payload.to === app.identity.playerId && !app.token) app.handshake.resolve(message);
      break;
    case MSG.JOIN_DENIED:
      if (payload.to && payload.to !== app.identity.playerId) return;
      if (app.handshake) app.handshake.reject(new Error(payload.reason || "Unable to join."));
      else ui.toast(payload.reason || "Action rejected.", true);
      break;
    case MSG.STATE_UPDATE:
      if (payload.seq !== undefined && payload.seq <= app.seq) return;
      app.seq = payload.seq ?? app.seq;
      app.state = payload.state;
      if (app.myCardsHandNo !== undefined && payload.state?.handNo !== app.myCardsHandNo) app.myCards = [];
      if (payload.hostTime) app.clockOffset = payload.hostTime - Date.now();
      app.lastHostSeen = Date.now();
      app.hostOnline = true;
      if (payload.state?.handCommit && app.verification?.handNo !== "Tournament") {
        app.verification = {
          handNo: payload.state.handCommit.handNo,
          ok: null,
          deckHash: payload.state.handCommit.deckHash,
          reason: "The host committed to the shuffle. Verification is available after the tournament."
        };
      }
      ui.renderTable(context());
      break;
    case MSG.JOIN_ACK:
      if (payload.to !== app.identity.playerId) return;
      app.state = payload.state;
      app.lastHostSeen = Date.now();
      app.hostOnline = true;
      ui.renderTable(context());
      break;
    case MSG.PRIVATE_CARDS: {
      if (payload.to !== app.identity.playerId || !app.sharedKey) return;
      const inner = await decryptJson(app.sharedKey, payload.sealed);
      app.myCards = inner.cards || [];
      app.myCardsHandNo = inner.handNo;
      ui.renderTable(context());
      break;
    }
    case MSG.HEARTBEAT:
      app.lastHostSeen = Date.now();
      if (payload.hostTime) app.clockOffset = payload.hostTime - Date.now();
      if (!app.hostOnline) { app.hostOnline = true; ui.renderTable(context()); }
      break;
    case MSG.SEED_REQUEST: {
      const seed = randomHex(16);
      await app.relay.send(controlTopic(app.roomCode), MSG.SEED_REVEAL, {
        playerId: app.identity.playerId, token: app.token, seed, handNo: payload.handNo
      }, app.identity.playerId);
      break;
    }
    case MSG.HAND_REVEAL:
      await handleReveal(payload);
      break;
    default:
      break;
  }
}

async function handleReveal(payload) {
  if (payload.final) {
    const commitOk = (await sha256Hex(payload.hostSecretHex)) === payload.hostSecretCommit;
    let verifiedHands = 0;
    const problems = [];
    for (const hand of payload.hands || []) {
      const check = await verifyHandReveal(hand, payload.hostSecretHex);
      if (check.ok) verifiedHands += 1;
      else problems.push(`#${hand.handNo} ${check.reason}`);
    }
    const total = (payload.hands || []).length;
    app.verification = {
      handNo: "Tournament",
      ok: commitOk && problems.length === 0,
      deckHash: payload.hostSecretCommit,
      reason: commitOk
        ? `Host commitment verified. Checked ${verifiedHands}/${total} hands.`
        : "The host commitment does not match."
    };
    ui.renderTable(context());
    return;
  }

  if (!app.handReveals.some((item) => item.handNo === payload.handNo)) app.handReveals.push(payload);
  const check = await verifyHandReveal(payload, null);
  app.verification = {
    handNo: payload.handNo,
    ok: check.ok,
    deckHash: payload.deckHash,
    reason: check.ok ? "Shuffle and deal verified." : check.reason
  };
  ui.renderTable(context());
}

async function verifyHandReveal(hand, hostSecretHex) {
  if ((await sha256Hex(hand.deck.join(","))) !== hand.deckHash) {
    return { ok: false, reason: "The deck does not match the commitment." };
  }
  const deal = verifyDeal({
    deck: hand.deck,
    order: hand.order,
    dealerId: hand.dealerId,
    dealtInIds: hand.dealtInIds,
    holeCards: hand.holeCardsRevealed || {},
    board: hand.board
  });
  if (!deal.ok) return deal;
  if (hostSecretHex) {
    const recomputed = await verifyDeck({
      hostSecretHex, handNo: hand.handNo, seeds: hand.seeds, deck: hand.deck, deckHash: hand.deckHash
    });
    if (!recomputed.ok) return recomputed;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 交互绑定

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    ui.toast(`Copied: ${text}`);
  } catch {
    ui.toast(`Copy manually: ${text}`, true);
  }
}

/** 回到主界面：断开中继、清空本地牌局状态。 */
function backToHome() {
  clearTimers();
  try { app.relay?.close(); } catch { /* 忽略 */ }
  app.handshake = null;
  app.relay = null;
  app.game = null;
  app.state = null;
  app.myCards = [];
  app.myCardsHandNo = null;
  app.role = null;
  app.roomCode = null;
  app.token = null;
  app.sharedKey = null;
  app.peers = new Map();
  app.handReveals = [];
  app.roomRevealed = false;
  app.dealing = false;
  app.nextHandScheduled = false;
  app.verification = null;
  try { sessionStorage.removeItem(HOST_SAVE_KEY); } catch { /* 忽略 */ }
  history.replaceState(null, "", location.pathname);
  document.getElementById("restoreButton").classList.add("hidden");
  ui.setScreen("lobby");
}

async function submitAction(action, amount) {
  if (app.role === "host") {
    const result = app.game.applyAction(app.identity.playerId, action, amount);
    if (!result.ok) { ui.toast(result.error, true); return; }
    await hostAfterChange();
    return;
  }
  await app.relay.send(controlTopic(app.roomCode), MSG.PLAYER_ACTION, {
    playerId: app.identity.playerId, token: app.token, action, amount
  }, app.identity.playerId);
}

function bindEvents() {
  document.getElementById("createForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    ui.setBusy(form, true);
    try {
      ui.rememberName(data.nickname);
      await startAsHost({
        nickname: String(data.nickname).trim().slice(0, 16) || "Host",
        startingChips: clampInt(data.startingChips, 1000, 10000000, 10000),
        blindLevelMinutes: clampInt(data.blindLevelMinutes, 1, 120, 10)
      });
    } catch (error) {
      ui.toast(error.message || "Unable to create the room.", true);
    } finally {
      ui.setBusy(form, false);
    }
  });

  document.getElementById("joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const roomCode = normalizeRoomCode(data.roomCode);
    if (roomCode.length !== 6) { ui.toast("Enter a 6-character room code.", true); return; }
    ui.setBusy(form, true);
    try {
      ui.rememberName(data.nickname);
      await startAsPlayer({
        nickname: String(data.nickname).trim().slice(0, 16) || "Player",
        roomCode
      });
      history.replaceState(null, "", `?room=${roomCode}`);
    } catch (error) {
      ui.toast(error.message || "Unable to join.", true);
      app.relay?.close();
    } finally {
      ui.setBusy(form, false);
    }
  });

  document.getElementById("restoreButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const restored = await restoreHostRoom();
      if (!restored) ui.toast("No saved room was found.", true);
    } catch (error) {
      ui.toast(error.message || "Unable to restore the room.", true);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("startButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = app.game.startTournament();
      if (!result.ok) { ui.toast(result.error, true); return; }
      await broadcastState();
      await hostDealNextHand();
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("actions").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const amount = action === ACTION.RAISE ? Number(document.getElementById("raiseInput").value) : undefined;
    await submitAction(action, amount);
  });

  document.getElementById("copyRoom").addEventListener("click", () => copyText(app.roomCode));

  document.getElementById("backHome").addEventListener("click", () => backToHome());

  document.getElementById("playAgain").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = app.game?.restart();
      if (!result?.ok) { ui.toast(result?.error || "Unable to restart.", true); return; }
      app.handReveals = [];
      app.roomRevealed = false;
      app.verification = null;
      app.myCards = [];
      app.myCardsHandNo = null;
      await broadcastState();
      await hostDealNextHand();
    } catch (error) {
      ui.toast(error.message || "Unable to restart.", true);
    } finally {
      button.disabled = false;
    }
  });
}

async function boot() {
  // 这些阶段标记会被 index.html 的看门狗读取，用于在脚本卡住时给出准确提示
  globalThis.__riverguardStage = "identity";
  ui.setScreen("boot");
  try {
    app.identity = await loadIdentity();
  } catch (error) {
    globalThis.__riverguardStage = "identity-failed";
    ui.toast(
      location.protocol === "file:"
        ? "Open this page using a local web server, not by double-clicking index.html."
        : (error.message || "Your browser does not support the required features."),
      true
    );
  }
  // 提前把 mqtt.js 拉进缓存，但不阻塞界面：真正需要时由 Relay 再连接
  globalThis.__riverguardStage = "relay-warmup";
  loadMqttSdk().catch(() => {});

  ui.fillJoinCodeFromUrl();
  const hasSnapshot = Boolean(sessionStorage.getItem(HOST_SAVE_KEY));
  document.getElementById("restoreButton").classList.toggle("hidden", !hasSnapshot);
  document.getElementById("bootHint")?.classList.add("hidden");
  globalThis.__riverguardStage = "ready";
  ui.setScreen("lobby");
}

bindEvents();
boot();
