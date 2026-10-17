// MQTT 传输层：CDN 加载 mqtt.js、多 Broker 回退、房间密钥信封加密、消息去重。

import { BROKERS } from "./protocol.js";
import { deriveRoomKey, encryptJson, decryptJson, randomHex } from "./crypto.js";

const SDK_CDNS = [
  "https://unpkg.com/mqtt/dist/mqtt.min.js",
  "https://cdn.jsdelivr.net/npm/mqtt@5/dist/mqtt.min.js",
  "https://fastly.jsdelivr.net/npm/mqtt@5/dist/mqtt.min.js"
];

function injectScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error(`Loading timed out: ${url}`));
    }, 7000);
    script.src = url;
    script.async = true;
    script.onload = () => { clearTimeout(timer); resolve(url); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error(`Loading failed: ${url}`)); };
    document.head.appendChild(script);
  });
}

export async function loadMqttSdk() {
  if (globalThis.mqtt) return globalThis.mqtt;
  for (const url of SDK_CDNS) {
    try {
      await injectScript(url);
      if (globalThis.mqtt) return globalThis.mqtt;
    } catch {
      // 尝试下一个 CDN
    }
  }
  throw new Error("Unable to load the connection library. Please check your network.");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Relay {
  /** onMessage({ type, payload, from, ts, mid })；onStatus({ state, broker, detail }) */
  constructor({ roomCode, onMessage, onStatus = () => {}, mqttFactory = loadMqttSdk, startIndex = 0 }) {
    this.roomCode = roomCode;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.mqttFactory = mqttFactory;
    this.client = null;
    this.roomKey = null;
    this.brokerIndex = startIndex;
    this.currentBroker = null;
    this.clientId = `riverguard_${randomHex(6)}`;
    this.seen = new Set();
    this.seenQueue = [];
    this.closed = false;
  }

  async connect() {
    const mqtt = await this.mqttFactory();
    this.roomKey = await deriveRoomKey(this.roomCode);
    let lastError = null;

    for (let attempt = 0; attempt < BROKERS.length * 2; attempt += 1) {
      const index = (this.brokerIndex + attempt) % BROKERS.length;
      const broker = BROKERS[index];
      try {
        await this.open(mqtt, broker);
        this.brokerIndex = index;
        this.currentBroker = broker;
        this.onStatus({ state: "online", broker: broker.label });
        return broker;
      } catch (error) {
        lastError = error;
        this.onStatus({ state: "retry", broker: broker.label, detail: error.message });
      }
    }
    this.onStatus({ state: "offline", detail: lastError?.message || "All connections are unavailable." });
    throw lastError || new Error("Unable to connect. Please try again.");
  }

  open(mqtt, broker) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = mqtt.connect(broker.url, {
        clientId: `${this.clientId}_${randomHex(3)}`,
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 3000,
        keepalive: 30,
        protocolVersion: 4
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.end(true); } catch { /* 忽略 */ }
        reject(new Error(`${broker.label} connection timed out.`));
      }, 9000);

      client.on("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.client = client;
        this.wire(client, broker);
        resolve();
      });
      client.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { client.end(true); } catch { /* 忽略 */ }
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  wire(client, broker) {
    client.on("message", (topic, buffer) => this.ingest(topic, buffer));
    client.on("close", () => { if (!this.closed) this.onStatus({ state: "reconnecting", broker: broker.label }); });
    client.on("reconnect", () => this.onStatus({ state: "reconnecting", broker: broker.label }));
    client.on("connect", () => {
      if (this.topics?.length) client.subscribe(this.topics, { qos: 0 });
      this.onStatus({ state: "online", broker: broker.label });
    });
  }

  subscribe(topics) {
    const list = [...new Set([...(this.topics || []), ...(Array.isArray(topics) ? topics : [topics])])];
    this.topics = list;
    return new Promise((resolve) => {
      if (!this.client) return resolve(false);
      this.client.subscribe(list, { qos: 0 }, () => resolve(true));
    });
  }

  async ingest(topic, buffer) {
    let envelope;
    try {
      envelope = JSON.parse(buffer.toString());
    } catch {
      return;
    }
    if (!envelope?.box || envelope.v !== 1) return;
    if (this.seen.has(envelope.mid)) return;
    this.remember(envelope.mid);
    try {
      const inner = await decryptJson(this.roomKey, envelope.box);
      this.onMessage({
        type: inner.type,
        payload: inner.payload,
        from: envelope.from,
        ts: envelope.ts,
        mid: envelope.mid,
        topic
      });
    } catch {
      // 非本房间的报文或密钥不匹配，直接忽略
    }
  }

  remember(mid) {
    this.seen.add(mid);
    this.seenQueue.push(mid);
    if (this.seenQueue.length > 400) this.seen.delete(this.seenQueue.shift());
  }

  async send(topic, type, payload, from = "anon") {
    if (!this.client) throw new Error("Not connected yet.");
    const mid = randomHex(8);
    const box = await encryptJson(this.roomKey, { type, payload });
    const envelope = { v: 1, mid, from, ts: Date.now(), box };
    this.remember(mid);
    return new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(envelope), { qos: 0 }, (error) => (error ? reject(error) : resolve(mid)));
    });
  }

  close() {
    this.closed = true;
    if (this.client) {
      try { this.client.end(true); } catch { /* 忽略 */ }
    }
    this.client = null;
  }
}

export { wait };
