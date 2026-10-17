// MQTT 信令协议：主题、消息类型、公共 Broker 列表。

export const TOPIC_PREFIX = "riverguard/v1";
export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const MSG = {
  HELLO: "HELLO",
  HELLO_ACK: "HELLO_ACK",
  JOIN_DENIED: "JOIN_DENIED",
  JOIN_ROOM: "JOIN_ROOM",
  JOIN_ACK: "JOIN_ACK",
  LOBBY: "LOBBY",
  STATE_UPDATE: "STATE_UPDATE",
  PRIVATE_CARDS: "PRIVATE_CARDS",
  SEED_REQUEST: "SEED_REQUEST",
  SEED_REVEAL: "SEED_REVEAL",
  HAND_REVEAL: "HAND_REVEAL",
  PLAYER_ACTION: "PLAYER_ACTION",
  PING: "PING",
  HEARTBEAT: "HEARTBEAT",
  RESYNC: "RESYNC",
  CHAT: "CHAT"
};

export const BROKERS = [
  { url: "wss://broker-cn.emqx.io:8084/mqtt", label: "EMQX China" },
  { url: "wss://broker.emqx.io:8084/mqtt", label: "EMQX Global" },
  { url: "wss://broker.hivemq.com:8884/mqtt", label: "HiveMQ Public" }
];

export function controlTopic(roomCode) {
  return `${TOPIC_PREFIX}/${roomCode}/c`;
}

export function hostTopic(roomCode, hostKey) {
  return `${TOPIC_PREFIX}/${roomCode}/h/${hostKey}`;
}

export function randomRoomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

export function normalizeRoomCode(value) {
  // 与随机房间码使用同一字符集，顺手把易混淆的 I / O / 0 / 1 过滤掉
  return String(value || "")
    .toUpperCase()
    .split("")
    .filter((char) => ROOM_ALPHABET.includes(char))
    .join("")
    .slice(0, 6);
}

export const ACTION = { CHECK: "CHECK", CALL: "CALL", FOLD: "FOLD", RAISE: "RAISE", ALL_IN: "ALL_IN" };
