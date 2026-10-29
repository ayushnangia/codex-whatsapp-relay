import { releaseDaemonSession } from "./daemon-client.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error"
});

process.stdout.write("Starting WhatsApp terminal QR authentication...\n");
process.stdout.write(
  "Open WhatsApp on your phone, then go to Settings -> Linked Devices -> Link a Device.\n"
);

// Pause the relay runtime daemon until this process exits; it reconnects with
// the new credentials afterwards.
await releaseDaemonSession("terminal_qr_auth");
await runtime.start({ printQrToTerminal: true, force: true });

try {
  const socket = await runtime.waitForConnection(5 * 60_000);
  const user = socket.user?.id ?? "unknown";
  process.stdout.write(`\nAuthenticated successfully as ${user}.\n`);
  await runtime.stop();
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nAuthentication failed: ${error.message}\n`);
  process.exit(1);
}
