import test from "node:test";
import assert from "node:assert/strict";
import { computeDeck, simulateDeal, verifyDeal, verifyDeck, dealingOrder } from "../js/shuffle.js";

const SECRET = "a".repeat(64);

test("相同输入产生完全相同的牌堆", async () => {
  const first = await computeDeck({ hostSecretHex: SECRET, handNo: 1, seeds: ["11", "22"] });
  const second = await computeDeck({ hostSecretHex: SECRET, handNo: 1, seeds: ["22", "11"] });
  assert.equal(first.deck.join(","), second.deck.join(","));
  assert.equal(first.deckHash, second.deckHash);
  assert.equal(new Set(first.deck).size, 52);
});

test("手号或种子变化会改变牌堆", async () => {
  const base = await computeDeck({ hostSecretHex: SECRET, handNo: 1, seeds: ["11"] });
  const nextHand = await computeDeck({ hostSecretHex: SECRET, handNo: 2, seeds: ["11"] });
  const withSeed = await computeDeck({ hostSecretHex: SECRET, handNo: 1, seeds: ["11", "22"] });
  assert.notEqual(base.deckHash, nextHand.deckHash);
  assert.notEqual(base.deckHash, withSeed.deckHash);
});

test("密钥不符时验证失败", async () => {
  const honest = await computeDeck({ hostSecretHex: SECRET, handNo: 3, seeds: ["ab"] });
  const ok = await verifyDeck({
    hostSecretHex: SECRET, handNo: 3, seeds: ["ab"], deck: honest.deck, deckHash: honest.deckHash
  });
  assert.equal(ok.ok, true);
  const bad = await verifyDeck({
    hostSecretHex: "b".repeat(64), handNo: 3, seeds: ["ab"], deck: honest.deck, deckHash: honest.deckHash
  });
  assert.equal(bad.ok, false);
});

test("发牌顺序从庄家左手开始", () => {
  assert.deepEqual(dealingOrder(["a", "b", "c"], "a", ["a", "b", "c"]), ["b", "c", "a"]);
  assert.deepEqual(dealingOrder(["a", "b", "c"], "b", ["a", "b", "c"]), ["c", "a", "b"]);
});

test("按承诺牌堆发牌时验证通过，篡改任意一张牌即失败", async () => {
  const { deck, deckHash } = await computeDeck({ hostSecretHex: SECRET, handNo: 5, seeds: ["cd"] });
  const order = ["a", "b", "c"];
  const plan = simulateDeal({ deck, order, dealerId: "a", dealtInIds: order });
  const good = verifyDeal({
    deck, order, dealerId: "a", dealtInIds: order,
    holeCards: plan.holeCards, board: plan.board
  });
  assert.equal(good.ok, true);

  const tampered = { ...plan.holeCards, b: ["AS", "AD"] };
  const bad = verifyDeal({
    deck, order, dealerId: "a", dealtInIds: order, holeCards: tampered, board: plan.board
  });
  assert.equal(bad.ok, false);

  const revealed = await verifyDeck({
    hostSecretHex: SECRET, handNo: 5, seeds: ["cd"], deck, deckHash
  });
  assert.equal(revealed.ok, true);
});
