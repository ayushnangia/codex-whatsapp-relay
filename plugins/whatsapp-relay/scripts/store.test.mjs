import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppStore, extractMessageText } from "./store.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-store-test-"));
  const store = new WhatsAppStore(path.join(directory, "store.json"));
  t.after(async () => { clearTimeout(store.pendingSave); await fs.rm(directory, { recursive: true, force: true }); });
  return store;
}
const pn = "10000000000@s.whatsapp.net", lid = "20000000000@lid";
const message = (id, remoteJid, time, text, extra = {}) => ({ key: { id, remoteJid, fromMe: false }, messageTimestamp: time, message: { conversation: text }, ...extra });

test("phone and LID histories merge without losing recent messages or the saved name", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: pn, name: "Synthetic parent" });
  store.ingestMessage(message("older", pn, 1, "older"));
  store.ingestMessage(message("newer", lid, 2, "newer"));
  store.recordJidMapping({ lid, pn });
  assert.deepEqual(store.getMessages(pn).map(m => m.id), ["older", "newer"]);
  assert.equal(store.resolveChat({ chatId: lid }).match.id, pn);
  assert.equal(store.listChats({ query: "Synthetic parent" }).length, 1);
  assert.equal(store.listChats()[0].lastMessageText, "newer");
  assert.equal(store.listChats()[0].lastMessageId, "newer");
});

test("alternate message IDs and contact mappings resolve into one chat", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: lid, phoneNumber: pn, name: "Synthetic" });
  const msg = message("one", lid, 3, "one"); msg.key.remoteJidAlt = pn;
  store.ingestMessage(msg);
  store.ingestMessage(msg);
  assert.equal(store.getMessageCount(pn), 1);
  assert.equal(store.data.chats[pn].unreadCount, 1);
  store.recordJidMapping({ lid: "not-a-lid", pn });
  assert.equal(Object.keys(store.data.meta.jidAliases).length, 1);
});

test("persisted media retains downloadable keys and roundtrips through protobuf", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("image", pn, 4, "", { message: { imageMessage: {
    caption: "Synthetic image", mimetype: "image/png", mediaKey: Buffer.alloc(32, 7), directPath: "/synthetic", fileLength: 12
  } } }));
  await store.save();
  const copy = new WhatsAppStore(store.filePath); await copy.load();
  const raw = copy.getRawMessage(pn, "image");
  assert.equal(raw.message.imageMessage.mediaKey.length, 32);
  assert.equal(raw.message.imageMessage.mediaKey[0], 7);
  assert.equal(copy.getMessages(pn)[0].media.mimetype, "image/png");
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
});

test("contact messages are readable and message revocation removes downloadable content", async t => {
  const store = await fixture(t);
  assert.equal(extractMessageText({ contactMessage: { displayName: "Synthetic contact", vcard: "synthetic" } }), "[contact] Synthetic contact");
  store.ingestMessage(message("one", pn, 1, "private"));
  store.updateMessage({ remoteJid: pn, id: "one" }, { message: null });
  assert.equal(store.getMessages(pn)[0].text, "[deleted]");
  assert.equal(store.getRawMessage(pn, "one"), null);
  assert.equal(store.listChats()[0].lastMessageText, "[deleted]");
});

test("edits and acknowledgements in the same event update the current cached entry", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("one", pn, 1, "", { message: { imageMessage: { caption: "before", mimetype: "image/png" } } }));
  store.updateMessage({ remoteJid: pn, id: "one" }, { message: { conversation: "after" }, status: 3 });
  const entry = store.getMessages(pn)[0];
  assert.equal(entry.text, "after");
  assert.equal(entry.deliveryStatus, 3);
  assert.equal(entry.media, undefined);
  assert.equal(store.getRawMessage(pn, "one").status, 3);
  assert.equal(store.listChats()[0].lastMessageText, "after");
});

test("late mapping merges duplicate IDs and refuses conflicting reassignment", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("same", pn, 1, "same"));
  store.ingestMessage(message("same", lid, 1, "same"));
  store.recordJidMapping({ lid, pn });
  assert.equal(store.getMessageCount(pn), 1);
  store.recordJidMapping({ lid, pn: "19999999999@s.whatsapp.net" });
  assert.equal(store.canonicalJid(lid), pn);
  assert.equal(store.data.meta.jidMappingConflictCount, 1);
});

test("revoking an older message leaves the newer chat preview intact", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("old", pn, 1, "old"));
  store.ingestMessage(message("new", pn, 2, "new"));
  store.updateMessage({ remoteJid: pn, id: "old" }, { message: null });
  assert.equal(store.listChats()[0].lastMessageText, "new");
});

test("duplicate exact names remain ambiguous even beyond the previous fifty-result cutoff", async t => {
  const store = await fixture(t);
  for (let i = 0; i < 60; i++) store.upsertChat({ id: `${10000000100 + i}@s.whatsapp.net`, name: "Synthetic name", timestamp: i });
  const resolved = store.resolveChat({ chatName: "Synthetic name" });
  assert.equal(resolved.match, null);
  assert.equal(resolved.candidates.length, 60);
});

test("a slow earlier save cannot overwrite a newer cache snapshot", async t => {
  const store = await fixture(t);
  const files = new Map();
  let firstWrite = true;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const writeFile = fs.writeFile.bind(fs);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "writeFile", async (file, data, options) => {
    if (!String(file).startsWith(`${store.filePath}.`)) return writeFile(file, data, options);
    if (firstWrite) { firstWrite = false; entered(); await blocked; }
    files.set(file, data);
  });
  t.mock.method(fs, "rename", async (from, to) => {
    if (to !== store.filePath) return rename(from, to);
    files.set(to, files.get(from)); files.delete(from);
  });
  store.data.meta.syntheticRevision = 1;
  const first = store.save();
  await started;
  store.data.meta.syntheticRevision = 2;
  const second = store.save();
  await new Promise(setImmediate);
  release();
  await Promise.all([first, second]);
  assert.equal(JSON.parse(files.get(store.filePath)).meta.syntheticRevision, 2);
});

test("a failed cache write leaves no partial file and does not poison later saves", async t => {
  const store = await fixture(t);
  const writeFile = fs.writeFile.bind(fs);
  let fail = true;
  t.mock.method(fs, "writeFile", async (file, data, options) => {
    await writeFile(file, data, options);
    if (fail && String(file).startsWith(`${store.filePath}.`)) { fail = false; throw new Error("synthetic write failure"); }
  });
  await assert.rejects(store.save(), /synthetic write failure/);
  assert.deepEqual(await fs.readdir(path.dirname(store.filePath)), []);
  store.data.meta.syntheticRevision = 2;
  await store.save();
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).meta.syntheticRevision, 2);
});

test("early acknowledgements survive insertion and duplicate pending snapshots", async t => {
  const store = await fixture(t);
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 2 });
  store.ingestMessage(message("sent", pn, 1, "test", { status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 2);
  store.ingestMessage(message("sent", pn, 1, "test", { status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 2);
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 4 });
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 2 });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 4);
});

test("explicit send failures are not erased by later pending snapshots", async t => {
  const store = await fixture(t);
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 0 });
  store.ingestMessage(message("sent", pn, 1, "test", { status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 0);
});

test("unaddressed self-device receipts and service-JID ACKs resolve only unique outgoing IDs", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("out", pn, 1, "test", { key: { remoteJid: pn, id: "out", fromMe: true }, status: 1 }));
  store.updateMessage({ id: "out", fromMe: true }, { status: 3 });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 3);
  store.ingestMessage(message("server-ack", pn, 2, "test", { key: { remoteJid: pn, id: "server-ack", fromMe: true }, status: 1 }));
  store.updateMessage({ remoteJid: "s.whatsapp.net", id: "server-ack", fromMe: true }, { status: 2 });
  assert.equal(store.getMessages(pn)[1].deliveryStatus, 2);
  store.ingestMessage(message("incoming", pn, 3, "test", { status: 1 }));
  store.updateMessage({ id: "incoming", fromMe: true }, { status: 4 });
  assert.equal(store.getMessages(pn)[2].deliveryStatus, 1);
  store.ingestMessage(message("out", "30000000000@s.whatsapp.net", 4, "duplicate ID", { key: { remoteJid: "30000000000@s.whatsapp.net", id: "out", fromMe: true }, status: 1 }));
  store.updateMessage({ id: "out", fromMe: true }, { status: 5 });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 3);
});

test("an unaddressed ACK before send completion is retained for the outgoing message", async t => {
  const store = await fixture(t);
  store.updateMessage({ id: "early", fromMe: true }, { status: 2 });
  store.ingestMessage(message("early", pn, 1, "test", { key: { remoteJid: pn, id: "early", fromMe: true }, status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 2);
  assert.equal(store.pendingMessageStatuses.size, 0);
});

test("real receipt timestamps survive history merges without promoting zero timestamps or whole groups", async t => {
  const store = await fixture(t);
  const raw = message("audio", pn, 1, "", { key: { remoteJid: pn, id: "audio", fromMe: true },
    message: { audioMessage: { mimetype: "audio/ogg", ptt: true } }, status: 1,
    userReceipt: [{ userJid: pn, receiptTimestamp: 10, readTimestamp: 0 }] });
  store.ingestMessage(raw);
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 3);
  assert.deepEqual(store.getMessages(pn)[0].receipts, { delivered: 1, read: 0, played: 0 });
  store.updateReceipt(raw.key, { userJid: pn, readTimestamp: 11, playedTimestamp: 12 });
  // A later history copy without receipts must not erase observed evidence.
  store.ingestMessage({ ...raw, userReceipt: [] });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 5);
  await store.save();
  const copy = new WhatsAppStore(store.filePath); await copy.load();
  assert.equal(copy.getMessages(pn)[0].deliveryStatus, 5);
  const group = "12345@g.us";
  store.ingestMessage({ ...raw, key: { ...raw.key, remoteJid: group } });
  assert.equal(store.getMessages(group)[0].deliveryStatus, 1);
  store.ingestMessage({ ...raw, key: { ...raw.key, id: "zero" }, userReceipt: [{ userJid: pn, receiptTimestamp: 0 }] });
  assert.equal(store.getMessages(pn).find(item => item.id === "zero").deliveryStatus, 1);
});
