"use strict";

const crypto = require("crypto");

const RANKS = "23456789TJQKA";
const SUITS = "CDHS";
const HAND_NAMES = [
  "高牌", "一对", "两对", "三条", "顺子",
  "同花", "葫芦", "四条", "同花顺"
];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  return deck;
}

function secureShuffle(cards) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

function compareScore(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function evaluateFive(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error("evaluateFive requires exactly five cards");
  }
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
  if (flush && straightHigh) {
    score = [8, straightHigh];
  } else if (groups[0][1] === 4) {
    score = [7, groups[0][0], groups[1][0]];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    score = [6, groups[0][0], groups[1][0]];
  } else if (flush) {
    score = [5, ...values];
  } else if (straightHigh) {
    score = [4, straightHigh];
  } else if (groups[0][1] === 3) {
    score = [3, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    score = [2, ...pairs, groups[2][0]];
  } else if (groups[0][1] === 2) {
    score = [1, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  } else {
    score = [0, ...values];
  }
  return { score, category: score[0], name: HAND_NAMES[score[0]], cards: [...cards] };
}

function bestOfSeven(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error("bestOfSeven requires five to seven cards");
  }
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
 * Builds main/side pots and returns chip payouts. Folded chips remain in pots,
 * while only non-folded contributors at each threshold can win that layer.
 */
function settlePots(players, holeCards, board, awardOrder) {
  const contributors = players.filter((player) => player.contributed > 0);
  const levels = [...new Set(contributors.map((player) => player.contributed))].sort((a, b) => a - b);
  const evaluations = {};
  for (const player of contributors.filter((item) => !item.folded)) {
    evaluations[player.uid] = bestOfSeven([...(holeCards[player.uid] || []), ...board]);
  }

  const payouts = Object.fromEntries(players.map((player) => [player.uid, 0]));
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const layerPlayers = contributors.filter((player) => player.contributed >= level);
    const amount = (level - previous) * layerPlayers.length;
    previous = level;
    if (amount <= 0) continue;
    const eligible = layerPlayers.filter((player) => !player.folded);
    if (eligible.length === 0) throw new Error("Pot has no eligible winner");
    let winners = [eligible[0]];
    for (const player of eligible.slice(1)) {
      const comparison = compareScore(evaluations[player.uid].score, evaluations[winners[0].uid].score);
      if (comparison > 0) winners = [player];
      else if (comparison === 0) winners.push(player);
    }
    winners.sort((a, b) => awardOrder.indexOf(a.uid) - awardOrder.indexOf(b.uid));
    const share = Math.floor(amount / winners.length);
    let remainder = amount % winners.length;
    for (const winner of winners) {
      payouts[winner.uid] += share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
    pots.push({
      amount,
      eligible: eligible.map((player) => player.uid),
      winners: winners.map((player) => player.uid)
    });
  }
  return { payouts, pots, evaluations };
}

module.exports = {
  HAND_NAMES,
  bestOfSeven,
  compareScore,
  createDeck,
  evaluateFive,
  secureShuffle,
  settlePots
};
