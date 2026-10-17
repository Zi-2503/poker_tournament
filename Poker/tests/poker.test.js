import test from "node:test";
import assert from "node:assert/strict";
import { bestOfSeven, compareScore, createDeck, evaluateFive, settlePots } from "../js/poker.js";

test("牌堆包含 52 张互不重复的牌", () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test("识别轮子顺子 A2345", () => {
  assert.deepEqual(evaluateFive(["AS", "2D", "3H", "4C", "5S"]).score, [4, 5]);
});

test("同花顺高于四条", () => {
  const straightFlush = evaluateFive(["AS", "KS", "QS", "JS", "TS"]);
  const quads = evaluateFive(["9S", "9D", "9H", "9C", "2S"]);
  assert.equal(straightFlush.name, "Straight Flush");
  assert.equal(compareScore(straightFlush.score, quads.score), 1);
});

test("七张牌中选出最佳五张", () => {
  const result = bestOfSeven(["AS", "KS", "QS", "JS", "TS", "2D", "2C"]);
  assert.equal(result.name, "Straight Flush");
  assert.deepEqual(result.score, [8, 14]);
});

test("踢脚牌决定高牌胜负", () => {
  const a = bestOfSeven(["AS", "KD", "7C", "5H", "3S", "2D", "9C"]);
  const b = bestOfSeven(["AH", "KC", "7D", "5S", "3D", "2H", "8C"]);
  assert.equal(compareScore(a.score, b.score), 1);
});

test("构建主池与边池并正确派彩", () => {
  const players = [
    { id: "a", contributed: 100, folded: false },
    { id: "b", contributed: 200, folded: false },
    { id: "c", contributed: 200, folded: false }
  ];
  const holes = { a: ["AS", "AD"], b: ["KS", "KD"], c: ["QS", "QD"] };
  const result = settlePots(players, holes, ["2C", "3D", "7H", "8S", "9C"], ["a", "b", "c"]);
  assert.equal(result.payouts.a, 300);
  assert.equal(result.payouts.b, 200);
  assert.equal(result.payouts.c, 0);
  assert.deepEqual(result.pots.map((pot) => pot.amount), [300, 200]);
});

test("弃牌玩家的筹码留在池中但不能赢", () => {
  const players = [
    { id: "a", contributed: 75, folded: true },
    { id: "b", contributed: 75, folded: false },
    { id: "c", contributed: 75, folded: false }
  ];
  const holes = { b: ["2S", "2D"], c: ["AS", "AD"] };
  const result = settlePots(players, holes, ["3C", "5D", "7H", "9S", "TC"], ["b", "c", "a"]);
  assert.equal(result.payouts.a, 0);
  assert.equal(result.payouts.c, 225);
});

test("平分时多余筹码按庄家左侧顺序分配", () => {
  const players = [
    { id: "a", contributed: 5, folded: false },
    { id: "b", contributed: 5, folded: false },
    { id: "c", contributed: 5, folded: true }
  ];
  const holes = { a: ["2C", "3D"], b: ["2D", "3C"] };
  const result = settlePots(players, holes, ["AS", "KH", "QC", "JD", "TS"], ["b", "a", "c"]);
  assert.equal(result.payouts.b, 8);
  assert.equal(result.payouts.a, 7);
});
