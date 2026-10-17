// 可验证洗牌：房主密钥在开房时即公开承诺，玩家种子在加入时先承诺后揭示，
// 因此房主既无法中途换牌堆，也无法预知玩家提供的随机源。

import { createDeck } from "./poker.js";
import { hmacSha256, sha256Hex, fromHex, utf8 } from "./crypto.js";

const UINT32 = 0x100000000;

export function entropyPool(seeds) {
  const normalized = [...new Set(seeds.map((seed) => String(seed).toLowerCase()))].sort();
  return normalized.join(",");
}

async function createStream(hostSecretHex, handNo, pool) {
  const key = fromHex(hostSecretHex);
  const prefix = utf8(`riverguard-deck|${handNo}|${pool}|`);
  let counter = 0;
  return async function next() {
    const counterBytes = utf8(String(counter));
    counter += 1;
    const message = new Uint8Array(prefix.length + counterBytes.length);
    message.set(prefix, 0);
    message.set(counterBytes, prefix.length);
    const digest = await hmacSha256(key, message);
    return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  };
}

async function shuffleWithStream(cards, next) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const size = i + 1;
    const limit = Math.floor(UINT32 / size) * size;
    let value = await next();
    while (value >= limit) value = await next();
    const j = value % size;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export async function computeDeck({ hostSecretHex, handNo, seeds }) {
  const pool = entropyPool(seeds);
  const stream = await createStream(hostSecretHex, handNo, pool);
  const deck = await shuffleWithStream(createDeck(), stream);
  const deckHash = await sha256Hex(deck.join(","));
  return { deck, deckHash, pool };
}

export async function verifyDeck({ hostSecretHex, handNo, seeds, deck, deckHash }) {
  const recomputed = await computeDeck({ hostSecretHex, handNo, seeds });
  if (deckHash && recomputed.deckHash !== deckHash) return { ok: false, reason: "The deck hash does not match the commitment." };
  if (deck && recomputed.deck.join(",") !== deck.join(",")) return { ok: false, reason: "The dealt cards do not match the committed deck." };
  return { ok: true, deckHash: recomputed.deckHash };
}

/** 发牌顺序：庄家左手第一位开始，每位玩家先发一张，共两轮。 */
export function dealingOrder(order, dealerId, dealtInIds) {
  const seats = order.filter((id) => dealtInIds.includes(id));
  if (!seats.length) return [];
  const index = seats.indexOf(dealerId);
  const start = index < 0 ? 0 : (index + 1) % seats.length;
  return Array.from({ length: seats.length }, (_, offset) => seats[(start + offset) % seats.length]);
}

/**
 * 按固定规则从牌堆推导底牌与公共牌，用于验证房主是否按承诺的牌堆发牌。
 * 返回完整的五张公共牌计划，未发出的街道在验证时按前缀比较。
 */
export function simulateDeal({ deck, order, dealerId, dealtInIds }) {
  let cursor = 0;
  const dealing = dealingOrder(order, dealerId, dealtInIds);
  const holeCards = Object.fromEntries(dealing.map((id) => [id, []]));
  for (let round = 0; round < 2; round += 1) {
    for (const id of dealing) holeCards[id].push(deck[cursor++]);
  }
  const board = [];
  for (const stage of ["flop", "turn", "river"]) {
    cursor += 1; // 烧牌也属于承诺牌堆的一部分
    const count = stage === "flop" ? 3 : 1;
    for (let i = 0; i < count; i += 1) board.push(deck[cursor++]);
  }
  return { holeCards, board, dealtCount: cursor };
}

export function verifyDeal({ deck, order, dealerId, dealtInIds, holeCards, board }) {
  const plan = simulateDeal({ deck, order, dealerId, dealtInIds });
  for (const id of Object.keys(holeCards || {})) {
    if ((plan.holeCards[id] || []).join(",") !== holeCards[id].join(",")) {
      return { ok: false, reason: `Hole cards for ${id} do not match the committed deck.` };
    }
  }
  for (let i = 0; i < (board || []).length; i += 1) {
    if (plan.board[i] !== board[i]) return { ok: false, reason: "The board does not match the committed deck." };
  }
  return { ok: true };
}
