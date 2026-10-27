import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("send-confirmations.py", import.meta.url));
const pythonAvailable = spawnSync("python3", ["-c", "import tomllib"]).status === 0;
async function fixture(t, contents) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-confirm-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.toml"); await fs.writeFile(config, contents);
  const run = (...args) => spawnSync("python3", [script, ...args, "--config", config], { encoding: "utf8" });
  const read = () => JSON.parse(spawnSync("python3", ["-c", "import tomllib,json,sys; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", config], { encoding: "utf8" }).stdout);
  return { config, run, read };
}

test("send confirmations toggle only final-send tools and restore previous config", { skip: !pythonAvailable }, async t => {
  const original = 'approval_policy = "never"\n# retained user settings\n[plugins."whatsapp-relay@example"]\nenabled = true\n';
  const { config, run, read } = await fixture(t, original);
  assert.equal(run("on", "--slack-app-id", "test-slack", "--gmail-app-id", "test-gmail").status, 0);
  const on = read();
  assert.equal(on.approval_policy, "never");
  assert.equal(on.apps._default, undefined);
  assert.equal(on.apps["test-gmail"].tools.send_draft.approval_mode, "prompt");
  assert.equal(on.apps["test-gmail"].tools.create_draft.approval_mode, "approve");
  assert.equal(on.apps["test-gmail"].tools.update_draft.approval_mode, "approve");
  assert.equal(on.apps["test-slack"].tools.slack_send_message_draft.approval_mode, "approve");
  assert.equal(on.apps["test-slack"].tools.slack_send_message.approval_mode, "prompt");
  assert.equal(on.apps["test-slack"].approvals_reviewer, "user");
  assert.equal(on.plugins["whatsapp-relay@example"].mcp_servers["whatsapp-relay"].tools.whatsapp_send_media.approval_mode, "prompt");
  assert.equal(run("off").status, 0);
  assert.deepEqual(read(), { approval_policy: "never", plugins: { "whatsapp-relay@example": { enabled: true } } });
  assert.equal(JSON.parse(run("status").stdout).enabled, false);
  assert.equal(run("on").status, 0);
  assert.deepEqual(read(), on);
  assert.ok((await fs.readFile(config, "utf8")).startsWith(original));
});

test("policy helper preserves conflicting or edited user controls without a write", { skip: !pythonAvailable }, async t => {
  const original = '[apps."test-gmail".tools.send_email]\napproval_mode = "approve"\n';
  const { config, run } = await fixture(t, original);
  assert.notEqual(run("on", "--gmail-app-id", "test-gmail").status, 0);
  assert.equal(await fs.readFile(config, "utf8"), original);
  const { config: second, run: next } = await fixture(t, '[mcp_servers.whatsapp-relay]\ncommand="node"\n');
  assert.equal(next("on").status, 0);
  const changed = (await fs.readFile(second, "utf8")).replace('"approval_mode" = "prompt"', '"approval_mode" = "approve"');
  await fs.writeFile(second, changed);
  assert.notEqual(next("off").status, 0);
  assert.equal(await fs.readFile(second, "utf8"), changed);
});

test("policy helper preserves a symlinked config target", { skip: !pythonAvailable }, async t => {
  const { config, run } = await fixture(t, '[mcp_servers.whatsapp-relay]\ncommand="node"\n');
  const target = config + '.target'; await fs.rename(config, target); await fs.symlink(target, config);
  assert.equal(run("on").status, 0);
  assert.ok((await fs.lstat(config)).isSymbolicLink());
  assert.match(await fs.readFile(target, "utf8"), /send-confirmations v1/);
});
