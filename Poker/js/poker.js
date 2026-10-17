// 纯前端牌局数学：牌型判定、7 选 5、主池与边池结算。
// 这个模块不依赖 DOM / 网络，可在浏览器与 Node 测试中同时使用。

export const RANKS = "23456789TJQKA";
export const SUITS = "CDHS";
export const HAND_NAMES = ["High Card", "One Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", "Straight Flush"];

const RANK_LABEL = { T: "T" };
const SUIT_LABEL = { C: "♣", D: "♦", H: "♥", S: "♠" };

export function formatCard(card) {
  return `${RANK_LABEL[card[0]] || card[0]}${SUIT_LABEL[card[1]] || ""}`;
}

export function formatCards(cards) {
  return cards.map(formatCard).join(" ");
}

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  return deck;
}

export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

export function compareScore(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function evaluateFive(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error("evaluateFive requires exactly 5 cards.");
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map((card) => card[1]);
  const flush = suits.every((suit) => suit === suits[0]);
  const unique = [...new Set(values)];
  let straightHigh = 0;
  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0];
  if (unique.join(",") === "14,5,4,3,2") straightHigh = 5;

  const countMap = new Map();
  for (const value of values) countMap.set(value, (countMap.get(value) || 0) + 1);
  const groups = [...countMap.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let score;
  if (flush && straightHigh) score = [8, straightHigh];
  else if (groups[0][1] === 4) score = [7, groups[0][0], groups[1][0]];
  else if (groups[0][1] === 3 && groups[1][1] === 2) score = [6, groups[0][0], groups[1][0]];
  else if (flush) score = [5, ...values];
  else if (straightHigh) score = [4, straightHigh];
  else if (groups[0][1] === 3) score = [3, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  else if (groups[0][1] === 2 && groups[1][1] === 2) score = [2, groups[0][0], groups[1][0], groups[2][0]];
  else if (groups[0][1] === 2) score = [1, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  else score = [0, ...values];

  return { score, category: score[0], name: HAND_NAMES[score[0]], cards: [...cards] };
}

export function bestOfSeven(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new Error("Expected 5 to 7 cards.");
  let best = null;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const candidate = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScore(candidate.score, best.score) > 0) best = candidate;
          }
        }
      }
    }
  }
  return best;
}

/**
 * 构建主池与边池并返回派彩。
 * 弃牌玩家的筹码留在池中，但只有未弃牌的出资者能赢取对应层级。
 */
export function settlePots(players, holeCards, board, awardOrder) {
  const contributors = players.filter((player) => player.contributed > 0);
  const levels = [...new Set(contributors.map((player) => player.contributed))].sort((a, b) => a - b);
  const evaluations = {};
  for (const player of contributors.filter((item) => !item.folded)) {
    evaluations[player.id] = bestOfSeven([...(holeCards[player.id] || []), ...board]);
  }

  const payouts = Object.fromEntries(players.map((player) => [player.id, 0]));
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const layer = contributors.filter((player) => player.contributed >= level);
    const amount = (level - previous) * layer.length;
    previous = level;
    if (amount <= 0) continue;
    const eligible = layer.filter((player) => !player.folded);
    if (eligible.length === 0) throw new Error("No eligible player can win this pot.");
    let winners = [eligible[0]];
    for (const player of eligible.slice(1)) {
      const comparison = compareScore(evaluations[player.id].score, evaluations[winners[0].id].score);
      if (comparison > 0) winners = [player];
      else if (comparison === 0) winners.push(player);
    }
    winners.sort((a, b) => awardOrder.indexOf(a.id) - awardOrder.indexOf(b.id));
    const share = Math.floor(amount / winners.length);
    let remainder = amount % winners.length;
    for (const winner of winners) {
      payouts[winner.id] += share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
    pots.push({ amount, eligible: eligible.map((player) => player.id), winners: winners.map((player) => player.id) });
  }
  return { payouts, pots, evaluations };
}
