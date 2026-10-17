import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlayerIdentity, decryptJson, deriveRoomKey, deriveSharedKey, encryptJson,
  exportPublicKey, fromB64, importPublicKey, randomHex, sha256Hex, toB64
} from "../js/crypto.js";

test("房间密钥可以往返加解密，其他房间码无法解开", async () => {
  const key = await deriveRoomKey("ABC234");
  const box = await encryptJson(key, { type: "STATE_UPDATE", pot: 120 });
  assert.deepEqual(await decryptJson(key, box), { type: "STATE_UPDATE", pot: 120 });

  const otherKey = await deriveRoomKey("XYZ789");
  await assert.rejects(() => decryptJson(otherKey, box));
});

test("base64 与十六进制编解码稳定", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  assert.deepEqual([...fromB64(toB64(bytes))], [...bytes]);
  assert.equal(randomHex(8).length, 16);
});

test("ECDH 双方能派生出同一把密钥，第三方解不开底牌", async () => {
  const host = await createPlayerIdentity();
  const player = await createPlayerIdentity();
  const stranger = await createPlayerIdentity();

  const hostSide = await deriveSharedKey(host.keyPair.privateKey, player.publicKey);
  const playerSide = await deriveSharedKey(player.keyPair.privateKey, host.publicKey);

  const holeCards = { handNo: 7, cards: ["AS", "AH"] };
  const sealed = await encryptJson(hostSide, holeCards);
  assert.deepEqual(await decryptJson(playerSide, sealed), holeCards);

  const strangerSide = await deriveSharedKey(stranger.keyPair.privateKey, host.publicKey);
  await assert.rejects(() => decryptJson(strangerSide, sealed));
});

test("公钥导出后可以重新导入并参与密钥协商", async () => {
  const alice = await createPlayerIdentity();
  const bob = await createPlayerIdentity();
  const imported = await importPublicKey(await exportPublicKey(bob.keyPair.publicKey));

  const key = await crypto.subtle.deriveKey(
    { name: "ECDH", public: imported },
    alice.keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const bobSide = await deriveSharedKey(bob.keyPair.privateKey, alice.publicKey);
  const sealed = await encryptJson(key, { hello: "world" });
  assert.deepEqual(await decryptJson(bobSide, sealed), { hello: "world" });
});

test("玩家身份 id 是 16 位十六进制摘要", async () => {
  const identity = await createPlayerIdentity();
  assert.match(identity.playerId, /^[0-9a-f]{16}$/);
  assert.equal((await sha256Hex("abc")).length, 64);
});
