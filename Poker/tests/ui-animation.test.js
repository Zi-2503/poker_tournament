import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// 时序动画测试单独放一个文件：每个测试文件跑在独立进程里，模块状态不会互相干扰。
const store = new Map();
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    value: "",
    min: 0,
    max: 0,
    disabled: false,
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    },
    querySelectorAll: () => [],
    querySelector: () => null
  };
}
globalThis.document = {
  getElementById(id) {
    if (!store.has(id)) store.set(id, makeElement(id));
    return store.get(id);
  }
};
globalThis.location = { search: "", protocol: "http:" };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = await import("../js/ui.js");
beforeEach(() => ui.__resetUiState());

const players = [
  { id: "p1", name: "小明", seat: 0, chips: 1500, status: "active", connected: true, isHost: true, folded: false, allIn: false, roundBet: 0, contributed: 0, dealtIn: true, eliminatedAtHand: null },
  { id: "p2", name: "阿强", seat: 1, chips: 900, status: "active", connected: true, isHost: false, folded: false, allIn: false, roundBet: 0, contributed: 0, dealtIn: true, eliminatedAtHand: null }
];

function baseState(overrides = {}) {
  return {
    roomId: "ABC234",
    hostId: "p1",
    status: "running",
    phase: "preflop",
    handNo: 1,
    settings: { startingChips: 1000, blindLevelMinutes: 10, maxPlayers: 9 },
    board: [],
    pot: 20,
    currentBet: 10,
    minRaise: 10,
    toActId: "p1",
    dealerId: "p1",
    smallBlindId: "p1",
    bigBlindId: "p2",
    blinds: { level: 0, small: 5, big: 10 },
    nextBlindAtMs: Date.now() + 60000,
    order: ["p1", "p2"],
    players,
    lastHandResult: null,
    rankings: [],
    log: [],
    ...overrides
  };
}

const context = (state, extra = {}) => ({
  state,
  myId: "p1",
  myCards: ["2C", "3C"],
  role: "host",
  hostOnline: true,
  roomCode: "ABC234",
  ...extra
});

const seats = () => document.getElementById("seats").innerHTML;
const board = () => document.getElementById("board").innerHTML;

test("整场结束保留最后摊牌，不播放退场动画", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const state = baseState({
    status: "finished", phase: "finished", toActId: null,
    board: ["7C", "8D", "9S", "4H", "5D"],
    players: [{ ...players[0], chips: 2400 }, { ...players[1], chips: 0, status: "eliminated", allIn: true }],
    lastHandResult: { handNo: 1, payouts: { p1: 200 }, showdownCards: { p2: ["AS", "AH"] } }
  });
  ui.renderTable(context(state));
  t.mock.timers.tick(2400);
  assert.doesNotMatch(board(), /card[^"]*clear/);
  assert.doesNotMatch(seats(), /card small[^"]*clear/);
  t.mock.timers.tick(4000);
  assert.equal((board().match(/class="card(?: |")/g) || []).length, 5);
  assert.equal((seats().match(/class="card small/g) || []).length, 4);
  assert.doesNotMatch(seats(), /class="seat[^"]*out/, "最后摊牌的淘汰玩家仍然可见");
  ui.renderTable(context(state));
  assert.doesNotMatch(board(), /clear/, "重复广播也不会触发退场");
  ui.renderTable(context(baseState({ handNo: 0, phase: "lobby" }), { myCards: [] }));
  assert.doesNotMatch(board(), /clear|class="card /, "重开时直接复位，不补播退场");
});

test("公共牌五个占位与底池在结算退场期间始终保留", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  ui.renderTable(context(baseState({
    phase: "hand_complete", toActId: null,
    board: ["7C", "8D", "9S", "4H", "5D"],
    lastHandResult: { handNo: 1, payouts: { p1: 200 }, showdownCards: {} }
  })));
  const slotCount = () => (board().match(/class="card-slot"/g) || []).length;
  assert.equal(slotCount(), 5);
  t.mock.timers.tick(2400);
  assert.equal(slotCount(), 5);
  assert.match(board(), /card[^"]*clear/, "只有牌面退场，占位保持");
  assert.equal(document.getElementById("pot").classList.contains("clear"), false);
  t.mock.timers.tick(650);
  assert.equal(slotCount(), 5);
  assert.equal(document.getElementById("potText").textContent, "0");
  assert.equal(document.getElementById("pot").classList.contains("clear"), false);
});

test("下一手大小盲比上一手下注少时也飞入，所有玩家分两轮发牌", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  ui.renderTable(context(baseState({
    phase: "hand_complete", toActId: null,
    players: players.map((p) => ({ ...p, roundBet: 500 })),
    lastHandResult: { handNo: 1, payouts: { p1: 1000 }, showdownCards: {} }
  })));
  t.mock.timers.tick(2400);
  t.mock.timers.tick(650);
  const next = baseState({ handNo: 2, players: [{ ...players[0], roundBet: 5 }, { ...players[1], roundBet: 10 }] });
  ui.renderTable(context(next));
  assert.equal((seats().match(/class="bet fly"/g) || []).length, 2, "两个盲注都播放下注动画");
  assert.equal((seats().match(/class="card small[^"]*deal/g) || []).length, 4, "自己的牌和对手牌背都发牌");
  assert.match(seats(), /animation-delay:220ms/);
  assert.match(seats(), /animation-delay:350ms/);
  assert.match(seats(), /back deal/);
  ui.renderTable(context(next));
  assert.doesNotMatch(seats(), /back deal/, "普通更新不发起新的发牌动画");
});

test("退场在结算阶段完成，下一手不会再淡出上一手公共牌", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const state = baseState({
    phase: "hand_complete", toActId: null,
    board: ["7C", "8D", "9S", "4H", "5D"],
    lastHandResult: { handNo: 1, payouts: { p1: 200 }, showdownCards: { p2: ["AS", "AH"] } }
  });
  ui.renderTable(context(state));
  t.mock.timers.tick(2400);
  t.mock.timers.tick(650);
  ui.renderTable(context(baseState({ handNo: 2 })));
  assert.match(seats(), /card small deal/);
  assert.doesNotMatch(board(), /clear|class="card /);
  assert.doesNotMatch(seats(), /small[^"]*clear/);
});

test("错过退场定时器后直接收到新一手，也不会复活旧牌", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  ui.renderTable(context(baseState({
    board: ["7C", "8D", "9S", "4H", "5D"],
    lastHandResult: { handNo: 1, payouts: { p1: 200 }, showdownCards: {} }
  })));
  t.mock.timers.setTime(110000);
  ui.renderTable(context(baseState({ handNo: 2 })));
  assert.match(seats(), /card small deal/);
  assert.doesNotMatch(board(), /clear|class="card /);
});
test("换手时先演旧牌退场，复位结束后才发新牌", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  ui.renderTable(context(baseState({
    handNo: 30,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    pot: 400
  }), { myCards: ["AS", "KH"] }));

  const next = baseState({ handNo: 31, phase: "preflop", board: [], pot: 0 });
  ui.renderTable(context(next));
  assert.match(board(), /clear/, "旧公共牌先退场");
  assert.doesNotMatch(seats(), /card small deal/, "复位动画期间不播发牌动画");

  ui.renderTable(context(next));
  assert.doesNotMatch(seats(), /card small deal/, "窗口内再次重绘也不应提前发牌");

  t.mock.timers.tick(850);
  assert.match(seats(), /card small deal/, "复位结束后才发新底牌");
  assert.match(board(), /card-slot/, "复位后牌面清空");
});

test("复位动画在窗口内重绘时保留原来的节点内容", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const ended = baseState({
    handNo: 60,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    pot: 400,
    players: [{ ...players[0], roundBet: 200 }, { ...players[1], roundBet: 0 }]
  });
  ui.renderTable(context(ended));

  const next = baseState({ handNo: 61, phase: "preflop", board: [], pot: 0 });
  ui.renderTable(context(next));
  assert.match(board(), /clear/, "第一次应播放退场动画");
  assert.match(seats(), /bet[^"]*clear/, "下注额第一次应播放退场动画");

  ui.renderTable(context(next));
  assert.match(board(), /clear/, "重绘不应中断正在退场的公共牌");
  assert.match(seats(), /bet[^"]*clear/, "重绘不应中断正在退场的下注额");
});

test("结算后筹码量先被 +金额 取代，再淡回新的筹码量", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const state = baseState({
    handNo: 11,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    players: [{ ...players[0], chips: 1500 }, { ...players[1], chips: 900 }],
    lastHandResult: {
      handNo: 11,
      reason: "showdown",
      board: ["7C", "8D", "9S", "4H", "5D"],
      pots: [{ amount: 200, winners: ["p2"] }],
      payouts: { p1: 0, p2: 200 },
      winners: [{ id: "p2", name: "阿强", amount: 200 }],
      showdownCards: { p2: ["AS", "AH"] },
      evaluations: { p2: { name: "一对" } }
    }
  });
  ui.renderTable(context(state));
  assert.match(seats(), /chips win">\+200</, "先用 +金额 取代筹码量");
  assert.match(seats(), /chips">1,500</, "其他玩家的筹码量不受影响");

  t.mock.timers.tick(1300);
  assert.match(seats(), /chips restore/, "随后筹码量淡回");
  assert.match(seats(), /chips restore">900</, "显示的是结算后的新筹码量");
});
