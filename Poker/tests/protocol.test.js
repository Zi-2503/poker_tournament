import test from "node:test";
import assert from "node:assert/strict";
import { BROKERS, controlTopic, hostTopic, normalizeRoomCode, randomRoomCode } from "../js/protocol.js";

test("房间码为 6 位且不含易混淆字符", () => {
  for (let i = 0; i < 40; i += 1) {
    const code = randomRoomCode();
    assert.match(code, /^[A-Z2-9]{6}$/);
    assert.equal(/[IO01]/.test(code), false);
  }
});

test("房间码输入会被规范化为大写并过滤非法字符", () => {
  assert.equal(normalizeRoomCode(" abc234 "), "ABC234");
  assert.equal(normalizeRoomCode("ab-c2-34"), "ABC234");
  assert.equal(normalizeRoomCode("io01abc"), "ABC");
});

test("主题命名符合协议约定", () => {
  assert.equal(controlTopic("ABC234"), "riverguard/v1/ABC234/c");
  assert.equal(hostTopic("ABC234", "deadbeef"), "riverguard/v1/ABC234/h/deadbeef");
});

test("至少配置了一个备用公共 Broker", () => {
  assert.ok(BROKERS.length >= 2);
  for (const broker of BROKERS) assert.match(broker.url, /^wss:\/\//);
});
