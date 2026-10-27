import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { DisconnectReason, proto } from "@whiskeysockets/baileys";
import { WhatsAppRuntime } from "./runtime.mjs";

test("auth reuses a live QR but never returns a disconnected cached QR", async () => {
  const runtime = new WhatsAppRuntime({ logLevel: "silent" });
  runtime.socket = { ws: { isOpen: true } };
  runtime.state.status = "awaiting_qr_scan";
  runtime.state.currentQrText = "live";
  runtime.start = async () => assert.fail("live auth must reuse its socket");
  assert.equal((await runtime.startAuthFlow()).qrText, "live");
  runtime.socket.ws.isOpen = false;
  runtime.state.status = "disconnected";
  let starts = 0;
  runtime.start = async () => {
    starts++;
    runtime.state.status = "awaiting_qr_scan";
    runtime.state.currentQrText = "fresh";
  };
  assert.equal((await runtime.startAuthFlow()).qrText, "fresh");
  assert.equal(starts, 1);
});

test("closed and replaced sockets cannot leave a usable stale QR", async () => {
  const source = await fs.readFile(new URL("runtime.mjs", import.meta.url), "utf8");
  const begin = source.indexOf('    socket.ev.on("connection.update", (update) => {');
  const end = source.indexOf('    socket.ev.on("messages.upsert", (payload)', begin);
  const code = source.slice(begin, end);
  let handler;
  const socket = { ev: { on: (_, fn) => { handler = fn; } } };
  const runtime = { socket, closing: true, state: { status: "awaiting_qr_scan", currentQrText: "stale" }, events: { emit() {} } };
  const context = { socket, DisconnectReason, disconnectCode: () => DisconnectReason.connectionLost,
    disconnectLabel: () => "connection_lost", printQrToTerminal: false };
  const harness = vm.runInNewContext(`class Harness {
    #renderQr(value) { return value; }
    install() { ${code} }
  }
  const harness = Object.assign(new Harness(), runtime);
  harness.install();
  harness;`, { ...context, runtime });
  handler({ connection: "close", lastDisconnect: { error: new Error("closed") } });
  assert.equal(runtime.state.currentQrText, null);
  assert.equal(runtime.state.status, "disconnected");
  harness.socket = {};
  handler({ qr: "obsolete QR" });
  assert.equal(runtime.state.currentQrText, null);
});

test("positive provider acknowledgements update status but errors and obsolete sockets do not", async () => {
  const source = await fs.readFile(new URL("runtime.mjs", import.meta.url), "utf8");
  const begin = source.indexOf('    socket.ws.on("CB:ack,class:message"');
  const end = source.indexOf('    socket.ev.on("connection.update"', begin);
  let handler;
  const updates = [];
  const socket = { ws: { on: (_, callback) => { handler = callback; } } };
  const runtime = { socket, store: { updateMessage: (key, update) => updates.push({ key, update }) },
    historyRequests: { recordAck: async () => {} } };
  vm.runInNewContext(`(function() { ${source.slice(begin, end)} }).call(runtime)`, { socket, runtime, proto });
  handler({ attrs: { from: "10000000000@s.whatsapp.net", id: "synthetic" } });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.status, proto.WebMessageInfo.Status.SERVER_ACK);
  handler({ attrs: { from: "10000000000@s.whatsapp.net", id: "synthetic", error: "479" } });
  handler({ attrs: { id: "missing-from" } });
  assert.equal(updates[1].key.fromMe, true);
  assert.equal(updates[1].key.remoteJid, undefined);
  runtime.socket = {};
  handler({ attrs: { from: "10000000000@s.whatsapp.net", id: "obsolete" } });
  assert.equal(updates.length, 2);
});
