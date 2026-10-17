import test from "node:test";
import assert from "node:assert/strict";
import { HostGame, PHASE, STATUS } from "../js/engine.js";

const SETTINGS = { startingChips: 1000, blindLevelMinutes: 10, maxPlayers: 9 };
const START = 2_000_000;

/** 受控时钟：一轮下注结束后引擎要等一拍才发下一条街。 */
let clock = START;
const resetClock = () => { clock = START; };
const act = (game, id, action, amount) => game.applyAction(id, action, amount, clock);
const forward = (game, ms = 1500) => { clock += ms; return game.tick(clock); };

/** 轮流让能行动的玩家跟注/过牌，并在需要时推进发牌节奏。 */
function playOut(game, limit = 60) {
  for (let i = 0; i < limit; i += 1) {
    if (game.s.phase === PHASE.HAND_COMPLETE || game.s.status === STATUS.FINISHED) return;
    const actor = game.s.toActId;
    if (!actor) { forward(game); continue; }
    const toCall = game.s.currentBet - game.s.players[actor].roundBet;
    assert.equal(act(game, actor, toCall > 0 ? "CALL" : "CHECK", undefined).ok, true);
  }
}

function makeGame(players) {
  resetClock();
  const game = new HostGame({
    roomId: "TEST01",
    hostId: players[0].id,
    hostSecretHex: "a".repeat(64),
    hostSecretCommit: "commit",
    settings: SETTINGS
  });
  players.forEach((player) => {
    const result = game.addPlayer({ playerId: player.id, name: player.name, publicKey: `pk-${player.id}` });
    assert.equal(result.ok, true);
    if (player.chips !== undefined) game.s.players[player.id].chips = player.chips;
  });
  return game;
}

/**
 * 构造可控牌堆。底牌必须按引擎真实的发牌顺序排列：
 * 第一轮按行动顺序各发一张，第二轮再各发一张；
 * 随后是 烧牌 + 翻牌三张 + 烧牌 + 转牌 + 烧牌 + 河牌。
 */
function craftDeck({ holeByPlayer, board, dealing, burns = ["2H", "3H", "4D"] }) {
  const cards = [];
  for (const id of dealing) cards.push(holeByPlayer[id][0]);
  for (const id of dealing) cards.push(holeByPlayer[id][1]);
  cards.push(burns[0], board[0], board[1], board[2], burns[1], board[3], burns[2], board[4]);
  const used = new Set(cards);
  for (const suit of "CDHS") {
    for (const rank of "23456789TJQKA") {
      const card = `${rank}${suit}`;
      if (!used.has(card)) cards.push(card);
    }
  }
  assert.equal(cards.length, 52);
  assert.equal(new Set(cards).size, 52);
  return cards;
}

function deal(game, holeByPlayer, board, dealing) {
  return game.beginHand({ deck: craftDeck({ holeByPlayer, board, dealing }), seeds: [], deckHash: "h", now: clock });
}

test("大厅需要至少两名玩家才能开局", () => {
  const game = makeGame([{ id: "a", name: "A" }]);
  assert.equal(game.canStart(), false);
  assert.equal(game.startTournament(clock).ok, false);
});

test("三人桌完成翻牌前到摊牌的完整流程", () => {
  const game = makeGame([
    { id: "a", name: "Alice" },
    { id: "b", name: "Bob" },
    { id: "c", name: "Cara" }
  ]);
  assert.equal(game.startTournament(clock).ok, true);

  const board = ["7C", "8D", "9S", "4H", "5D"];
  assert.equal(deal(game, { a: ["AS", "AH"], b: ["KC", "KD"], c: ["2C", "3C"] }, board, ["b", "c", "a"]).ok, true);

  assert.equal(game.s.dealerId, "a");
  assert.equal(game.s.smallBlindId, "b");
  assert.equal(game.s.bigBlindId, "c");
  assert.equal(game.s.toActId, "a");
  assert.deepEqual(game.privateCards("a").cards, ["AS", "AH"]);
  assert.deepEqual(game.privateCards("c").cards, ["2C", "3C"]);

  assert.equal(act(game, "a", "CALL", undefined).ok, true);
  assert.deepEqual(
    { type: game.s.lastAction.type, amount: game.s.lastAction.amount, playerId: game.s.lastAction.playerId },
    { type: "CALL", amount: 10, playerId: "a" }
  );
  assert.equal(act(game, "b", "CALL", undefined).ok, true);
  assert.equal(act(game, "c", "CHECK", undefined).ok, true);
  assert.equal(game.s.phase, PHASE.PREFLOP, "下注结束后要等一拍才发翻牌");
  assert.equal(game.publicState().lastAction.playerId, "c");
  assert.equal(game.s.players.b.roundBet, 10, "跟注的筹码量在下一条街发出前仍然显示");
  assert.equal(game.publicState().pot, 30);

  forward(game);
  assert.equal(game.s.phase, PHASE.FLOP);
  assert.deepEqual(game.s.board, ["7C", "8D", "9S"]);
  assert.equal(game.s.players.b.roundBet, 0, "发下一条街后本轮下注清零");

  for (const id of ["b", "c", "a"]) assert.equal(act(game, id, "CHECK", undefined).ok, true);
  forward(game);
  assert.equal(game.s.phase, PHASE.TURN);
  assert.deepEqual(game.s.board, ["7C", "8D", "9S", "4H"]);
  for (const id of ["b", "c", "a"]) assert.equal(act(game, id, "CHECK", undefined).ok, true);
  forward(game);
  assert.equal(game.s.phase, PHASE.RIVER);
  for (const id of ["b", "c", "a"]) assert.equal(act(game, id, "CHECK", undefined).ok, true);
  forward(game);

  assert.equal(game.s.phase, PHASE.HAND_COMPLETE);
  assert.equal(game.s.lastHandResult.reason, "showdown");
  assert.equal(game.s.players.a.chips, 1020);
  assert.equal(game.s.players.b.chips, 990);
  assert.equal(game.s.players.c.chips, 990);
  assert.deepEqual(game.s.lastHandResult.showdownCards.a, ["AS", "AH"]);
  assert.equal(game.s.lastHandResult.evaluations.a.name, "One Pair");
  assert.equal(game.s.lastHandResult.pots[0].amount, 30);
});

test("非法动作会被拒绝且不改变状态", () => {
  const game = makeGame([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  game.startTournament(clock);
  deal(game, { a: ["AS", "AH"], b: ["2C", "3C"] }, ["7C", "8D", "9S", "4H", "5D"], ["b", "a"]);

  const before = JSON.stringify(game.publicState());
  assert.equal(act(game, "b", "FOLD", undefined).ok, false);
  assert.equal(act(game, "a", "CHECK", undefined).ok, false);
  assert.equal(act(game, "a", "RAISE", 12).ok, false);
  assert.equal(act(game, "a", "RAISE", 5).ok, false);
  assert.equal(JSON.stringify(game.publicState()), before);

  assert.equal(act(game, "a", "CALL", undefined).ok, true);
  assert.notEqual(JSON.stringify(game.publicState()), before);
});

test("三人不同筹码全下时生成主池与边池", () => {
  const game = makeGame([
    { id: "a", name: "Short", chips: 100 },
    { id: "b", name: "Mid" },
    { id: "c", name: "Big" }
  ]);
  game.startTournament(clock);
  deal(game, { a: ["AS", "AD"], b: ["KS", "KD"], c: ["QS", "QD"] }, ["2C", "3D", "7H", "8S", "9C"], ["b", "c", "a"]);

  assert.equal(act(game, "a", "ALL_IN", undefined).ok, true);
  assert.equal(act(game, "b", "CALL", undefined).ok, true);
  assert.equal(act(game, "c", "CALL", undefined).ok, true);
  forward(game);
  assert.equal(game.s.phase, PHASE.FLOP);

  for (let street = 0; street < 2; street += 1) {
    for (const id of ["b", "c"]) assert.equal(act(game, id, "CHECK", undefined).ok, true);
    if (street === 1) break;
    forward(game);
  }
  forward(game);
  assert.equal(game.s.phase, PHASE.RIVER);
  assert.equal(act(game, "b", "RAISE", 50).ok, true);
  assert.equal(act(game, "c", "CALL", undefined).ok, true);
  forward(game);

  const result = game.s.lastHandResult;
  assert.equal(result.reason, "showdown");
  assert.deepEqual(result.pots.map((pot) => pot.amount), [300, 100]);
  assert.equal(game.s.players.a.chips, 300);
  assert.equal(game.s.players.b.chips, 950);
  assert.equal(game.s.players.c.chips, 850);
  assert.deepEqual(result.pots[1].winners, ["b"]);
});

test("全下后按翻牌、转牌、河牌逐条街发出", () => {
  const game = makeGame([
    { id: "a", name: "Short", chips: 100 },
    { id: "b", name: "Mid", chips: 100 },
    { id: "c", name: "Big" },
    { id: "d", name: "Huge" }
  ]);
  game.startTournament(clock);
  deal(game, {
    a: ["AS", "AD"], b: ["QS", "QD"], c: ["KS", "KD"], d: ["JS", "JD"]
  }, ["2C", "3D", "7H", "8S", "9C"], ["b", "c", "d", "a"]);

  assert.equal(game.s.toActId, "d");
  act(game, "d", "ALL_IN", undefined);
  act(game, "a", "ALL_IN", undefined);
  act(game, "b", "ALL_IN", undefined);
  act(game, "c", "CALL", undefined);
  assert.equal(game.s.board.length, 0, "全下后不应一次性发完公共牌");

  forward(game);
  assert.equal(game.s.board.length, 3, "第一拍只发翻牌");
  assert.equal(game.s.phase, PHASE.FLOP);
  forward(game);
  assert.equal(game.s.board.length, 4, "第二拍只发转牌");
  forward(game);
  assert.equal(game.s.board.length, 5, "第三拍才发河牌");
  forward(game);
  assert.equal(game.s.phase, PHASE.HAND_COMPLETE);
  assert.equal(game.s.status, STATUS.RUNNING, "仍有两人存活，比赛继续");
});

test("筹码耗尽的玩家被淘汰并记录顺序", () => {
  const game = makeGame([
    { id: "a", name: "Short", chips: 100 },
    { id: "b", name: "Mid" },
    { id: "c", name: "Big" }
  ]);
  game.startTournament(clock);
  deal(game, { a: ["QS", "QD"], b: ["AS", "AD"], c: ["KS", "KD"] }, ["2C", "3D", "7H", "8S", "9C"], ["b", "c", "a"]);
  act(game, "a", "ALL_IN", undefined);
  act(game, "b", "CALL", undefined);
  act(game, "c", "CALL", undefined);
  playOut(game);

  assert.equal(game.s.players.a.status, "eliminated");
  assert.equal(game.s.eliminations.length, 1);
  assert.equal(game.s.eliminations[0].name, "Short");
  assert.equal(game.s.status, STATUS.RUNNING);
  assert.equal(game.s.rankings.length, 0);
});

test("只剩一名玩家时锦标赛结束并生成排名", () => {
  const game = makeGame([
    { id: "a", name: "Short", chips: 100 },
    { id: "b", name: "Big" }
  ]);
  game.startTournament(clock);
  deal(game, { a: ["KS", "KD"], b: ["AS", "AD"] }, ["2C", "3D", "7H", "8S", "9C"], ["b", "a"]);
  act(game, "a", "ALL_IN", undefined);
  act(game, "b", "CALL", undefined);
  playOut(game);

  assert.equal(game.s.status, STATUS.FINISHED);
  assert.equal(game.s.phase, PHASE.FINISHED);
  assert.deepEqual(game.s.rankings.map((entry) => entry.name), ["Big", "Short"]);
  assert.equal(game.s.rankings[0].chips, 1100);
  assert.equal(game.s.rankings[1].chips, 0);
});

test("盲注按设定时间自动升级", () => {
  const game = makeGame([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  game.startTournament(START);
  assert.equal(game.s.smallBlind, 5);
  assert.equal(game.s.bigBlind, 10);

  const next = START + 10 * 60 * 1000;
  assert.equal(game.tick(next), true);
  assert.equal(game.s.smallBlind, 10);
  assert.equal(game.s.bigBlind, 20);
  assert.equal(game.tick(next + 1000), false);

  assert.equal(game.tick(START + 31 * 60 * 1000), true);
  assert.equal(game.s.smallBlind, 40);
  assert.equal(game.s.bigBlind, 80);
  assert.equal(game.s.blindLevel, 3);
});

test("比赛结束后可以原地重开，筹码与排名复位", () => {
  const game = makeGame([
    { id: "a", name: "Short", chips: 100 },
    { id: "b", name: "Big" }
  ]);
  game.startTournament(clock);
  assert.equal(game.restart(clock).ok, false, "比赛进行中不能重开");

  deal(game, { a: ["KS", "KD"], b: ["AS", "AD"] }, ["2C", "3D", "7H", "8S", "9C"], ["b", "a"]);
  act(game, "a", "ALL_IN", undefined);
  act(game, "b", "CALL", undefined);
  playOut(game);
  assert.equal(game.s.status, STATUS.FINISHED);

  assert.equal(game.restart(clock).ok, true);
  assert.equal(game.s.status, STATUS.RUNNING);
  assert.equal(game.s.handNo, 0);
  assert.equal(game.s.rankings.length, 0);
  assert.equal(game.s.eliminations.length, 0);
  assert.equal(game.s.lastHandResult, null);
  assert.equal(game.s.autoAdvanceAt, null);
  assert.equal(game.s.players.a.chips, 1000);
  assert.equal(game.s.players.b.chips, 1000);
  assert.equal(game.s.players.a.status, "active");
  assert.equal(game.s.smallBlind, 5);
});
