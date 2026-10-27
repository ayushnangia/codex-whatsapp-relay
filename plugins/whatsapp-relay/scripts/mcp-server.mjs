import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { proto } from "@whiskeysockets/baileys";
import { prepareMedia, freezePreparedMedia, downloadMessageMedia } from "./media.mjs";
import { unwrapMessage } from "./store.mjs";

import { ControllerConfigStore } from "./controller-config.mjs";
import {
  normalizePermissionLevel,
  resolvePermissionLevel
} from "./controller-permissions.mjs";
import { enqueueControllerCommand } from "./controller-outbox.mjs";
import {
  getControllerProcessStatus,
  startControllerDaemon,
  stopControllerDaemon
} from "./controller-process.mjs";
import { credsFile, storeFile } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";
import { normalizeTtsProvider } from "./voice-replier.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn"
});
const controllerConfigStore = new ControllerConfigStore();

await runtime.initialize();

function chatSummary(chat) {
  const stamp = chat.lastMessageTimestamp ?? chat.timestamp;
  return [
    `- ${chat.displayName} (${chat.id})`,
    `  unread=${chat.unreadCount ?? 0}`,
    stamp ? `last=${new Date(stamp * 1000).toISOString()}` : null,
    chat.lastMessageText ? `text=${chat.lastMessageText}` : null
  ]
    .filter(Boolean)
    .join(" ");
}

function messageSummary(message) {
  const stamp = message.timestamp
    ? new Date(message.timestamp * 1000).toISOString()
    : "unknown-time";
  const author = message.fromMe ? "me" : message.pushName || message.participant || "contact";
  const media = message.media ? ` media=${message.media.mimetype ?? message.messageType} file=${message.media.fileName ?? "unnamed"} voice_note=${message.media.voiceNote} duration_seconds=${message.media.seconds ?? "unknown"}` : "";
  const receipts = message.receipts ? ` receipt_delivered=${message.receipts.delivered} receipt_read=${message.receipts.read} receipt_played=${message.receipts.played}` : "";
  return `- [${stamp}] id=${message.id} status=${proto.WebMessageInfo.Status[message.deliveryStatus] ?? "unknown"} ${author}: ${message.text || `[${message.messageType}]`}${media}${receipts}`;
}

function formatTimestamp(value) {
  return value ? new Date(value * 1000).toISOString() : "unknown-time";
}

function textResult(text, { isError = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    isError
  };
}

function formatQrBlock(qrText) {
  return ["```text", qrText.trimEnd(), "```"].join("\n");
}

async function getBridgeState() {
  const [config, processStatus] = await Promise.all([
    controllerConfigStore.load(),
    getControllerProcessStatus()
  ]);

  return {
    config,
    processStatus,
    ownsLiveSession: config.enabled && processStatus.running
  };
}

async function ensureDirectRuntimeAvailable(action) {
  const bridgeState = await getBridgeState();
  if (bridgeState.ownsLiveSession) {
    throw new Error(
      `${action} is unavailable while the WhatsApp controller bridge is running because the daemon owns the live WhatsApp session. Stop the bridge or use cached data.`
    );
  }

  return runtime.ensureConnected();
}

function controllerSummaryLines(config, processStatus) {
  const lines = [
    `enabled: ${config.enabled ? "yes" : "no"}`,
    `running: ${processStatus.running ? "yes" : "no"}`,
    "codex_transport: app-server",
    `default_project: ${config.defaultProject}`,
    `workspace: ${config.workspace}`,
    `codex_bin: ${config.codexBin}`,
    `default_permission_level: ${config.permissionLevel}`,
    `capture_all_direct_messages: ${config.captureAllDirectMessages ? "yes" : "no"}`,
    `tts_provider: ${config.ttsProvider}`,
    `tts_chatterbox_allow_non_english: ${config.ttsChatterboxAllowNonEnglish ? "yes" : "no"}`,
    `allowed_controller_count: ${config.allowedControllers.length}`,
    `project_count: ${config.projects.length}`
  ];

  if (config.profile) {
    lines.push(`profile: ${config.profile}`);
  }

  if (config.model) {
    lines.push(`model: ${config.model}`);
  }

  if (processStatus.pid) {
    lines.push(`pid: ${processStatus.pid}`);
  }

  if (processStatus.process.startedAt) {
    lines.push(`started_at: ${processStatus.process.startedAt}`);
  }

  if (processStatus.process.heartbeatAt) {
    lines.push(`heartbeat_at: ${processStatus.process.heartbeatAt}`);
  }

  if (config.allowedControllers.length) {
    lines.push("");
    lines.push("allowed_controllers:");
    for (const controller of config.allowedControllers) {
      lines.push(
        `- ${controller.label ? `${controller.label} ` : ""}${controller.number}`
      );
    }
  }

  if (config.projects.length) {
    lines.push("");
    lines.push("projects:");
    for (const project of config.projects) {
      lines.push(
        `- ${project.alias}${project.alias === config.defaultProject ? " (default)" : ""} workspace=${project.workspace}`
      );
    }
  }

  if (processStatus.sessions.length) {
    lines.push("");
    lines.push("sessions:");
    for (const session of processStatus.sessions) {
      lines.push(
        `- ${session.label ? `${session.label} ` : ""}${session.phoneKey} active_project=${
          session.activeProject ?? config.defaultProject
        } thread=${
          session.threadId ? session.threadId.slice(0, 8) : "none"
        } permissions=${session.permissionLevel ?? config.permissionLevel}`
      );
    }
  }

  return lines;
}

function resolveChatOrError({ chatId, chatName }) {
  const resolved = runtime.store.resolveChat({ chatId, chatName });
  if (resolved.match) {
    return resolved.match;
  }

  if (resolved.candidates.length > 1) {
    throw new Error(
      `Multiple chats matched "${chatName}". Candidates:\n${resolved.candidates
        .slice(0, 10)
        .map(chatSummary)
        .join("\n")}`
    );
  }

  throw new Error(
    chatId
      ? `Chat "${chatId}" was not found in the local WhatsApp cache.`
      : `Chat "${chatName}" was not found in the local WhatsApp cache.`
  );
}

function resolveSendChatOrError({ chatId, chatName }) {
  if (chatId && !runtime.store.resolveChat({ chatId }).match) {
    if (!/^(?:\d{7,15}@s\.whatsapp\.net|\d+@lid|\d+(?:-\d+)?@g\.us)$/.test(chatId)) {
      throw new Error("An explicit recipient must be a valid WhatsApp chat ID.");
    }
    return { id: chatId, displayName: chatId };
  }
  return resolveChatOrError({ chatId, chatName });
}

const server = new McpServer({
  name: "whatsapp-relay",
  version: "0.2.0"
});

server.tool(
  "whatsapp_start_auth",
  "Start the local WhatsApp auth flow and return the current terminal-style QR code.",
  {},
  async () => {
    try {
      const result = await runtime.startAuthFlow();
      if (result.status === "connected") {
        return textResult(
          `WhatsApp is already connected as ${result.user?.id ?? "unknown"}.`
        );
      }

      return textResult(
        [
          "Scan this QR code directly from the terminal or Codex output.",
          "",
          formatQrBlock(result.qrText),
          "",
          "WhatsApp -> Settings -> Linked Devices -> Link a Device",
          "After scanning, call `whatsapp_auth_status` to confirm the session is connected.",
          "If terminal rendering is degraded, use the CLI fallback: `npm run whatsapp:auth`."
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_auth_status",
  "Show whether the local WhatsApp account is authenticated and connected.",
  {},
  async () => {
    const summary = runtime.summary();
    const bridgeState = await getBridgeState();
    const status =
      bridgeState.ownsLiveSession && summary.status === "idle"
        ? bridgeState.processStatus.process.whatsappStatus ?? "connected_via_bridge"
        : summary.status;
    const lines = [
      `status: ${status}`,
      `credentials: ${summary.hasCreds ? "present" : "missing"}`,
      `auth_file: ${credsFile}`,
      `cache_file: ${storeFile}`,
      `recent_chat_count: ${summary.recentChatCount}`
    ];
    lines.push(`cache_updated_at: ${runtime.store.data.meta.updatedAt ?? "unknown"}`);
    lines.push(`last_history_sync_at: ${runtime.store.data.meta.lastHistorySyncAt ?? "unknown"}`);
    lines.push(`last_message_event_at: ${runtime.store.data.meta.lastMessageEventAt ?? "unknown"}`);
    lines.push("history_completeness: not_verified");
    lines.push(`pending_notifications_received: ${summary.receivedPendingNotifications ? "yes" : "no"}`);
    lines.push("features: send_message_media_v1, read_message_media_v1, in_place_reload_v1, history_request_journal_v1, receipt_evidence_v1");

    if (summary.user?.id) {
      lines.push(`user: ${summary.user.id}`);
    }

    if (bridgeState.ownsLiveSession) {
      lines.push("live_session_owner: controller_bridge");
      if (bridgeState.processStatus.process.whatsappUserId) {
        lines.push(`user: ${bridgeState.processStatus.process.whatsappUserId}`);
      }
    }

    if (summary.lastQrAt) {
      lines.push(`last_qr_at: ${summary.lastQrAt}`);
    }

    if (summary.currentQrText) {
      lines.push("qr_ready: yes");
      lines.push("");
      lines.push("current_qr:");
      lines.push(formatQrBlock(summary.currentQrText));
    }

    if (summary.lastDisconnect?.label) {
      lines.push(`last_disconnect: ${summary.lastDisconnect.label}`);
    } else if (bridgeState.processStatus.process.whatsappLastDisconnect?.label) {
      lines.push(
        `last_disconnect: ${bridgeState.processStatus.process.whatsappLastDisconnect.label}`
      );
    }

    if (!summary.hasCreds) {
      lines.push("next_step: call `whatsapp_start_auth` to get a QR code");
    }

    return textResult(lines.join("\n"));
  }
);

server.tool(
  "whatsapp_allow_controller",
  "Allow a WhatsApp number to control Codex through the controller bridge.",
  {
    number: z.string().min(5),
    label: z.string().min(1).optional()
  },
  async ({ number, label }) => {
    try {
      const controller = await controllerConfigStore.allowController({ number, label });
      return textResult(
        [
          `Allowed controller: ${controller.label ? `${controller.label} ` : ""}${
            controller.number
          }`,
          "Next step: call `whatsapp_start_controller_bridge` to enable phone control."
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_revoke_controller",
  "Remove a WhatsApp number from the controller allowlist.",
  {
    number: z.string().min(5)
  },
  async ({ number }) => {
    try {
      const removed = await controllerConfigStore.revokeController(number);
      return textResult(
        removed
          ? `Removed ${number} from the WhatsApp controller allowlist.`
          : `${number} was not in the WhatsApp controller allowlist.`
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_controller_status",
  "Show whether the WhatsApp-to-Codex controller bridge is configured and running.",
  {},
  async () => {
    try {
      const config = await controllerConfigStore.load();
      const processStatus = await getControllerProcessStatus();
      return textResult(controllerSummaryLines(config, processStatus).join("\n"));
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_start_controller_bridge",
  "Start the background WhatsApp-to-Codex controller bridge for allowed numbers.",
  {
    workspace: z.string().min(1).optional(),
    defaultProject: z.string().min(1).optional(),
    projects: z
      .array(
        z.object({
          alias: z.string().min(1).optional(),
          workspace: z.string().min(1),
          model: z.string().min(1).optional(),
          profile: z.string().min(1).optional(),
          permissionLevel: z.string().min(1).optional(),
          search: z.boolean().optional()
        })
      )
      .min(1)
      .optional(),
    model: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    permissionLevel: z.string().min(1).optional(),
    search: z.boolean().optional(),
    captureAllDirectMessages: z.boolean().optional(),
    ttsProvider: z.string().min(1).optional(),
    ttsChatterboxAllowNonEnglish: z.boolean().optional()
  },
  async ({
    workspace,
    defaultProject,
    projects,
    model,
    profile,
    permissionLevel,
    search,
    captureAllDirectMessages,
    ttsProvider,
    ttsChatterboxAllowNonEnglish
  }) => {
    try {
      if (!runtime.hasSavedCreds()) {
        throw new Error(
          "WhatsApp is not authenticated yet. Run `whatsapp_start_auth` before starting the controller bridge."
        );
      }

      if (permissionLevel && !normalizePermissionLevel(permissionLevel)) {
        throw new Error(
          "Unknown permissionLevel. Use read-only, workspace-write, or danger-full-access."
        );
      }

      if (ttsProvider && normalizeTtsProvider(ttsProvider, null) === null) {
        throw new Error("Unknown ttsProvider. Use system or chatterbox-turbo.");
      }

      const config = await controllerConfigStore.update({
        enabled: true,
        ...(workspace ? { workspace } : {}),
        ...(defaultProject ? { defaultProject } : {}),
        ...(projects ? { projects } : {}),
        ...(model ? { model } : {}),
        ...(profile ? { profile } : {}),
        ...(permissionLevel
          ? { permissionLevel: resolvePermissionLevel(permissionLevel) }
          : {}),
        ...(typeof search === "boolean" ? { search } : {}),
        ...(typeof captureAllDirectMessages === "boolean"
          ? { captureAllDirectMessages }
          : {}),
        ...(ttsProvider ? { ttsProvider: normalizeTtsProvider(ttsProvider, "system") } : {}),
        ...(typeof ttsChatterboxAllowNonEnglish === "boolean"
          ? { ttsChatterboxAllowNonEnglish }
          : {})
      });

      if (!config.allowedControllers.length) {
        throw new Error(
          "No allowed controller numbers are configured yet. Call `whatsapp_allow_controller` first."
        );
      }

      const processStatus = await startControllerDaemon();
      return textResult(
        [
          "WhatsApp controller bridge is running.",
          ...controllerSummaryLines(config, processStatus),
          "",
          "Allowed direct chats can now send plain text to continue their Codex session.",
          "Bridge commands: /projects, /project <n|alias|hint>, /in, /btw, /n, /st, /ls, /1 or /session, /p, /a, /d, /q, /x, /h"
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_stop_controller_bridge",
  "Stop the background WhatsApp-to-Codex controller bridge.",
  {},
  async () => {
    try {
      const config = await controllerConfigStore.update({
        enabled: false
      });
      const processStatus = await stopControllerDaemon();
      return textResult(
        [
          "WhatsApp controller bridge stopped.",
          ...controllerSummaryLines(config, processStatus)
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_list_chats",
  "List recent WhatsApp chats from the local cache.",
  {
    limit: z.number().int().min(1).max(100).optional(),
    query: z.string().min(1).optional(),
    unreadOnly: z.boolean().optional()
  },
  async ({ limit = 20, query, unreadOnly = false }) => {
    try {
      if (runtime.state.status !== "connected") await runtime.store.load();
      const chats = runtime.store.listChats({ limit, query, unreadOnly });
      if (!chats.length) {
        return textResult("No chats matched the requested filter.");
      }

      return textResult(["source: local_cache", "history_completeness: not_verified", ...chats.map(chatSummary)].join("\n"));
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_read_messages",
  "Read cached messages and media metadata from a chat. Reports sync metadata; cached history is not guaranteed to include the latest phone messages.",
  {
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    messageId: z.string().min(1).optional(),
    downloadMedia: z.boolean().optional()
  },
  async ({ chatId, chatName, limit = 20, messageId, downloadMedia = false }) => {
    try {
      if (runtime.state.status !== "connected") await runtime.store.load();
      const chat = resolveChatOrError({ chatId, chatName });
      if (downloadMedia) {
        if (!messageId) throw new Error("Downloading media requires an exact messageId.");
        return await downloadCachedMedia(chat, messageId);
      }
      const messages = messageId
        ? runtime.store.getMessages(chat.id, runtime.store.getMessageLimit(chat.id)).filter(message => message.id === messageId)
        : runtime.store.getMessages(chat.id, limit);

      if (!messages.length) {
        return textResult(`No cached messages found for ${chat.displayName}.`);
      }

      return textResult(
        [`chat: ${chat.displayName} (${chat.id})`, "source: local_cache", "history_completeness: not_verified",
          `connection: ${runtime.state.status}`, `last_history_sync_at: ${runtime.store.data.meta.lastHistorySyncAt ?? "unknown"}`,
          `last_message_event_at: ${runtime.store.data.meta.lastMessageEventAt ?? "unknown"}`,
          ...messages.map(messageSummary)].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_sync_history",
  "Request older messages with durable request IDs. Use statusOnly to reconcile delayed responses without another phone request. Unresolved requests at the same anchor are never automatically repeated.",
  {
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    count: z.number().int().min(1).max(50).optional(),
    beforeMessageId: z.string().min(1).optional(),
    statusOnly: z.boolean().optional(),
    requestId: z.string().min(1).optional()
  },
  async ({ chatId, chatName, count = 50, beforeMessageId, statusOnly = false, requestId }) => {
    try {
      if (statusOnly || requestId) {
        await runtime.historyRequests.load();
        const canonicalChatId = chatId || chatName ? resolveChatOrError({ chatId, chatName }).id : undefined;
        return textResult(JSON.stringify({ source: "history_request_journal", new_request_sent: false,
          requests: runtime.historyRequests.list(canonicalChatId, requestId) }, null, 2));
      }
      await ensureDirectRuntimeAvailable("History sync");
      const chat = resolveChatOrError({ chatId, chatName });
      const result = await runtime.syncChatHistory({
        chatId: chat.id,
        count,
        beforeMessageId
      });

      return textResult(
        [
          `chat: ${chat.displayName} (${chat.id})`,
          `requested: ${count}`,
          `history_events: ${result.events ?? 0}`,
          `messages_received: ${result.messages ?? 0}`,
          `response_correlation: ${result.sessionMatched ? "matched_session" : "none"}`,
          `received_message_ids: ${JSON.stringify(result.receivedMessageIds)}`,
          `cache_before: ${result.beforeCount}`,
          `cache_after: ${result.afterCount}`,
          `anchor_message_id: ${result.anchorMessageId}`,
          `anchor_timestamp: ${formatTimestamp(result.anchorTimestamp)}`,
          `oldest_before: ${formatTimestamp(result.oldestTimestampBefore)}`,
          `oldest_after: ${formatTimestamp(result.oldestTimestampAfter)}`,
          `retention_limit: ${result.retentionLimit}`,
          `session_id: ${result.sessionId}`,
          `reused_previous_request: ${Boolean(result.reused)}`,
          `request_state: ${result.state}`,
          ...(result.error ? [`request_error: ${result.error}`] : []),
          `status: ${result.state === "response_received" ? "ok" : result.state}`
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

const mediaInput = {
  filePath: z.string().min(1),
  mediaType: z.enum(["image", "video", "audio", "document", "sticker"]),
  caption: z.string().max(1024).optional(),
  mimetype: z.string().min(1).optional(),
  voiceNote: z.boolean().optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
};

async function submitMedia(chat, input) {
  const media = await prepareMedia(input);
  const bridge = await getBridgeState();
  if (bridge.ownsLiveSession) {
    const command = await enqueueControllerCommand({ type: "send_media", payload: {
      chatId: chat.id, ...input, filePath: media.filePath, expectedSha256: media.sha256
    } });
    return textResult(`status: queued\ncommand_id: ${command.id}\ndelivery: not_yet_verified`);
  }
  const frozen = await freezePreparedMedia(media);
  const socket = await runtime.ensureConnected();
  const sent = await socket.sendMessage(chat.id, frozen.content);
  if (!sent?.key?.id) throw new Error("No message ID returned; outcome unknown. Do not automatically retry.");
  runtime.store.ingestMessage(sent, { incrementUnread: false });
  return textResult(`status: submitted\nchat: ${chat.displayName} (${chat.id})\nmessage_id: ${sent.key.id}\nsha256: ${media.sha256}\ndelivery: not_yet_verified`);
}

async function downloadCachedMedia(chat, messageId) {
  await ensureDirectRuntimeAvailable("Media download");
  const raw = runtime.store.getRawMessage(chat.id, messageId);
  const file = await downloadMessageMedia(raw, runtime.socket, { logger: runtime.logger });
  const content = [{ type: "text", text: `Downloaded media: ${file.path}\nmimetype: ${file.mimetype}\nbytes: ${file.bytes}` }];
  const audio = unwrapMessage(raw.message)?.audioMessage;
  if (audio) {
    try {
      const prepared = await prepareMedia({ filePath: file.path, mediaType: "audio", voiceNote: Boolean(audio.ptt) });
      content[0].text += `\naudio_preflight: supported\nnormalized_audio_mimetype: ${prepared.mimetype}\nsha256: ${prepared.sha256}\nnew_message_sent: false`;
    } catch (error) {
      content[0].text += `\naudio_preflight: unsupported\naudio_preflight_error: ${error.message}\nnew_message_sent: false`;
    }
  }
  if (["image/png", "image/jpeg", "image/webp"].includes(file.mimetype) && file.bytes <= 8 * 1024 * 1024) {
    content.push({ type: "image", mimeType: file.mimetype, data: (await fs.readFile(file.path)).toString("base64") });
  }
  return { content, isError: false };
}

server.tool(
  "whatsapp_send_message",
  "Send text or approved local media to a WhatsApp chat. Use media for image/video/audio/document/sticker and its reviewed file hash; text must be empty when media is provided.",
  {
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    text: z.string().max(4000).optional(),
    media: z.object(mediaInput).optional()
  },
  async ({ chatId, chatName, text, media }) => {
    try {
      const chat = resolveSendChatOrError({ chatId, chatName });
      if (media) {
        if (text?.trim()) throw new Error("Use media.caption instead of a separate text when sending media.");
        return await submitMedia(chat, media);
      }
      if (typeof text !== "string" || !text.trim()) throw new Error("A nonempty text or a media attachment is required.");
      const bridgeState = await getBridgeState();

      if (bridgeState.ownsLiveSession) {
        await enqueueControllerCommand({
          type: "send_message",
          payload: {
            chatId: chat.id,
            text
          }
        });
        return textResult(
          `Queued message to ${chat.displayName} (${chat.id}) through the controller bridge.`
        );
      }

      const socket = await runtime.ensureConnected();
      const sent = await socket.sendMessage(chat.id, { text });
      if (!sent?.key?.id) throw new Error("No message ID returned; outcome unknown. Do not automatically retry.");
      runtime.store.ingestMessage(sent, { incrementUnread: false });
      return textResult(`status: submitted\nchat: ${chat.displayName} (${chat.id})\nmessage_id: ${sent.key.id}\ndelivery: not_yet_verified`);
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool("whatsapp_prepare_media", "Validate a local image, video, audio, document or sticker and return its hash for review. Does not upload or send anything.", mediaInput, async input => {
  try {
    const { content, ...metadata } = await prepareMedia(input);
    return textResult(JSON.stringify(metadata, null, 2));
  } catch (error) { return textResult(error.message, { isError: true }); }
});

server.tool("whatsapp_send_media", "Send an approved local image, video, audio/voice note, document or WebP sticker. Use prepare_media for the exact file hash; submission is not delivery confirmation.", {
  chatId: z.string().min(1).optional(), chatName: z.string().min(1).optional(), ...mediaInput
}, async ({ chatId, chatName, ...input }) => {
  try {
    const chat = resolveSendChatOrError({ chatId, chatName });
    return await submitMedia(chat, input);
  } catch (error) { return textResult(error.message, { isError: true }); }
});

server.tool("whatsapp_download_media", "Download media from a cached message ID to a private local file. Returns an inline preview for small images. View-once media is excluded.", {
  chatId: z.string().min(1).optional(), chatName: z.string().min(1).optional(), messageId: z.string().min(1)
}, async ({ chatId, chatName, messageId }) => {
  try {
    const chat = resolveChatOrError({ chatId, chatName });
    return await downloadCachedMedia(chat, messageId);
  } catch (error) { return textResult(error.message, { isError: true }); }
});

server.tool("whatsapp_message_status", "Read the latest cached acknowledgement status for a specific message ID; does not mark messages read or send anything.", {
  chatId: z.string().min(1).optional(), chatName: z.string().min(1).optional(), messageId: z.string().min(1)
}, async ({ chatId, chatName, messageId }) => {
  try {
    if (runtime.state.status !== "connected") await runtime.store.load();
    const chat = resolveChatOrError({ chatId, chatName });
    const entry = (runtime.store.data.messages[chat.id] ?? []).find(message => message.id === messageId);
    if (!entry) throw new Error("Message ID not found in this chat's cache.");
    return textResult(`source: local_cache\nmessage_id: ${messageId}\nstatus: ${proto.WebMessageInfo.Status[entry.deliveryStatus] ?? "unknown"}`);
  } catch (error) { return textResult(error.message, { isError: true }); }
});

const transport = new StdioServerTransport();
let reloading = false;
process.on("SIGHUP", async () => {
  if (reloading) return;
  if (typeof process.execve !== "function") {
    console.error("In-place MCP reload requires a Node.js version with process.execve.");
    return;
  }
  reloading = true;
  try {
    clearTimeout(runtime.store.pendingSave);
    runtime.store.pendingSave = null;
    await runtime.store.save();
    await runtime.historyRequests.writes;
    // Preserve the host's stdio transport while replacing only this MCP worker.
    process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
  } catch (error) {
    reloading = false;
    console.error("WhatsApp MCP reload failed", error.message);
  }
});
await server.connect(transport);
server.sendToolListChanged();
