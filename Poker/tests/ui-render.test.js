import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

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
    log: [{ handNo: 1, text: "Flop 7♣ 8♦ 9♠", at: Date.now() }],
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

test("大厅显示座位与开局按钮", () => {
  ui.renderTable(context(baseState({ status: "lobby", phase: "lobby", handNo: 0, toActId: null, pot: 0 }), { myCards: [] }));
  assert.match(seats(), /小明/);
  assert.match(seats(), /阿强/);
  assert.equal(document.getElementById("roomLabel").textContent, "ABC234");
  assert.equal(document.getElementById("blindInfo").classList.contains("hidden"), true);
  assert.equal(document.getElementById("lobbyPanel").classList.contains("hidden"), false);
  assert.equal(document.getElementById("startButton").classList.contains("hidden"), false);
  assert.equal(document.getElementById("actions").classList.contains("hidden"), true);
});

test("开局后左上角显示等级与升盲时间，悬停内容为房间号", () => {
  ui.renderTable(context(baseState()));
  assert.equal(document.getElementById("roomLabel").classList.contains("hidden"), true);
  assert.equal(document.getElementById("blindInfo").classList.contains("hidden"), false);
  assert.equal(document.getElementById("blindLevel").textContent, "Lv. 1");
  assert.equal(document.getElementById("handText").textContent, "Hand 1");
  assert.match(document.getElementById("blindTimer").textContent, /^Blinds up 1:00$/);
  assert.equal(document.getElementById("copyRoom").title, "Room ABC234");
  assert.equal(document.getElementById("roomTooltip").textContent, "Room ABC234");
});

test("牌面十点显示为 T", () => {
  assert.match(ui.cardHtml("TH"), /class="rank">T</);
  assert.doesNotMatch(ui.cardHtml("TH"), />10</);
  assert.equal(ui.cardText("TS"), "T♠");
});

test("底牌显示在自己的座位上并带发牌动画", () => {
  ui.renderTable(context(baseState(), { myCards: [] }));
  ui.renderTable(context(baseState()));
  assert.match(seats(), /card small deal/, "自己的底牌应播放发牌动画");
  assert.match(seats(), /♣/, "自己的底牌显示在座位图标内");
  assert.equal(document.getElementById("blindText").textContent, "5 / 10");
  assert.match(document.getElementById("log").innerHTML, /7♣/);
});

test("行动条常驻，非本人回合只是禁用", () => {
  ui.renderTable(context(baseState({ players: [{ ...players[0], roundBet: 0 }, { ...players[1], roundBet: 10 }] })));
  assert.equal(document.getElementById("actions").classList.contains("hidden"), false);
  assert.equal(document.getElementById("checkCall").textContent, "Call 10");
  assert.equal(document.getElementById("checkCall").dataset.action, "CALL");

  ui.renderTable(context(baseState({ toActId: "p2" })));
  assert.equal(document.getElementById("actions").classList.contains("hidden"), false, "不是自己的回合也要保留行动条");
  assert.equal(document.getElementById("actionHint").textContent, "");

  ui.renderTable(context(baseState({ status: "lobby", phase: "lobby" })));
  assert.equal(document.getElementById("actions").classList.contains("hidden"), true);
});

test("有人弃牌时播放弃牌动画，公共牌逐张翻开", () => {
  const alive = baseState({ players: [{ ...players[0] }, { ...players[1], folded: false }] });
  ui.renderTable(context(alive));
  const folded = baseState({ players: [{ ...players[0] }, { ...players[1], folded: true }] });
  ui.renderTable(context(folded));
  assert.match(seats(), /discard/, "弃牌应播放飞牌动画");
  assert.match(seats(), /class="seat folded"/, "弃牌玩家座位应变暗");

  ui.renderTable(context(baseState({ board: [] })));
  ui.renderTable(context(baseState({ board: ["7C", "8D", "9S"] })));
  assert.match(document.getElementById("board").innerHTML, /card new/, "新发出的公共牌应有翻牌动画");
});

test("有人下注时筹码飞向筹码堆", () => {
  ui.renderTable(context(baseState({ players: [{ ...players[0] }, { ...players[1], roundBet: 0 }] })));
  ui.renderTable(context(baseState({ players: [{ ...players[0] }, { ...players[1], roundBet: 120 }] })));
  assert.match(seats(), /bet fly/, "新增下注应播放筹码动画");
});

test("弃牌直接结束这一手时依然有飞牌动画", () => {
  ui.renderTable(context(baseState({ players: [{ ...players[0] }, { ...players[1], folded: false }] })));
  ui.renderTable(context(baseState({
    phase: "hand_complete",
    players: [{ ...players[0], chips: 1100 }, { ...players[1], folded: true }],
    lastHandResult: {
      handNo: 1,
      reason: "fold",
      board: [],
      pots: [{ amount: 40, winners: ["p1"] }],
      payouts: { p1: 40, p2: 0 },
      winners: [{ id: "p1", name: "小明", amount: 40 }],
      showdownCards: {},
      evaluations: {}
    }
  })));
  assert.match(seats(), /discard/);
});

test("全下玩家座位变红", () => {
  ui.renderTable(context(baseState({ players: [{ ...players[0] }, { ...players[1], allIn: true, roundBet: 900 }] })));
  assert.match(seats(), /class="seat allin"/);
});

test("自己弃牌后不再显示自己的底牌", () => {
  const alive = baseState({ players: [{ ...players[0], folded: false }, { ...players[1], folded: false }] });
  ui.renderTable(context(alive));
  assert.match(seats(), /<span class="rank">2<\/span>/, "弃牌前能看到自己的底牌");

  const folded = baseState({ players: [{ ...players[0], folded: true }, { ...players[1], folded: false }] });
  ui.renderTable(context(folded));
  assert.match(seats(), /discard/, "弃牌瞬间应有飞牌动画");

  ui.renderTable(context(folded));
  assert.doesNotMatch(seats(), /<span class="rank">2<\/span>/, "弃牌后自己的底牌不应回到原位");
});

test("行动权交给下一位玩家时有到位动画", () => {
  ui.renderTable(context(baseState({ toActId: "p1" })));
  ui.renderTable(context(baseState({ toActId: "p2" })));
  assert.match(seats(), /arrive/);
});

test("座位上不再显示跟注之类的文字气泡", () => {
  ui.renderTable(context(baseState({ lastAction: { handNo: 1, seq: 5, playerId: "p2", type: "CALL", amount: 50 } })));
  assert.doesNotMatch(seats(), /class="act"/);
  assert.doesNotMatch(seats(), /跟注 50/);
});

test("结束后房主可以再开一局，玩家只有离开房间", () => {
  const finished = baseState({
    status: "finished",
    phase: "finished",
    toActId: null,
    rankings: [{ rank: 1, id: "p1", name: "小明", chips: 2000 }]
  });
  ui.renderTable(context(finished));
  assert.equal(document.getElementById("gameOver").classList.contains("hidden"), false);
  assert.equal(document.getElementById("playAgain").classList.contains("hidden"), false);

  ui.renderTable(context(finished, { role: "player" }));
  assert.equal(document.getElementById("gameOver").classList.contains("hidden"), false);
  assert.equal(document.getElementById("playAgain").classList.contains("hidden"), true);
  assert.equal(document.getElementById("actions").classList.contains("hidden"), true);
});

test("摊牌时公开对手底牌，退场结束才显示下一手", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const showdownState = baseState({
    handNo: 3,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    lastHandResult: {
      handNo: 3,
      reason: "showdown",
      board: ["7C", "8D", "9S", "4H", "5D"],
      pots: [{ amount: 200, winners: ["p2"] }],
      payouts: { p1: 0, p2: 200 },
      winners: [{ id: "p2", name: "阿强", amount: 200 }],
      showdownCards: { p2: ["AS", "AH"] },
      evaluations: { p2: { name: "一对" } }
    }
  });
  ui.renderTable(context(showdownState));
  assert.match(seats(), /♠/);
  assert.match(seats(), /class="chips win">\+200</, "赢家筹码位先显示赢取额");

  const nextHand = { ...showdownState, handNo: 4, phase: "preflop", board: [], toActId: "p1" };
  ui.renderTable(context(nextHand));
  assert.match(seats(), /card small clear/, "旧底牌先退场");
  t.mock.timers.tick(850);
  assert.doesNotMatch(seats(), /♠/, "进入下一手后不应残留上一手的底牌");
  assert.doesNotMatch(seats(), /♥/);
});

test("新一轮下注开始时旧的下注额会演出退场动画", () => {
  const betting = baseState({ players: [{ ...players[0], roundBet: 200 }, { ...players[1], roundBet: 0 }] });
  ui.renderTable(context(betting));
  assert.match(seats(), /class="bet fly"/);

  const cleared = baseState({ players: [{ ...players[0], roundBet: 0, chips: 1300 }, { ...players[1], roundBet: 0 }] });
  ui.renderTable(context(cleared));
  assert.match(seats(), /class="bet clear"/, "下注额应滑向底池后淡出");
});

test("进入下一手时公共牌与底池演出复位动画", () => {
  const finished = baseState({
    handNo: 6,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    pot: 400
  });
  ui.renderTable(context(finished));
  assert.match(document.getElementById("board").innerHTML, /card/);

  const next = baseState({ handNo: 7, phase: "preflop", board: [], pot: 0 });
  ui.renderTable(context(next));
  assert.match(document.getElementById("board").innerHTML, /card[^"]*clear/, "旧公共牌应淡出");
  assert.match(document.getElementById("pot").className ?? "", /clear|pop|^$/, "底池应播放复位动画");
});

test("摊牌时有公共牌闪光、公开底牌强调与赢家高亮", () => {
  const state = baseState({
    handNo: 40,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    lastHandResult: {
      handNo: 40,
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
  assert.equal(document.getElementById("board").classList.contains("showdown"), true, "公共牌应有摊牌闪光");
  assert.match(seats(), /class="card small[^"]*shown/, "公开的底牌应带强调描边");
  assert.match(seats(), /class="seat winner"/, "赢家座位应高亮");
});

test("淘汰玩家在结算展示期间不变暗，退场后才变暗", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const state = baseState({
    handNo: 50,
    phase: "hand_complete",
    players: [{ ...players[0], chips: 2400 }, { ...players[1], status: "eliminated", chips: 0 }],
    lastHandResult: {
      handNo: 50,
      reason: "showdown",
      board: ["7C", "8D", "9S", "4H", "5D"],
      pots: [{ amount: 200, winners: ["p1"] }],
      payouts: { p1: 200, p2: 0 },
      winners: [{ id: "p1", name: "小明", amount: 200 }],
      showdownCards: { p2: ["AS", "AH"] },
      evaluations: { p2: { name: "一对" } }
    }
  });
  ui.renderTable(context(state));
  assert.doesNotMatch(seats(), /class="seat[^"]*out/, "结算展示时淘汰玩家不应被变暗");
  assert.match(seats(), /class="card small[^"]*shown/, "淘汰玩家的摊牌底牌仍然可见");

  ui.renderTable(context({ ...state, handNo: 51, phase: "preflop", board: [], lastHandResult: null }));
  t.mock.timers.tick(850);
  assert.match(seats(), /class="seat[^"]*out/, "下一手开始时淘汰玩家才变暗");
});

test("最终排名只在锦标赛结束时出现", () => {
  const finished = baseState({
    status: "finished",
    phase: "finished",
    toActId: null,
    rankings: [
      { rank: 1, id: "p1", name: "小明", chips: 2400 },
      { rank: 2, id: "p2", name: "阿强", chips: 0 }
    ]
  });
  ui.renderTable(context(finished));
  assert.equal(document.getElementById("rankPanel").classList.contains("hidden"), false);
  assert.match(document.getElementById("rankings").innerHTML, /阿强/);
});

test("房主离线时显示提示条", () => {
  ui.renderTable(context(baseState(), { hostOnline: false }));
  assert.equal(document.getElementById("hostAlert").classList.contains("hidden"), false);
  ui.renderTable(context(baseState(), { hostOnline: true }));
  assert.equal(document.getElementById("hostAlert").classList.contains("hidden"), true);
});

test("摊牌翻牌动画只播一次，状态重播时不再闪", () => {
  const showdownState = baseState({
    handNo: 9,
    phase: "hand_complete",
    board: ["7C", "8D", "9S", "4H", "5D"],
    lastHandResult: {
      handNo: 9,
      reason: "showdown",
      board: ["7C", "8D", "9S", "4H", "5D"],
      pots: [{ amount: 200, winners: ["p2"] }],
      payouts: { p1: 0, p2: 200 },
      winners: [{ id: "p2", name: "阿强", amount: 200 }],
      showdownCards: { p2: ["AS", "AH"] },
      evaluations: { p2: { name: "一对" } }
    }
  });
  ui.renderTable(context(showdownState));
  assert.match(seats(), /card small new/, "第一次公开底牌应有翻牌动画");
  assert.equal(
    (seats().match(/class="card small[^"]*\bnew\b[^"]*"/g) || []).length,
    2,
    "只翻对手的两张牌"
  );
  const mySeatCards = seats().match(/<div class="mini-cards"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.doesNotMatch(mySeatCards, /\bnew\b/, "自己的牌在摊牌时不翻");
  ui.renderTable(context(showdownState));
  assert.doesNotMatch(seats(), /card small new/, "重复渲染不应再次播放翻牌动画");
});
