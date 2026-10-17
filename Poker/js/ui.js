const $ = (id) => document.getElementById(id);

const SUIT_LABEL = { C: "♣", D: "♦", H: "♥", S: "♠" };
const RED_SUITS = new Set(["D", "H"]);
const CARD_IN_TEXT = /^(10|[2-9TJQKA])[♣♦♥♠]$/;

const view = {
  handNo: -1,
  board: 0,
  pot: 0,
  myKey: "",
  toAct: null,
  revealHand: -1,
  awardHand: -1,
  awardShownAt: 0,
  awardPhase: "",
  boardCards: [],
  clearBets: new Map(),
  clearUntil: 0,
  exitAt: 0,
  exitDone: false,
  pendingCtx: null,
  hadCards: false,
  restoreUntil: 0,
  bets: new Map(),
  folded: new Map(),
  dealt: new Set()
};

let seatScale = 1;
let rerenderTimer = null;

const CLEAR_MS = 560;
const BET_CLEAR_MS = 460;
const AWARD_PLUS_MS = 1200;
const RESULT_HOLD_MS = 2400;
const EXIT_MS = 650;

function scheduleRerender(delay) {
  if (rerenderTimer) clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    rerenderTimer = null;
    if (view.pendingCtx && Date.now() >= view.exitAt + EXIT_MS) {
      const next = view.pendingCtx;
      view.pendingCtx = null;
      view.exitDone = true;
      renderTable(next);
    } else if (view.lastCtx) renderTable(view.lastCtx);
  }, Math.max(40, Math.round(delay)));
  rerenderTimer?.unref?.();
}

/** 仅供测试使用：把渲染层的记忆状态清空，避免用例之间互相影响。 */
export function __resetUiState() {
  if (rerenderTimer) clearTimeout(rerenderTimer);
  rerenderTimer = null;
  Object.assign(view, {
    handNo: -1,
    board: 0,
    pot: 0,
    myKey: "",
    toAct: null,
    revealHand: -1,
    awardHand: -1,
    awardShownAt: 0,
    awardPhase: "",
    boardCards: [],
    clearBets: new Map(),
    clearUntil: 0,
    exitAt: 0,
    exitDone: false,
    pendingCtx: null,
    hadCards: false,
    restoreUntil: 0,
    bets: new Map(),
    folded: new Map(),
    dealt: new Set(),
    lastCtx: null
  });
}

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]
));

export const money = (value) => Number(value || 0).toLocaleString("en-US");

export function cardText(card) {
  return card ? `${card[0]}${SUIT_LABEL[card[1]] || ""}` : "";
}

export function cardHtml(card, options = {}) {
  const classes = ["card"];
  if (options.small) classes.push("small");
  if (card && RED_SUITS.has(card[1])) classes.push("red");
  if (!card) classes.push("back");
  if (options.animation) classes.push(options.animation);
  if (options.shown) classes.push("shown");

  const style = [];
  if (options.delay) style.push(`animation-delay:${options.delay}ms`);
  if (options.dx !== undefined) style.push(`--dx:${options.dx}px`);
  if (options.dy !== undefined) style.push(`--dy:${options.dy}px`);

  const rank = card ? card[0] : "";
  const suit = card ? (SUIT_LABEL[card[1]] || "") : "";
  return `<span class="${classes.join(" ")}"${style.length ? ` style="${style.join(";")}"` : ""}>` +
    `<span class="rank">${rank}</span><span class="pip">${suit}</span></span>`;
}

function logLineHtml(entry) {
  const words = String(entry.text || "").split(" ").map((word) => {
    if (!CARD_IN_TEXT.test(word)) return escapeHtml(word);
    const red = word.includes("♥") || word.includes("♦");
    return `<span class="cards"${red ? ' style="color:#f4708b"' : ""}>${escapeHtml(word.replace(/^10/, "T"))}</span>`;
  });
  return `<p><span class="no">${entry.handNo || 0}</span><span>${words.join(" ")}</span></p>`;
}

/** 采样椭圆弧长，把座位均匀铺在桌沿上，避免角度均匀导致左右两侧挤在一起。 */
function ellipseAngles(count, rx, ry, width, height) {
  const samples = 720;
  const a = rx * width;
  const b = ry * height;
  const lengths = [0];
  let previous = { x: a, y: 0 };
  for (let i = 1; i <= samples; i += 1) {
    const t = (i / samples) * Math.PI * 2;
    const point = { x: a * Math.cos(t), y: b * Math.sin(t) };
    lengths.push(lengths[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }
  const total = lengths[samples];
  const angles = [];
  for (let k = 0; k < count; k += 1) {
    const target = (k / count) * total;
    let low = 0;
    let high = samples;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (lengths[mid] < target) low = mid + 1;
      else high = mid;
    }
    // θ 从右侧 0 开始，加 90° 让第一名（自己）落在正下方
    angles.push((low / samples) * Math.PI * 2 + Math.PI / 2);
  }
  return angles;
}

function layoutSeats(area, count) {
  if (!area || !area.width || !area.height) return seatScale;
  const rx = 0.40;
  const ry = 0.36;
  const total = Math.max(count, 2);
  const angles = ellipseAngles(total, rx, ry, area.width, area.height);
  const gap = 14;
  let limit = 1.6;
  for (let k = 0; k < total; k += 1) {
    const a = angles[k];
    const b = angles[(k + 1) % total];
    const dx = Math.abs(Math.cos(a) - Math.cos(b)) * rx * area.width;
    const dy = Math.abs(Math.sin(a) - Math.sin(b)) * ry * area.height;
    limit = Math.min(limit, Math.max((dx - gap) / 196, (dy - gap) / 106));
  }
  const inside = Math.min((0.1 * area.width) / 98, (0.14 * area.height) / 53);
  seatScale = Number(Math.max(0.5, Math.min(1, limit, inside)).toFixed(3));
  document.documentElement.style.setProperty("--seat-scale", String(seatScale));
  return seatScale;
}

function seatGeometry(angle, scale) {
  const theta = angle;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const safeCos = Math.max(Math.abs(cos), 0.001);
  const safeSin = Math.max(Math.abs(sin), 0.001);
  const betRadius = Math.min((98 * scale + 20) / safeCos, (53 * scale + 16) / safeSin);
  return {
    left: 50 + 40 * cos,
    top: 50 + 36 * sin,
    dx: -cos * 130,
    dy: -sin * 115,
    bx: -cos * betRadius,
    by: -sin * betRadius
  };
}

export function toast(message, bad = false) {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast${bad ? " bad" : ""}`;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.className = "toast hidden"; }, 4000);
}

export function setScreen(name) {
  for (const id of ["boot", "lobby", "table"]) {
    const node = $(id);
    if (node) node.classList.toggle("hidden", id !== name);
  }
}

export function setBusy(form, busy) {
  form.querySelectorAll("button, input").forEach((node) => { node.disabled = busy; });
}

export function fillJoinCodeFromUrl() {
  const code = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
  if (code) $("joinForm").elements.roomCode.value = code;
  const saved = localStorage.getItem("riverguard:lastName");
  if (saved) {
    $("createForm").elements.nickname.value = saved;
    $("joinForm").elements.nickname.value = saved;
  }
}

export function rememberName(name) {
  try { localStorage.setItem("riverguard:lastName", name); } catch { /* 忽略 */ }
}

export function updateBlindTimer(state, clockOffset = 0) {
  const node = $("blindTimer");
  if (!node) return;
  if (state?.status === "finished") { node.textContent = "Finished"; return; }
  if (!state?.nextBlindAtMs || state.status !== "running") { node.textContent = ""; return; }
  const seconds = Math.max(0, Math.ceil((state.nextBlindAtMs - (Date.now() + clockOffset)) / 1000));
  node.textContent = `Blinds up ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// 保留已有节点，避免心跳、筹码更新或重绘重启/打断 CSS 动画。
function updateMarkup(parent, markup) {
  if (parent._markup === markup) return;
  parent._markup = markup;
  if (!document.createElement) { parent.innerHTML = markup; return; }
  const template = document.createElement("template");
  template.innerHTML = markup;
  const sync = (target, source) => {
    if (target.nodeType === 3) {
      if (target.data !== source.data) target.data = source.data;
      return;
    }
    const stable = source.getAttribute("data-view-key");
    if (stable && target.getAttribute("data-view-key") === stable) return;
    for (const attr of [...target.attributes]) {
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    }
    for (const attr of source.attributes) {
      if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    }
    syncChildren(target, source);
  };
  const syncChildren = (target, source) => {
    const keyed = new Map([...target.children].filter((node) => node.dataset.playerId)
      .map((node) => [node.dataset.playerId, node]));
    const incoming = [...source.childNodes];
    incoming.forEach((next, index) => {
      const key = next.nodeType === 1 ? next.dataset.playerId : null;
      const match = key ? keyed.get(key) : target.childNodes[index];
      if (key && match && target.childNodes[index] !== match) target.insertBefore(match, target.childNodes[index] || null);
      const current = target.childNodes[index];
      if (!current) target.append(next.cloneNode(true));
      else if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName ||
        (key && current.dataset.playerId !== key) || (next.nodeType === 1 && next.dataset.viewKey &&
          next.dataset.viewKey !== current.dataset.viewKey)) current.replaceWith(next.cloneNode(true));
      else sync(current, next);
    });
    while (target.childNodes.length > incoming.length) target.lastChild.remove();
  };
  syncChildren(parent, template.content);
}

export function renderTable(ctx) {
  const { state, myId, myCards, role, hostOnline, roomCode } = ctx;
  if (!state) return;

  const now = Date.now();
  const handChanged = view.handNo >= 0 && state.handNo !== view.handNo;
  if (view.exitAt && now >= view.exitAt + EXIT_MS) view.exitDone = true;
  // 极慢客户端若错过结算定时器，先完成旧牌退场，再展示已收到的新手牌。
  if (handChanged && view.handNo > 0 && view.lastCtx?.state.status !== "finished" && !view.exitDone && (view.boardCards.length || view.hadCards)) {
    view.pendingCtx = ctx;
    if (!view.exitAt || view.exitAt > now) view.exitAt = now;
    renderTable(view.lastCtx);
    return;
  }
  if (handChanged) {
    view.pendingCtx = null;
    view.exitAt = 0;
    view.exitDone = false;
    view.hadCards = false;
    view.clearUntil = 0;
    view.clearBets = new Map();
    view.dealt = new Set();
    view.board = 0;
    view.awardPhase = "";
    view.awardHand = -1;
    view.revealHand = -1;
    view.restoreUntil = 0;
  }

  const blinds = state.blinds || { small: 0, big: 0 };
  const started = state.status !== "lobby";
  $("roomLabel").textContent = started ? "" : roomCode;
  $("roomLabel").classList.toggle("hidden", started);
  $("blindInfo").classList.toggle("hidden", !started);
  $("copyRoom").classList.toggle("started", started);
  $("copyRoom").title = `Room ${roomCode}`;
  $("roomTooltip").textContent = `Room ${roomCode}`;
  $("blindLevel").textContent = `Lv. ${Number(blinds.level || 0) + 1}`;
  $("handText").textContent = state.handNo > 0 ? `Hand ${state.handNo}` : "";
  $("blindText").textContent = `${money(blinds.small)} / ${money(blinds.big)}`;
  updateBlindTimer(state, ctx.clockOffset || 0);

  const players = state.players || [];
  const result = state.lastHandResult && state.lastHandResult.handNo === state.handNo ? state.lastHandResult : null;
  const showdown = result?.showdownCards || {};
  const payouts = result?.payouts || {};

  const myKey = `${state.handNo}|${(myCards || []).join(",")}`;
  const revealAnimate = Boolean(result) && view.revealHand !== result.handNo;

  // 结算时先把筹码量换成 +赢取额，再淡回新的筹码量
  if (result && result.handNo !== view.awardHand) {
    view.awardHand = result.handNo;
    view.awardShownAt = now;
    view.awardPhase = "plus";
    view.exitAt = state.status === "finished" ? 0 : now + RESULT_HOLD_MS;
  }
  if (state.status === "finished") {
    view.exitAt = 0;
    view.exitDone = false;
  }
  const plusPhase = Boolean(result) && now - view.awardShownAt < AWARD_PLUS_MS;
  const restoreChips = !plusPhase && view.awardPhase === "plus";
  if (restoreChips) {
    view.awardPhase = "chips";
    view.restoreUntil = now + CLEAR_MS;
  }
  const restoringChips = !plusPhase && now < view.restoreUntil;

  const exiting = view.exitAt > 0 && now >= view.exitAt && now < view.exitAt + EXIT_MS;
  if (view.exitAt > 0 && now >= view.exitAt + EXIT_MS) view.exitDone = true;
  const betsCleared = !handChanged
    && players.some((player) => (player.roundBet || 0) === 0 && (view.bets.get(player.id) ?? 0) > 0);
  if (betsCleared) {
    view.clearBets = new Map(view.bets);
    view.clearUntil = now + BET_CLEAR_MS;
  }
  const clearing = now < view.clearUntil;
  const dealMine = myKey !== view.myKey && (myCards || []).length > 0 && !result && !exiting;

  // 统一按最近的截止时间重绘：既要收掉退场动画，也要在 +金额 之后切回筹码量
  const deadlines = [];
  if (clearing) deadlines.push(view.clearUntil + 40);
  if (plusPhase) deadlines.push(view.awardShownAt + AWARD_PLUS_MS + 60);
  if (view.exitAt && now < view.exitAt) deadlines.push(view.exitAt);
  if (exiting) deadlines.push(view.exitAt + EXIT_MS);
  if (deadlines.length) scheduleRerender(Math.min(...deadlines) - now);

  const myIndex = Math.max(0, players.findIndex((player) => player.id === myId));
  const rotated = [...players.slice(myIndex), ...players.slice(0, myIndex)];
  const areaNode = $("tableArea");
  const area = typeof areaNode?.getBoundingClientRect === "function" ? areaNode.getBoundingClientRect() : null;
  const scale = layoutSeats(area, rotated.length);
  const angles = ellipseAngles(Math.max(rotated.length, 2), 0.40, 0.36, area?.width || 1, area?.height || 1);
  const openingHand = state.status === "running" && state.phase === "preflop" && !result;
  const dealerIndex = players.findIndex((player) => player.id === state.dealerId);
  const dealingOrder = [...players.slice(dealerIndex + 1), ...players.slice(0, dealerIndex + 1)]
    .filter((player) => player.dealtIn).map((player) => player.id);

  updateMarkup($("seats"), rotated.map((player, index) => {
    const pos = seatGeometry(angles[index] ?? Math.PI / 2, scale);
    const isMe = player.id === myId;
    const revealed = showdown[player.id];
    const bet = player.roundBet || 0;
    const postingBlinds = openingHand && (handChanged || view.handNo < 0 || view.handNo === 0);
    const betFlies = bet > 0 && (postingBlinds || bet > (view.bets.get(player.id) ?? 0));
    const displayBet = view.exitDone ? 0 : bet > 0 ? bet : (clearing ? (view.clearBets.get(player.id) ?? 0) : 0);
    const betClearing = exiting || (bet === 0 && displayBet > 0);
    const foldedNow = Boolean(player.folded) && state.status === "running";
    const justFolded = foldedNow && view.folded.get(player.id) === false;
    const wonAmount = Number(payouts[player.id] || 0);
    const wonNow = Boolean(result) && wonAmount > 0 && !exiting && !view.exitDone;
    const showsBacks = player.dealtIn && !revealed && (!player.folded || justFolded);
    const cards = view.exitDone ? [] : isMe
      ? (player.folded && !justFolded ? [] : (myCards || []))
      : (revealed || (showsBacks ? [null, null] : []));
    const arriving = Boolean(state.toActId) && state.toActId !== view.toAct && state.toActId === player.id;
    const dealPlayer = openingHand && cards.length > 0 && !view.dealt.has(player.id);

    const classes = ["seat"];
    if (state.toActId === player.id) classes.push("turn");
    if (arriving) classes.push("arrive");
    if (isMe) classes.push("me");
    // 结算展示期间不要把人变暗，否则摊牌动画看不出来
    if (player.status === "eliminated" && (!result || view.exitDone || (!player.dealtIn && !revealed))) classes.push("out");
    else if (foldedNow) classes.push("folded");
    if (player.allIn && !view.exitDone) classes.push("allin");
    if (wonNow) classes.push("winner");

    const cardsHtml = cards.map((card, cardIndex) => {
      if (exiting) return cardHtml(card, { small: true, animation: "clear", delay: cardIndex * 60 });
      if (justFolded) return cardHtml(card, { small: true, animation: "discard", delay: cardIndex * 60, dx: pos.dx, dy: pos.dy });
      if (revealed && !isMe) return cardHtml(card, { small: true, shown: true, animation: revealAnimate ? "new" : "", delay: revealAnimate ? cardIndex * 110 : 0 });
      if (dealPlayer || (isMe && dealMine)) return cardHtml(card, { small: true, animation: "deal",
        delay: 220 + (cardIndex * dealingOrder.length + Math.max(0, dealingOrder.indexOf(player.id))) * 65, dx: pos.dx, dy: pos.dy });
      return cardHtml(card, { small: true });
    }).join("");

    const betHtml = displayBet > 0
      ? `<span class="bet${betFlies ? " fly" : ""}${betClearing ? " clear" : ""}" data-view-key="${state.handNo}|${displayBet}|${betClearing ? "clear" : "bet"}" style="--bx:${pos.bx}px;--by:${pos.by}px${postingBlinds && player.id === state.bigBlindId ? ";animation-delay:130ms" : ""}">${money(displayBet)}</span>`
      : "";
    const chipsHtml = plusPhase && wonAmount > 0
      ? `<div class="chips win">+${money(wonAmount)}</div>`
      : `<div class="chips${restoringChips ? " restore" : ""}">${money(player.chips)}</div>`;
    const cardsKey = `${state.handNo}|${cards.join(",")}|${cards.length}|${exiting ? "exit" : justFolded ? "fold" : revealed ? "shown" : "dealt"}`;
    if (cards.length && !result) view.dealt.add(player.id);
    return `<div data-player-id="${escapeHtml(player.id)}" class="${classes.join(" ")}" style="left:${pos.left}%;top:${pos.top}%;--dx:${pos.dx}px;--dy:${pos.dy}px">
      ${state.dealerId === player.id ? '<span class="dealer-chip">D</span>' : ""}
      <div class="who">
        <div class="avatar">${escapeHtml((player.name || "?").slice(0, 1))}</div>
        <div class="name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</div>
        ${chipsHtml}
      </div>
      <div class="mini-cards" data-view-key="${cardsKey}">${cardsHtml}</div>
      ${betHtml}
    </div>`;
  }).join(""));

  const board = state.board || [];
  const shownBoard = view.exitDone ? [] : board;
  $("board").classList.toggle("showdown", Boolean(result) && !exiting && !view.exitDone);
  updateMarkup($("board"), Array.from({ length: 5 }, (_, index) => {
    const card = shownBoard[index];
    if (!card) return '<span class="card-slot"></span>';
    const isNew = index >= view.board;
    return `<span class="card-slot"><span class="board-card" data-view-key="${state.handNo}|${card}|${exiting ? "exit" : "board"}">${cardHtml(card, {
      animation: exiting ? "clear" : isNew ? "new" : "", delay: exiting ? index * 45 : isNew ? (index - view.board) * 120 : 0
    })}</span></span>`;
  }).join(""));

  const pot = Number(state.pot || 0);
  $("potText").textContent = money(view.exitDone ? 0 : pot);
  $("pot").classList.toggle("pop", pot > view.pot && view.pot > 0);
  $("potText").classList.toggle("reset", exiting);

  $("log").innerHTML = [...(state.log || [])].reverse().map(logLineHtml).join("");

  $("lobbyPanel").classList.toggle("hidden", state.status !== "lobby");
  $("seatCount").textContent = `${players.length} / ${state.settings?.maxPlayers || 9}`;
  $("startButton").classList.toggle("hidden", role !== "host");
  $("startButton").disabled = players.length < 2;

  const me = players.find((player) => player.id === myId);
  const inTournament = state.status === "running" && me && me.status === "active";
  const myTurn = state.status === "running" && state.toActId === myId && me && !me.folded && !me.allIn;
  $("actions").classList.toggle("hidden", !inTournament);
  $("actions").querySelectorAll("button, input").forEach((node) => { node.disabled = !myTurn; });
  if (myTurn) {
    const toCall = Math.max(0, (state.currentBet || 0) - (me.roundBet || 0));
    const checkCall = $("checkCall");
    checkCall.dataset.action = toCall ? "CALL" : "CHECK";
    checkCall.textContent = toCall ? `Call ${money(Math.min(toCall, me.chips))}` : "Check";
    const maximum = (me.roundBet || 0) + me.chips;
    const minimum = Math.min((state.currentBet || 0) + (state.minRaise || blinds.big), maximum);
    const input = $("raiseInput");
    input.min = minimum;
    input.max = maximum;
    if (!input.value || Number(input.value) < minimum || Number(input.value) > maximum) input.value = minimum;
    $("actionHint").textContent = `${money(minimum)} – ${money(maximum)}`;
  } else {
    $("actionHint").textContent = "";
  }

  const rankings = state.rankings || [];
  $("rankPanel").classList.toggle("hidden", rankings.length === 0);
  $("rankings").innerHTML = rankings.map((entry) =>
    `<div class="rank-row"><span><b>${entry.rank}</b>${escapeHtml(entry.name)}</span><span style="color:var(--gold)">${money(entry.chips)}</span></div>`).join("");

  $("hostAlert").classList.toggle("hidden", hostOnline !== false);
  $("gameOver").classList.toggle("hidden", state.status !== "finished");
  $("playAgain").classList.toggle("hidden", role !== "host");

  view.handNo = state.handNo;
  view.board = board.length;
  view.boardCards = [...board];
  view.pot = pot;
  view.myKey = myKey;
  view.hadCards = !view.exitDone && ((myCards || []).length > 0 || players.some((player) => player.dealtIn));
  view.toAct = state.toActId || null;
  if (result) view.revealHand = result.handNo;
  view.lastCtx = ctx;
  for (const player of players) {
    view.bets.set(player.id, player.roundBet || 0);
    view.folded.set(player.id, Boolean(player.folded));
  }
}

if (typeof addEventListener === "function") {
  let resizeTimer = null;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view.lastCtx) renderTable(view.lastCtx); }, 150);
  });
}
