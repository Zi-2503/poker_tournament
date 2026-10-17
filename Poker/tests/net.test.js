import test from "node:test";
import assert from "node:assert/strict";
import { Relay } from "../js/net.js";
import { MSG, controlTopic } from "../js/protocol.js";

/** 内存假 Broker：只做订阅匹配与转发，用来验证传输层契约。 */
function fakeBus() {
  const clients = [];
  const published = [];
  const matches = (filter, topic) => filter === topic || (filter.endsWith("#") && topic.startsWith(filter.slice(0, -1)));
  const mqtt = {
    connect(url) {
      const handlers = new Map();
      const client = {
        url,
        topics: [],
        on(event, callback) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event).push(callback);
          return client;
        },
        emit(event, ...args) {
          for (const callback of handlers.get(event) || []) callback(...args);
        },
        subscribe(topics, _options, callback) {
          client.topics.push(...(Array.isArray(topics) ? topics : [topics]));
          if (callback) callback(null);
          return client;
        },
        publish(topic, payload, _options, callback) {
          published.push({ topic, payload });
          for (const other of clients) {
            if (other === client) continue;
            if (!other.topics.some((filter) => matches(filter, topic))) continue;
            setTimeout(() => other.emit("message", topic, Buffer.from(payload)), 0);
          }
          if (callback) callback(null);
        },
        end() {}
      };
      clients.push(client);
      setTimeout(() => client.emit("connect"), 0);
      return client;
    }
  };
  return { mqtt, published };
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRelay(bus, roomCode, inbox) {
  const relay = new Relay({
    roomCode,
    mqttFactory: async () => bus.mqtt,
    onMessage: (message) => inbox.push(message)
  });
  await relay.connect();
  await relay.subscribe([controlTopic(roomCode)]);
  return relay;
}

test("消息经房间密钥加密后仍能被同房间订阅者还原", async () => {
  const bus = fakeBus();
  const hostInbox = [];
  const host = await makeRelay(bus, "ABC234", hostInbox);
  await host.send(controlTopic("ABC234"), MSG.HELLO, { name: "小明" }, "player-1");
  await tick();

  assert.equal(hostInbox.length, 0, "同一条连接不应收到自己发布的消息");

  const published = bus.published[0];
  assert.equal(JSON.parse(published.payload).box.ct.length > 0, true);
  assert.equal(published.payload.includes("小明"), false, "明文昵称不应出现在报文里");
});

test("其他房间码无法解开报文", async () => {
  const bus = fakeBus();
  const insider = [];
  const outsider = [];
  const host = await makeRelay(bus, "ABC234", insider);
  const stranger = new Relay({
    roomCode: "ZZZ999",
    mqttFactory: async () => bus.mqtt,
    onMessage: (message) => outsider.push(message)
  });
  await stranger.connect();
  await stranger.subscribe([controlTopic("NNN111")]);

  // 直接把同一份报文选给房间外的连接
  await host.send(controlTopic("ABC234"), MSG.STATE_UPDATE, { pot: 100 }, "host");
  const { topic, payload } = bus.published[0];
  await stranger.ingest(topic, Buffer.from(payload));
  await tick();

  assert.equal(outsider.length, 0);
});

test("重复报文会按 mid 去重", async () => {
  const bus = fakeBus();
  const hostInbox = [];
  const playerInbox = [];
  const host = await makeRelay(bus, "ABC234", hostInbox);
  const player = await makeRelay(bus, "ABC234", playerInbox);

  await host.send(controlTopic("ABC234"), MSG.HEARTBEAT, { seq: 1 }, "host");
  const { topic, payload } = bus.published[0];
  await tick();
  assert.equal(playerInbox.length, 1);

  // 中继重发同一条报文时不应重复处理
  await player.ingest(topic, Buffer.from(payload));
  await tick();

  assert.equal(playerInbox.length, 1);
  assert.equal(playerInbox[0].type, MSG.HEARTBEAT);
  assert.equal(playerInbox[0].payload.seq, 1);
  assert.equal(playerInbox[0].from, "host");
  assert.ok(playerInbox[0].mid);
});
