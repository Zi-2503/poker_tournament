"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const crypto = require("crypto");
const { createDeck, secureShuffle, settlePots } = require("./poker");

initializeApp();
const db = getFirestore();
const REGION = "asia-east2";
const MAX_PLAYERS = 9;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VALID_ACTIONS = new Set(["CHECK", "CALL", "FOLD", "RAISE", "ALL_IN"]);

function requireAuth(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "请先完成匿名登录");
  return request.auth.uid;
}

function cleanNickname(value) {
  const nickname = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 16);
  if (nickname.length < 1) throw new HttpsError("invalid-argument", "昵称不能为空");
  return nickname;
}

function cleanRoomId(value) {
  const roomId = String(value || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(roomId)) throw new HttpsError("invalid-argument", "房间码格式错误");
  return roomId;
}

function boundedInt(value, name, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpsError("invalid-argument", `${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return number;
}

function randomRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  return code;
}

function initialBlinds(startingChips) {
  const big = Math.max(10, Math.floor(startingChips / 100));
  return { small: Math.max(5, Math.floor(big / 2)), big };
}

function cyclicOrder(order, afterUid) {
  if (!order.length) return [];
  const index = order.indexOf(afterUid);
  const start = index < 0 ? 0 : (index + 1) % order.length;
  return Array.from({ length: order.length }, (_, offset) => order[(start + offset) % order.length]);
}

function eligibleToAct(state, uid) {
  const player = state.players[uid];
  return Boolean(player && player.status === "active" && !player.folded && !player.allIn && player.chips > 0);
}

function handPlayers(state) {
  return state.order.map((uid) => state.players[uid]).filter((player) => player?.dealtIn);
}

function activeTournamentPlayers(state) {
  return state.order.map((uid) => state.players[uid]).filter((player) => player?.status === "active" && player.chips > 0);
}

function nextActiveUid(state, afterUid) {
  return cyclicOrder(state.order, afterUid).find((uid) => state.players[uid]?.status === "active" && state.players[uid].chips > 0) || null;
}

function commitChips(player, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > player.chips) throw new Error("Invalid chip commitment");
  player.chips -= amount;
  player.roundBet += amount;
  player.contributed += amount;
  if (player.chips === 0) player.allIn = true;
}

function logAction(state, text) {
  state.actionLog = [...(state.actionLog || []), { handNo: state.handNo, text, at: Date.now() }].slice(-40);
}

function draw(state, count) {
  const cards = state.deck.slice(state.deckPos, state.deckPos + count);
  if (cards.length !== count) throw new Error("Deck exhausted");
  state.deckPos += count;
  return cards;
}

function revealStreet(state, phase) {
  draw(state, 1); // Burn card stays exclusively in /server/state.
  if (phase === "flop") state.board.push(...draw(state, 3));
  else state.board.push(...draw(state, 1));
  state.phase = phase;
  for (const player of handPlayers(state)) player.roundBet = 0;
  state.currentBet = 0;
  state.minRaise = state.handBigBlind;
  const candidates = cyclicOrder(state.order, state.dealerUid).filter((uid) => eligibleToAct(state, uid));
  state.raiseRights = Object.fromEntries(candidates.map((uid) => [uid, true]));
  state.pending = candidates;
  state.toActUid = candidates[0] || null;
  logAction(state, phase === "flop" ? "翻牌" : phase === "turn" ? "转牌" : "河牌");
}

function awardOrder(state) {
  return cyclicOrder(state.order, state.dealerUid).filter((uid) => state.players[uid]?.dealtIn);
}

function publicEvaluation(evaluation) {
  return { name: evaluation.name, bestFive: evaluation.cards };
}

function applyEliminationsAndRanking(state) {
  const newlyOut = state.order
    .map((uid) => state.players[uid])
    .filter((player) => player.status === "active" && player.chips === 0)
    .sort((a, b) => a.handStartChips - b.handStartChips || b.seat - a.seat);
  for (const player of newlyOut) {
    player.status = "eliminated";
    player.eliminatedAtHand = state.handNo;
    state.eliminations.push({ uid: player.uid, nickname: player.nickname, handNo: state.handNo });
  }

  const survivors = activeTournamentPlayers(state);
  if (survivors.length <= 1) {
    state.status = "finished";
    state.phase = "finished";
    state.toActUid = null;
    state.pending = [];
    const rankings = [];
    if (survivors[0]) rankings.push({ rank: 1, uid: survivors[0].uid, nickname: survivors[0].nickname, chips: survivors[0].chips });
    const reversed = [...state.eliminations].reverse();
    reversed.forEach((item, index) => rankings.push({ rank: rankings.length + 1, uid: item.uid, nickname: item.nickname, chips: 0 }));
    state.rankings = rankings;
    logAction(state, survivors[0] ? `${survivors[0].nickname} 赢得锦标赛` : "锦标赛结束");
    return true;
  }
  return false;
}

function startHand(state) {
  const active = activeTournamentPlayers(state);
  if (active.length < 2) return;
  state.handNo += 1;
  state.dealerUid = state.dealerUid ? nextActiveUid(state, state.dealerUid) : active[0].uid;
  state.deck = secureShuffle(createDeck());
  state.deckPos = 0;
  state.board = [];
  state.holeCards = {};
  state.handSmallBlind = state.smallBlind;
  state.handBigBlind = state.bigBlind;

  for (const uid of state.order) {
    const player = state.players[uid];
    player.dealtIn = player.status === "active" && player.chips > 0;
    player.folded = !player.dealtIn;
    player.allIn = false;
    player.roundBet = 0;
    player.contributed = 0;
    player.handStartChips = player.chips;
    if (player.dealtIn) state.holeCards[uid] = [];
  }

  const dealingOrder = cyclicOrder(state.order, state.dealerUid).filter((uid) => state.players[uid].dealtIn);
  for (let round = 0; round < 2; round += 1) {
    for (const uid of dealingOrder) state.holeCards[uid].push(...draw(state, 1));
  }

  const headsUp = active.length === 2;
  const smallBlindUid = headsUp ? state.dealerUid : nextActiveUid(state, state.dealerUid);
  const bigBlindUid = nextActiveUid(state, smallBlindUid);
  state.smallBlindUid = smallBlindUid;
  state.bigBlindUid = bigBlindUid;
  commitChips(state.players[smallBlindUid], Math.min(state.handSmallBlind, state.players[smallBlindUid].chips));
  commitChips(state.players[bigBlindUid], Math.min(state.handBigBlind, state.players[bigBlindUid].chips));
  // A short all-in big blind does not reduce the table's full bring-in amount.
  // Other players must still call the nominal big blind; unmatched chips are
  // naturally returned through the one-player side-pot layer at settlement.
  state.currentBet = state.handBigBlind;
  state.minRaise = state.handBigBlind;
  state.phase = "preflop";
  const candidates = cyclicOrder(state.order, bigBlindUid).filter((uid) => eligibleToAct(state, uid));
  state.pending = candidates;
  state.raiseRights = Object.fromEntries(candidates.map((uid) => [uid, true]));
  state.toActUid = candidates[0] || null;
  logAction(state, `第 ${state.handNo} 手牌开始，盲注 ${state.handSmallBlind}/${state.handBigBlind}`);
}

function finishFoldedHand(state, winner) {
  const amount = handPlayers(state).reduce((sum, player) => sum + player.contributed, 0);
  winner.chips += amount;
  state.lastHandResult = {
    handNo: state.handNo,
    reason: "fold",
    board: [...state.board],
    pots: [{ amount, winners: [winner.uid] }],
    payouts: { [winner.uid]: amount },
    winners: [{ uid: winner.uid, nickname: winner.nickname, amount }],
    showdownCards: {},
    evaluations: {},
    completedAt: Date.now()
  };
  logAction(state, `${winner.nickname} 赢得 ${amount} 筹码（其他玩家弃牌）`);
  if (!applyEliminationsAndRanking(state)) {
    state.phase = "hand_complete";
    state.toActUid = null;
    state.pending = [];
  }
}

function finishShowdown(state) {
  const participants = handPlayers(state);
  const result = settlePots(participants, state.holeCards, state.board, awardOrder(state));
  for (const [uid, amount] of Object.entries(result.payouts)) state.players[uid].chips += amount;
  const winners = Object.entries(result.payouts)
    .filter(([, amount]) => amount > 0)
    .map(([uid, amount]) => ({ uid, nickname: state.players[uid].nickname, amount }));
  const showdownCards = {};
  const evaluations = {};
  for (const player of participants.filter((item) => !item.folded)) {
    showdownCards[player.uid] = state.holeCards[player.uid];
    evaluations[player.uid] = publicEvaluation(result.evaluations[player.uid]);
  }
  state.lastHandResult = {
    handNo: state.handNo,
    reason: "showdown",
    board: [...state.board],
    pots: result.pots.map((pot) => ({ amount: pot.amount, winners: pot.winners })),
    payouts: result.payouts,
    winners,
    showdownCards,
    evaluations,
    completedAt: Date.now()
  };
  logAction(state, `摊牌：${winners.map((winner) => `${winner.nickname} +${winner.amount}`).join("，")}`);
  if (!applyEliminationsAndRanking(state)) {
    state.phase = "hand_complete";
    state.toActUid = null;
    state.pending = [];
  }
}

function resolveProgress(state) {
  // One action can close a round, run out the board, settle, eliminate players,
  // and atomically start the next hand. No client ever advances the state itself.
  for (let guard = 0; guard < 10; guard += 1) {
    const remaining = handPlayers(state).filter((player) => !player.folded);
    if (remaining.length === 1) {
      finishFoldedHand(state, remaining[0]);
      return;
    }
    state.pending = (state.pending || []).filter((uid) => eligibleToAct(state, uid));
    if (state.pending.length > 0) {
      state.toActUid = state.pending[0];
      return;
    }
    state.toActUid = null;
    if (state.phase === "river") {
      finishShowdown(state);
      return;
    }
    if (state.phase === "preflop") revealStreet(state, "flop");
    else if (state.phase === "flop") revealStreet(state, "turn");
    else if (state.phase === "turn") revealStreet(state, "river");
    else throw new Error(`Cannot advance phase ${state.phase}`);

    // If at most one player still has chips, nobody can make a meaningful bet;
    // automatically reveal the remaining streets and proceed to showdown.
    if (handPlayers(state).filter((player) => eligibleToAct(state, player.uid)).length <= 1) state.pending = [];
  }
  throw new Error("State progression guard exceeded");
}

function advanceBlindClock(state, nowMs) {
  if (state.status !== "running" || !state.nextBlindAtMs || nowMs < state.nextBlindAtMs) return false;
  const durationMs = state.settings.blindLevelMinutes * 60 * 1000;
  const steps = Math.floor((nowMs - state.nextBlindAtMs) / durationMs) + 1;
  state.blindLevel += steps;
  const multiplier = 2 ** Math.min(state.blindLevel, 30);
  state.smallBlind = Math.min(Number.MAX_SAFE_INTEGER, state.baseSmallBlind * multiplier);
  state.bigBlind = Math.min(Number.MAX_SAFE_INTEGER, state.baseBigBlind * multiplier);
  state.nextBlindAtMs += steps * durationMs;
  logAction(state, `盲注升至 ${state.smallBlind}/${state.bigBlind}`);
  return true;
}

function publicPlayer(state, player) {
  return {
    uid: player.uid,
    nickname: player.nickname,
    seat: player.seat,
    chips: player.chips,
    status: player.status,
    folded: Boolean(player.folded),
    allIn: Boolean(player.allIn),
    roundBet: player.roundBet || 0,
    contributed: player.contributed || 0,
    isDealer: state.dealerUid === player.uid,
    isSmallBlind: state.smallBlindUid === player.uid,
    isBigBlind: state.bigBlindUid === player.uid,
    eliminatedAtHand: player.eliminatedAtHand || null,
    updatedAt: FieldValue.serverTimestamp()
  };
}

function publicRoom(state) {
  const pot = handPlayers(state).reduce((sum, player) => sum + (player.contributed || 0), 0);
  return {
    code: state.roomId,
    hostId: state.hostId,
    status: state.status,
    settings: state.settings,
    memberCount: state.order.length,
    handNo: state.handNo,
    stage: state.phase,
    board: state.board || [],
    pot,
    currentBet: state.currentBet || 0,
    minRaise: state.minRaise || 0,
    toActUid: state.toActUid || null,
    dealerUid: state.dealerUid || null,
    blinds: { level: state.blindLevel, small: state.smallBlind, big: state.bigBlind },
    nextBlindAt: state.nextBlindAtMs ? Timestamp.fromMillis(state.nextBlindAtMs) : null,
    lastHandResult: state.lastHandResult || null,
    rankings: state.rankings || [],
    actionLog: state.actionLog || [],
    updatedAt: FieldValue.serverTimestamp()
  };
}

function syncAll(transaction, roomRef, state) {
  transaction.set(roomRef, publicRoom(state), { merge: true });
  for (const uid of state.order) {
    transaction.set(roomRef.collection("players").doc(uid), publicPlayer(state, state.players[uid]), { merge: true });
    transaction.set(roomRef.collection("private_cards").doc(uid), {
      ownerId: uid,
      handNo: state.handNo,
      cards: state.holeCards?.[uid] || [],
      updatedAt: FieldValue.serverTimestamp()
    });
  }
  transaction.set(roomRef.collection("server").doc("state"), state);
}

exports.createRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const nickname = cleanNickname(request.data?.nickname);
  const startingChips = boundedInt(request.data?.startingChips ?? 10000, "初始筹码", 1000, 10000000);
  const blindLevelMinutes = boundedInt(request.data?.blindLevelMinutes ?? 10, "升盲分钟", 1, 120);
  const base = initialBlinds(startingChips);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomId = randomRoomCode();
    const roomRef = db.collection("rooms").doc(roomId);
    try {
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(roomRef);
        if (existing.exists) throw new Error("ROOM_CODE_COLLISION");
        const player = {
          uid, nickname, seat: 0, chips: startingChips, status: "active",
          dealtIn: false, folded: false, allIn: false, roundBet: 0,
          contributed: 0, handStartChips: startingChips
        };
        const state = {
          schemaVersion: 1,
          roomId,
          hostId: uid,
          status: "lobby",
          phase: "lobby",
          settings: { startingChips, blindLevelMinutes, maxPlayers: MAX_PLAYERS },
          players: { [uid]: player },
          order: [uid],
          handNo: 0,
          dealerUid: null,
          smallBlindUid: null,
          bigBlindUid: null,
          baseSmallBlind: base.small,
          baseBigBlind: base.big,
          smallBlind: base.small,
          bigBlind: base.big,
          blindLevel: 0,
          nextBlindAtMs: null,
          board: [],
          deck: [],
          deckPos: 0,
          holeCards: {},
          currentBet: 0,
          minRaise: base.big,
          pending: [],
          raiseRights: {},
          toActUid: null,
          eliminations: [],
          rankings: [],
          lastHandResult: null,
          actionLog: [{ handNo: 0, text: `${nickname} 创建了房间`, at: Date.now() }]
        };
        syncAll(transaction, roomRef, state);
      });
      return { roomId };
    } catch (error) {
      if (error.message !== "ROOM_CODE_COLLISION") throw error;
    }
  }
  throw new HttpsError("resource-exhausted", "暂时无法生成房间码，请重试");
});

exports.joinRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const roomId = cleanRoomId(request.data?.roomId);
  const nickname = cleanNickname(request.data?.nickname);
  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (transaction) => {
    const stateRef = roomRef.collection("server").doc("state");
    const stateSnap = await transaction.get(stateRef);
    if (!stateSnap.exists) throw new HttpsError("not-found", "房间不存在");
    const state = stateSnap.data();
    if (state.players[uid]) return;
    if (state.status !== "lobby") throw new HttpsError("failed-precondition", "锦标赛已经开始");
    if (state.order.length >= state.settings.maxPlayers) throw new HttpsError("resource-exhausted", "房间已满");
    if (Object.values(state.players).some((player) => player.nickname.toLowerCase() === nickname.toLowerCase())) {
      throw new HttpsError("already-exists", "该昵称已被使用");
    }
    state.players[uid] = {
      uid, nickname, seat: state.order.length, chips: state.settings.startingChips,
      status: "active", dealtIn: false, folded: false, allIn: false,
      roundBet: 0, contributed: 0, handStartChips: state.settings.startingChips
    };
    state.order.push(uid);
    logAction(state, `${nickname} 加入了房间`);
    syncAll(transaction, roomRef, state);
  });
  return { roomId };
});

exports.startTournament = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const roomId = cleanRoomId(request.data?.roomId);
  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (transaction) => {
    const stateRef = roomRef.collection("server").doc("state");
    const snap = await transaction.get(stateRef);
    if (!snap.exists) throw new HttpsError("not-found", "房间不存在");
    const state = snap.data();
    if (state.hostId !== uid) throw new HttpsError("permission-denied", "只有房主可以开始");
    if (state.status !== "lobby") throw new HttpsError("failed-precondition", "锦标赛已经开始");
    if (state.order.length < 2) throw new HttpsError("failed-precondition", "至少需要两名玩家");
    state.status = "running";
    state.nextBlindAtMs = Date.now() + state.settings.blindLevelMinutes * 60 * 1000;
    startHand(state);
    resolveProgress(state);
    syncAll(transaction, roomRef, state);
  });
  return { ok: true };
});

exports.playerAction = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const roomId = cleanRoomId(request.data?.roomId);
  const action = String(request.data?.action || "").toUpperCase();
  if (!VALID_ACTIONS.has(action)) throw new HttpsError("invalid-argument", "未知操作");
  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (transaction) => {
    const stateRef = roomRef.collection("server").doc("state");
    const snap = await transaction.get(stateRef);
    if (!snap.exists) throw new HttpsError("not-found", "房间不存在");
    const state = snap.data();
    if (state.status !== "running") throw new HttpsError("failed-precondition", "锦标赛未在进行中");
    if (!state.players[uid]) throw new HttpsError("permission-denied", "你不是该房间成员");
    if (state.toActUid !== uid || state.pending?.[0] !== uid) throw new HttpsError("failed-precondition", "还没轮到你");
    const player = state.players[uid];
    if (!eligibleToAct(state, uid)) throw new HttpsError("failed-precondition", "当前不能行动");
    advanceBlindClock(state, Date.now());

    const toCall = Math.max(0, state.currentBet - player.roundBet);
    const previousPending = [...state.pending];
    let raised = false;
    let fullRaise = false;
    let target = player.roundBet;

    if (action === "FOLD") {
      player.folded = true;
      state.raiseRights[uid] = false;
      logAction(state, `${player.nickname} 弃牌`);
    } else if (action === "CHECK") {
      if (toCall !== 0) throw new HttpsError("failed-precondition", `需要跟注 ${toCall}，不能过牌`);
      state.raiseRights[uid] = false;
      logAction(state, `${player.nickname} 过牌`);
    } else if (action === "CALL") {
      if (toCall === 0) throw new HttpsError("failed-precondition", "无需跟注，请过牌");
      const paid = Math.min(toCall, player.chips);
      commitChips(player, paid);
      state.raiseRights[uid] = false;
      logAction(state, `${player.nickname} ${paid < toCall ? "全下" : "跟注"} ${paid}`);
    } else {
      if (action === "ALL_IN") target = player.roundBet + player.chips;
      else target = boundedInt(request.data?.amount, "加注到", 1, Number.MAX_SAFE_INTEGER);
      const maximum = player.roundBet + player.chips;
      if (target > maximum) throw new HttpsError("failed-precondition", "筹码不足");
      if (target <= player.roundBet) throw new HttpsError("invalid-argument", "下注额必须增加");

      if (target <= state.currentBet) {
        if (action !== "ALL_IN" || target !== maximum) throw new HttpsError("failed-precondition", "加注额必须高于当前下注");
        commitChips(player, target - player.roundBet);
        state.raiseRights[uid] = false;
        logAction(state, `${player.nickname} 全下 ${target}`);
      } else {
        if (!state.raiseRights[uid]) throw new HttpsError("failed-precondition", "短码全下未重新开放加注权");
        const raiseSize = target - state.currentBet;
        const isAllIn = target === maximum;
        if (raiseSize < state.minRaise && !isAllIn) {
          throw new HttpsError("failed-precondition", `最小加注到 ${state.currentBet + state.minRaise}`);
        }
        commitChips(player, target - player.roundBet);
        raised = true;
        fullRaise = raiseSize >= state.minRaise;
        state.currentBet = target;
        if (fullRaise) state.minRaise = raiseSize;
        state.raiseRights[uid] = false;
        logAction(state, `${player.nickname} ${isAllIn ? "全下" : "加注到"} ${target}`);
      }
    }

    if (raised && fullRaise) {
      const candidates = cyclicOrder(state.order, uid).filter((otherUid) => otherUid !== uid && eligibleToAct(state, otherUid));
      state.pending = candidates;
      for (const otherUid of candidates) state.raiseRights[otherUid] = true;
    } else if (raised) {
      const stillPending = new Set(previousPending.slice(1));
      state.pending = cyclicOrder(state.order, uid).filter((otherUid) =>
        otherUid !== uid && eligibleToAct(state, otherUid) &&
        (stillPending.has(otherUid) || state.players[otherUid].roundBet < state.currentBet));
    } else {
      state.pending = previousPending.slice(1);
    }

    resolveProgress(state);
    syncAll(transaction, roomRef, state);
  });
  return { ok: true };
});

exports.dealNextHand = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const roomId = cleanRoomId(request.data?.roomId);
  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (transaction) => {
    const stateRef = roomRef.collection("server").doc("state");
    const snap = await transaction.get(stateRef);
    if (!snap.exists) throw new HttpsError("not-found", "房间不存在");
    const state = snap.data();
    if (!state.players[uid]) throw new HttpsError("permission-denied", "你不是该房间成员");
    if (state.status !== "running" || state.phase !== "hand_complete") return;
    advanceBlindClock(state, Date.now());
    startHand(state);
    resolveProgress(state);
    syncAll(transaction, roomRef, state);
  });
  return { ok: true };
});

exports.tickRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const roomId = cleanRoomId(request.data?.roomId);
  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (transaction) => {
    const stateRef = roomRef.collection("server").doc("state");
    const snap = await transaction.get(stateRef);
    if (!snap.exists) throw new HttpsError("not-found", "房间不存在");
    const state = snap.data();
    if (!state.players[uid]) throw new HttpsError("permission-denied", "你不是该房间成员");
    if (advanceBlindClock(state, Date.now())) syncAll(transaction, roomRef, state);
  });
  return { ok: true };
});

exports.advanceTournamentBlinds = onSchedule({
  region: REGION,
  schedule: "every 1 minutes",
  timeZone: "Asia/Shanghai",
  retryCount: 1
}, async () => {
  const now = Date.now();
  const due = await db.collection("rooms")
    .where("status", "==", "running")
    .where("nextBlindAt", "<=", Timestamp.fromMillis(now))
    .limit(100)
    .get();
  await Promise.all(due.docs.map(async (roomDoc) => {
    try {
      await db.runTransaction(async (transaction) => {
        const stateRef = roomDoc.ref.collection("server").doc("state");
        const snap = await transaction.get(stateRef);
        if (!snap.exists) return;
        const state = snap.data();
        if (advanceBlindClock(state, now)) syncAll(transaction, roomDoc.ref, state);
      });
    } catch (error) {
      logger.error("Failed to advance blinds", { roomId: roomDoc.id, error });
    }
  }));
});

