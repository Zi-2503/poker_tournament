"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestOfSeven, compareScore, evaluateFive, settlePots } = require("../poker");

test("recognizes a wheel straight", () => {
  assert.deepEqual(evaluateFive(["AS", "2D", "3H", "4C", "5S"]).score, [4, 5]);
});

test("chooses the best five cards out of seven", () => {
  const result = bestOfSeven(["AS", "KS", "QS", "JS", "TS", "2D", "2C"]);
  assert.equal(result.name, "同花顺");
  assert.equal(compareScore(result.score, [8, 13]), 1);
});

test("splits main and side pots", () => {
  const players = [
    { uid: "a", contributed: 100, folded: false },
    { uid: "b", contributed: 200, folded: false },
    { uid: "c", contributed: 200, folded: false }
  ];
  const holes = {
    a: ["AS", "AD"],
    b: ["KS", "KD"],
    c: ["QS", "QD"]
  };
  const result = settlePots(players, holes, ["2C", "3D", "7H", "8S", "9C"], ["a", "b", "c"]);
  assert.equal(result.payouts.a, 300);
  assert.equal(result.payouts.b, 200);
  assert.equal(result.payouts.c, 0);
  assert.deepEqual(result.pots.map((pot) => pot.amount), [300, 200]);
});

test("folded chips stay in the pot but folded players cannot win", () => {
  const players = [
    { uid: "a", contributed: 75, folded: true },
    { uid: "b", contributed: 75, folded: false },
    { uid: "c", contributed: 75, folded: false }
  ];
  const holes = { b: ["2S", "2D"], c: ["AS", "AD"] };
  const result = settlePots(players, holes, ["3C", "5D", "7H", "9S", "TC"], ["b", "c", "a"]);
  assert.equal(result.payouts.a, 0);
  assert.equal(result.payouts.c, 225);
});

test("awards an odd split chip in table order", () => {
  const players = [
    { uid: "a", contributed: 5, folded: false },
    { uid: "b", contributed: 5, folded: false },
    { uid: "c", contributed: 5, folded: true }
  ];
  const holes = { a: ["2C", "3D"], b: ["2D", "3C"] };
  const result = settlePots(players, holes, ["AS", "KH", "QC", "JD", "TS"], ["b", "a", "c"]);
  assert.equal(result.payouts.b, 8);
  assert.equal(result.payouts.a, 7);
});
