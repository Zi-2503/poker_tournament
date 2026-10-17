// 房主端权威牌局引擎：洗牌结果由外部注入（可验证洗牌），其余全部逻辑在此完成。
// 该模块不触碰 DOM 与网络，便于单元测试。

import { formatCards, settlePots } from "./poker.js";

export const PHASE = {
  LOBBY: "lobby",
  PREFLOP: "preflop",
  FLOP: "flop",
  TURN: "turn",
  RIVER: "river",
  HAND_COMPLETE: "hand_complete",
  FINISHED: "finished"
};

export const STATUS = { LOBBY: "lobby", RUNNING: "running", FINISHED: "finished" };

const VALID_ACTIONS = new Set(["CHECK", "CALL", "FOLD", "RAISE", "ALL_IN"]);
const STREET_PAUSE_MS = 1200;

export function initialBlinds(startingChips) {
  const big = Math.max(10, Math.floor(startingChips / 100));
  return { small: Math.max(5, Math.floor(big / 2)), big };
}

function cyclicOrder(order, afterId) {
  if (!order.length) return [];
  const index = order.indexOf(afterId);
  const start = index < 0 ? 0 : (index + 1) % order.length;
  return Array.from({ length: order.length }, (_, offset) => order[(start + offset) % order.length]);
}

export class HostGame {
  constructor({ roomId, hostId, hostSecretHex, hostSecretCommit, settings }) {
    const base = initialBlinds(settings.startingChips);
    this.state = {
      schemaVersion: 2,
      roomId,
      hostId,
      hostSecretHex,        // 仅房主内存持有；对玩家只公开 hostSecretCommit
      hostSecretCommit,
      status: STATUS.LOBBY,
      phase: PHASE.LOBBY,
      settings: { ...settings, maxPlayers: settings.maxPlayers || 9 },
      players: {},
      order: [],
      handNo: 0,
      dealerId: null,
      smallBlindId: null,
      bigBlindId: null,
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
      deckHash: null,
      seedsThisHand: [],
      dealtInIds: [],
      currentBet: 0,
      minRaise: base.big,
      pending: [],
      raiseRights: {},
      toActId: null,
      autoAdvanceAt: null,
      actionSeq: 0,
      lastAction: null,
      eliminations: [],
      rankings: [],
      lastHandResult: null,
      lastHandReveal: null,
      log: [{ handNo: 0, text: "Room created. Waiting for players.", at: Date.now() }],
      updatedAt: Date.now()
    };
  }

  get s() {
    return this.state;
  }

  // ---------- 座位与大厅 ----------

  addPlayer({ playerId, name, publicKey, seedCommit, token, isHost = false, now = Date.now() }) {
    const s = this.s;
    const existing = s.players[playerId];
    if (existing) {
      existing.connected = true;
      existing.publicKey = publicKey || existing.publicKey;
      existing.token = token || existing.token;
      existing.name = name || existing.name;
      existing.lastSeen = now;
      return { ok: true, rejoin: true, player: existing };
    }
    if (s.status !== STATUS.LOBBY) return { ok: false, error: "The tournament has already started." };
    if (s.order.length >= s.settings.maxPlayers) return { ok: false, error: "The room is full." };
    if (Object.values(s.players).some((player) => player.name.toLowerCase() === String(name).toLowerCase())) {
      return { ok: false, error: "That nickname is already taken." };
    }
    s.players[playerId] = {
      id: playerId,
      name,
      seat: s.order.length,
      chips: s.settings.startingChips,
      status: "active",
      connected: true,
      isHost,
      publicKey: publicKey || null,
      seedCommit: seedCommit || null,
      token: token || null,
      dealtIn: false,
      folded: false,
      allIn: false,
      roundBet: 0,
      contributed: 0,
      handStartChips: s.settings.startingChips,
      eliminatedAtHand: null,
      lastSeen: now
    };
    s.order.push(playerId);
    this.log(`${name} joined the room`);
    return { ok: true, player: s.players[playerId] };
  }

  setConnected(playerId, connected, now = Date.now()) {
    const player = this.s.players[playerId];
    if (!player) return;
    player.connected = connected;
    player.lastSeen = now;
  }

  removeFromLobby(playerId) {
    const s = this.s;
    if (s.status !== STATUS.LOBBY || !s.players[playerId]) return;
    delete s.players[playerId];
    s.order = s.order.filter((id) => id !== playerId);
    s.order.forEach((id, index) => { s.players[id].seat = index; });
    this.log(`${playerId.slice(0, 4)}… left the room`);
  }

  canStart() {
    const s = this.s;
    return s.status === STATUS.LOBBY && s.order.length >= 2;
  }

  startTournament(now = Date.now()) {
    const s = this.s;
    if (!this.canStart()) return { ok: false, error: "At least two players are required." };
    s.status = STATUS.RUNNING;
    s.blindLevel = 0;
    s.nextBlindAtMs = now + s.settings.blindLevelMinutes * 60 * 1000;
    this.log(`Tournament started. Blinds ${s.smallBlind}/${s.bigBlind}`);
    return { ok: true, expectSeeds: true };
  }

  /** 比赛结束后原地重开：保留玩家与设置，筹码与状态全部复位。 */
  restart(now = Date.now()) {
    const s = this.s;
    if (s.status !== STATUS.FINISHED) return { ok: false, error: "The tournament has not finished yet." };
    s.handNo = 0;
    s.dealerId = null;
    s.smallBlindId = null;
    s.bigBlindId = null;
    s.board = [];
    s.deck = [];
    s.deckPos = 0;
    s.holeCards = {};
    s.deckHash = null;
    s.seedsThisHand = [];
    s.dealtInIds = [];
    s.currentBet = 0;
    s.minRaise = s.baseBigBlind;
    s.pending = [];
    s.raiseRights = {};
    s.toActId = null;
    s.eliminations = [];
    s.rankings = [];
    s.lastHandResult = null;
    s.lastHandReveal = null;
    s.lastAction = null;
    s.autoAdvanceAt = null;
    s.blindLevel = 0;
    s.smallBlind = s.baseSmallBlind;
    s.bigBlind = s.baseBigBlind;
    s.nextBlindAtMs = now + s.settings.blindLevelMinutes * 60 * 1000;
    s.status = STATUS.RUNNING;
    s.phase = PHASE.LOBBY;
    for (const id of s.order) {
      const player = s.players[id];
      player.chips = s.settings.startingChips;
      player.status = "active";
      player.eliminatedAtHand = null;
      player.dealtIn = false;
      player.folded = false;
      player.allIn = false;
      player.roundBet = 0;
      player.contributed = 0;
      player.handStartChips = player.chips;
    }
    this.log(`New tournament · Blinds ${s.smallBlind}/${s.bigBlind}`);
    return { ok: true };
  }

  // ---------- 手牌生命周期 ----------

  activePlayers() {
    return this.s.order.map((id) => this.s.players[id]).filter((player) => player?.status === "active");
  }

  handPlayers() {
    return this.s.order.map((id) => this.s.players[id]).filter((player) => player?.dealtIn);
  }

  nextActiveId(afterId) {
    return cyclicOrder(this.s.order, afterId).find((id) => this.s.players[id]?.status === "active" && this.s.players[id].chips > 0) || null;
  }

  eligibleToAct(id) {
    const player = this.s.players[id];
    return Boolean(player && player.status === "active" && !player.folded && !player.allIn && player.chips > 0);
  }

  commitChips(player, amount) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > player.chips) throw new Error("Invalid chip amount.");
    player.chips -= amount;
    player.roundBet += amount;
    player.contributed += amount;
    if (player.chips === 0) player.allIn = true;
  }

  log(text) {
    const s = this.s;
    s.log = [...s.log, { handNo: s.handNo, text, at: Date.now() }].slice(-60);
  }

  draw(count) {
    const s = this.s;
    const cards = s.deck.slice(s.deckPos, s.deckPos + count);
    if (cards.length !== count) throw new Error("The deck is empty.");
    s.deckPos += count;
    return cards;
  }

  /** 由房主在收齐玩家种子后调用；deck 必须来自可验证洗牌。 */
  beginHand({ deck, seeds = [], deckHash = null, now = Date.now() }) {
    const s = this.s;
    if (s.status !== STATUS.RUNNING) return { ok: false, error: "The tournament is not running." };
    if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.HAND_COMPLETE) return { ok: false, error: "A new hand cannot start yet." };
    const active = this.activePlayers();
    if (active.length < 2) return { ok: false, error: "Not enough active players." };
    if (deck.length !== 52) return { ok: false, error: "The deck is incomplete." };

    s.handNo += 1;
    s.dealerId = s.dealerId ? this.nextActiveId(s.dealerId) : active[0].id;
    s.deck = deck;
    s.deckHash = deckHash;
    s.seedsThisHand = seeds;
    s.deckPos = 0;
    s.board = [];
    s.holeCards = {};
    s.handSmallBlind = s.smallBlind;
    s.handBigBlind = s.bigBlind;
    s.lastHandReveal = null;

    for (const id of s.order) {
      const player = s.players[id];
      player.dealtIn = player.status === "active" && player.chips > 0;
      player.folded = !player.dealtIn;
      player.allIn = false;
      player.roundBet = 0;
      player.contributed = 0;
      player.handStartChips = player.chips;
      if (player.dealtIn) s.holeCards[id] = [];
    }
    s.dealtInIds = s.order.filter((id) => s.players[id].dealtIn);

    const dealing = cyclicOrder(s.order, s.dealerId).filter((id) => s.players[id].dealtIn);
    for (let round = 0; round < 2; round += 1) {
      for (const id of dealing) s.holeCards[id].push(...this.draw(1));
    }

    const headsUp = active.length === 2;
    s.smallBlindId = headsUp ? s.dealerId : this.nextActiveId(s.dealerId);
    s.bigBlindId = this.nextActiveId(s.smallBlindId);
    this.commitChips(s.players[s.smallBlindId], Math.min(s.handSmallBlind, s.players[s.smallBlindId].chips));
    this.commitChips(s.players[s.bigBlindId], Math.min(s.handBigBlind, s.players[s.bigBlindId].chips));
    // 短码全下的大盲不会降低桌面跟注额，多出的部分会通过单人边池退回。
    s.currentBet = s.handBigBlind;
    s.minRaise = s.handBigBlind;
    s.phase = PHASE.PREFLOP;
    const candidates = cyclicOrder(s.order, s.bigBlindId).filter((id) => this.eligibleToAct(id));
    s.pending = candidates;
    s.raiseRights = Object.fromEntries(candidates.map((id) => [id, true]));
    s.toActId = candidates[0] || null;
    s.updatedAt = now;
    this.log(`Hand ${s.handNo} · ${s.handSmallBlind}/${s.handBigBlind}`);
    this.resolveProgress(now);
    return { ok: true };
  }

  revealStreet(phase) {
    const s = this.s;
    this.draw(1); // 烧牌
    if (phase === PHASE.FLOP) s.board.push(...this.draw(3));
    else s.board.push(...this.draw(1));
    s.phase = phase;
    for (const player of this.handPlayers()) player.roundBet = 0;
    s.currentBet = 0;
    s.minRaise = s.handBigBlind;
    const candidates = cyclicOrder(s.order, s.dealerId).filter((id) => this.eligibleToAct(id));
    s.raiseRights = Object.fromEntries(candidates.map((id) => [id, true]));
    s.pending = candidates.length <= 1 ? [] : candidates;
    s.toActId = candidates[0] || null;
    s.autoAdvanceAt = null;
    if (phase === PHASE.FLOP) this.log(`Flop ${formatCards(s.board.slice(0, 3))}`);
    else if (phase === PHASE.TURN) this.log(`Turn ${formatCards(s.board.slice(3, 4))}`);
    else this.log(`River ${formatCards(s.board.slice(4, 5))}`);
  }

  awardOrder() {
    return cyclicOrder(this.s.order, this.s.dealerId).filter((id) => this.s.players[id]?.dealtIn);
  }

  closeHand({ reason, winners, pots, payouts, showdownCards, evaluations }) {
    const s = this.s;
    s.lastHandResult = {
      handNo: s.handNo,
      reason,
      board: [...s.board],
      pots,
      payouts,
      winners,
      showdownCards,
      evaluations,
      deckHash: s.deckHash,
      completedAt: Date.now()
    };
    s.lastHandReveal = {
      handNo: s.handNo,
      deck: [...s.deck],
      seeds: [...s.seedsThisHand],
      deckHash: s.deckHash,
      dealerId: s.dealerId,
      order: [...s.order],
      dealtInIds: [...s.dealtInIds],
      board: [...s.board],
      holeCardsRevealed: showdownCards,
      hostSecretCommit: s.hostSecretCommit
    };
    if (!this.applyEliminationsAndRanking()) {
      s.phase = PHASE.HAND_COMPLETE;
      s.toActId = null;
      s.pending = [];
    }
    s.updatedAt = Date.now();
  }

  finishFoldedHand(winner) {
    const s = this.s;
    const amount = this.handPlayers().reduce((sum, player) => sum + player.contributed, 0);
    winner.chips += amount;
    this.log(`${winner.name} wins ${amount} · Everyone else folded`);
    this.closeHand({
      reason: "fold",
      winners: [{ id: winner.id, name: winner.name, amount }],
      pots: [{ amount, winners: [winner.id] }],
      payouts: { [winner.id]: amount },
      showdownCards: {},
      evaluations: {}
    });
  }

  finishShowdown() {
    const s = this.s;
    const participants = this.handPlayers();
    const result = settlePots(participants, s.holeCards, s.board, this.awardOrder());
    for (const [id, amount] of Object.entries(result.payouts)) s.players[id].chips += amount;
    const winners = Object.entries(result.payouts)
      .filter(([, amount]) => amount > 0)
      .map(([id, amount]) => ({ id, name: s.players[id].name, amount }));
    const showdownCards = {};
    const evaluations = {};
    for (const player of participants.filter((item) => !item.folded)) {
      showdownCards[player.id] = s.holeCards[player.id];
      evaluations[player.id] = { name: result.evaluations[player.id].name, bestFive: result.evaluations[player.id].cards };
    }
    this.log(`Showdown ${winners.map((winner) => `${winner.name} ${evaluations[winner.id]?.name || ""} +${winner.amount}`).join(", ")}`);
    this.closeHand({
      reason: "showdown",
      winners,
      pots: result.pots.map((pot) => ({ amount: pot.amount, winners: pot.winners })),
      payouts: result.payouts,
      showdownCards,
      evaluations
    });
  }

  applyEliminationsAndRanking() {
    const s = this.s;
    const busted = s.order
      .map((id) => s.players[id])
      .filter((player) => player.status === "active" && player.chips === 0)
      .sort((a, b) => a.handStartChips - b.handStartChips || b.seat - a.seat);
    for (const player of busted) {
      player.status = "eliminated";
      player.eliminatedAtHand = s.handNo;
      s.eliminations.push({ id: player.id, name: player.name, handNo: s.handNo });
      this.log(`${player.name} eliminated`);
    }
    const survivors = this.activePlayers();
    if (survivors.length > 1) return false;
    s.status = STATUS.FINISHED;
    s.phase = PHASE.FINISHED;
    s.toActId = null;
    s.pending = [];
    const rankings = [];
    if (survivors[0]) {
      rankings.push({ rank: 1, id: survivors[0].id, name: survivors[0].name, chips: survivors[0].chips });
    }
    for (const item of [...s.eliminations].reverse()) {
      rankings.push({ rank: rankings.length + 1, id: item.id, name: item.name, chips: 0 });
    }
    s.rankings = rankings;
    this.log(survivors[0] ? `${survivors[0].name} wins the tournament` : "Tournament finished");
    return true;
  }

  /** 一轮行动结束后自动推进：发牌街、摊牌、淘汰与结束。 */
  /** 一轮下注结束后先停一拍，让最后一次跟注/全下看得清，再发下一条街。 */
  resolveProgress(now = Date.now()) {
    const s = this.s;
    for (let guard = 0; guard < 12; guard += 1) {
      const remaining = this.handPlayers().filter((player) => !player.folded);
      if (remaining.length === 1) {
        this.finishFoldedHand(remaining[0]);
        return;
      }
      s.pending = (s.pending || []).filter((id) => this.eligibleToAct(id));
      if (s.pending.length > 0) {
        s.toActId = s.pending[0];
        s.autoAdvanceAt = null;
        return;
      }
      s.toActId = null;
      if (!s.autoAdvanceAt) {
        s.autoAdvanceAt = now + STREET_PAUSE_MS;
        return;
      }
      if (now < s.autoAdvanceAt) return;
      s.autoAdvanceAt = null;
      if (s.phase === PHASE.RIVER) {
        this.finishShowdown();
        return;
      }
      if (s.phase === PHASE.PREFLOP) this.revealStreet(PHASE.FLOP);
      else if (s.phase === PHASE.FLOP) this.revealStreet(PHASE.TURN);
      else if (s.phase === PHASE.TURN) this.revealStreet(PHASE.RIVER);
      else return;
    }
  }

  applyAction(playerId, action, amount, now = Date.now()) {
    const s = this.s;
    const normalized = String(action || "").toUpperCase();
    if (!VALID_ACTIONS.has(normalized)) return { ok: false, error: "Unknown action." };
    if (s.status !== STATUS.RUNNING) return { ok: false, error: "The tournament is not running." };
    const player = s.players[playerId];
    if (!player) return { ok: false, error: "You are not in this room." };
    if (s.toActId !== playerId || s.pending?.[0] !== playerId) return { ok: false, error: "It is not your turn." };
    if (!this.eligibleToAct(playerId)) return { ok: false, error: "You cannot act right now." };

    const toCall = Math.max(0, s.currentBet - player.roundBet);
    const previousPending = [...s.pending];
    let raised = false;
    let fullRaise = false;
    let target = player.roundBet;
    let actionAmount = 0;

    if (normalized === "FOLD") {
      player.folded = true;
      s.raiseRights[playerId] = false;
      this.log(`${player.name} folds`);
    } else if (normalized === "CHECK") {
      if (toCall !== 0) return { ok: false, error: `Call ${toCall} or fold; you cannot check.` };
      s.raiseRights[playerId] = false;
      this.log(`${player.name} checks`);
    } else if (normalized === "CALL") {
      if (toCall === 0) return { ok: false, error: "Nothing to call. Please check." };
      const paid = Math.min(toCall, player.chips);
      this.commitChips(player, paid);
      actionAmount = paid;
      s.raiseRights[playerId] = false;
      this.log(`${player.name} ${paid < toCall ? "all-in" : "calls"} ${paid}`);
    } else {
      if (normalized === "ALL_IN") target = player.roundBet + player.chips;
      else {
        target = Number(amount);
        if (!Number.isSafeInteger(target) || target <= 0) return { ok: false, error: "Invalid raise amount." };
      }
      const maximum = player.roundBet + player.chips;
      if (target > maximum) return { ok: false, error: "Not enough chips." };
      if (target <= player.roundBet) return { ok: false, error: "The bet must increase." };

      if (target <= s.currentBet) {
        if (normalized !== "ALL_IN" || target !== maximum) return { ok: false, error: "Raise above the current bet." };
        this.commitChips(player, target - player.roundBet);
        actionAmount = target;
        s.raiseRights[playerId] = false;
        this.log(`${player.name} all-in ${target}`);
      } else {
        if (!s.raiseRights[playerId]) return { ok: false, error: "A short all-in does not reopen raising." };
        const raiseSize = target - s.currentBet;
        const isAllIn = target === maximum;
        if (raiseSize < s.minRaise && !isAllIn) return { ok: false, error: `Minimum raise to ${s.currentBet + s.minRaise}` };
        this.commitChips(player, target - player.roundBet);
        actionAmount = target;
        raised = true;
        fullRaise = raiseSize >= s.minRaise;
        s.currentBet = target;
        if (fullRaise) s.minRaise = raiseSize;
        s.raiseRights[playerId] = false;
        this.log(`${player.name} ${isAllIn ? "all-in" : "raises to"} ${target}`);
      }
    }

    if (raised && fullRaise) {
      const candidates = cyclicOrder(s.order, playerId).filter((id) => id !== playerId && this.eligibleToAct(id));
      s.pending = candidates;
      for (const id of candidates) s.raiseRights[id] = true;
    } else if (raised) {
      const stillPending = new Set(previousPending.slice(1));
      s.pending = cyclicOrder(s.order, playerId).filter((id) =>
        id !== playerId && this.eligibleToAct(id) && (stillPending.has(id) || s.players[id].roundBet < s.currentBet));
    } else {
      s.pending = previousPending.slice(1);
    }

    s.actionSeq += 1;
    s.lastAction = { handNo: s.handNo, seq: s.actionSeq, playerId, type: normalized, amount: actionAmount, at: Date.now() };
    this.resolveProgress(now);
    s.updatedAt = Date.now();
    return { ok: true };
  }

  // ---------- 升盲 ----------

  tick(nowMs = Date.now()) {
    const s = this.s;
    if (s.status !== STATUS.RUNNING) return false;
    let changed = false;
    if (s.nextBlindAtMs && nowMs >= s.nextBlindAtMs) {
      const durationMs = s.settings.blindLevelMinutes * 60 * 1000;
      const steps = Math.floor((nowMs - s.nextBlindAtMs) / durationMs) + 1;
      s.blindLevel += steps;
      const multiplier = 2 ** Math.min(s.blindLevel, 30);
      s.smallBlind = Math.min(Number.MAX_SAFE_INTEGER, s.baseSmallBlind * multiplier);
      s.bigBlind = Math.min(Number.MAX_SAFE_INTEGER, s.baseBigBlind * multiplier);
      s.nextBlindAtMs += steps * durationMs;
      this.log(`Blinds increased to ${s.smallBlind}/${s.bigBlind}`);
      changed = true;
    }
    if (s.autoAdvanceAt && nowMs >= s.autoAdvanceAt) {
      this.resolveProgress(nowMs);
      changed = true;
    }
    return changed;
  }

  // ---------- 对外数据 ----------

  privateCards(playerId) {
    return {
      handNo: this.s.handNo,
      cards: this.s.holeCards?.[playerId] || []
    };
  }

  publicState() {
    const s = this.s;
    const pot = this.handPlayers().reduce((sum, player) => sum + (player.contributed || 0), 0);
    return {
      roomId: s.roomId,
      hostId: s.hostId,
      status: s.status,
      phase: s.phase,
      handNo: s.handNo,
      settings: s.settings,
      board: [...s.board],
      pot,
      currentBet: s.currentBet,
      minRaise: s.minRaise,
      toActId: s.toActId,
      dealerId: s.dealerId,
      smallBlindId: s.smallBlindId,
      bigBlindId: s.bigBlindId,
      blinds: { level: s.blindLevel, small: s.smallBlind, big: s.bigBlind },
      nextBlindAtMs: s.nextBlindAtMs,
      order: [...s.order],
      players: s.order.map((id) => {
        const player = s.players[id];
        return {
          id: player.id,
          name: player.name,
          seat: player.seat,
          chips: player.chips,
          status: player.status,
          connected: player.connected,
          isHost: player.isHost || player.id === s.hostId,
          dealtIn: Boolean(player.dealtIn),
          folded: player.folded,
          allIn: player.allIn,
          roundBet: player.roundBet,
          contributed: player.contributed,
          eliminatedAtHand: player.eliminatedAtHand
        };
      }),
      lastHandResult: s.lastHandResult,
      lastAction: s.lastAction,
      rankings: s.rankings,
      log: s.log,
      handCommit: s.deckHash ? { handNo: s.handNo, deckHash: s.deckHash } : null,
      hostSecretCommit: s.hostSecretCommit,
      seedCommits: Object.fromEntries(Object.values(s.players).filter((player) => player.seedCommit).map((player) => [player.id, player.seedCommit])),
    };
  }

  handReveal() {
    return this.s.lastHandReveal;
  }

  /** 房主本地存档：用于刷新页面后恢复同一房间。 */
  snapshot() {
    return this.s;
  }

  static restore(state) {
    const game = new HostGame({
      roomId: state.roomId,
      hostId: state.hostId,
      hostSecretHex: state.hostSecretHex,
      hostSecretCommit: state.hostSecretCommit,
      settings: state.settings
    });
    game.state = state;
    for (const player of Object.values(state.players)) player.connected = false;
    return game;
  }
}
