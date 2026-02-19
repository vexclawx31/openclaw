import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

type MacvoiceAccount = {
  accountId: string;
  enabled: boolean;
};

const MacvoiceChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      sharedSessionKey: { type: "string", minLength: 1 },
      allowOrigins: {
        type: "array",
        items: { type: "string" },
        default: ["*"],
      },
    },
  },
} as const;

const CHANNEL_ID = "macvoice" as const;

function parseJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: import("node:http").ServerResponse, status: number, payload: unknown) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(payload));
}

function buildCorsHeaders(origin: string | undefined, allowOrigins: string[]): Record<string, string> {
  const normalized = allowOrigins.map((x) => x.trim()).filter(Boolean);
  const wildcard = normalized.includes("*");
  const allowOrigin = wildcard ? (origin || "*") : normalized.includes(origin || "") ? (origin || "") : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin || "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

const macvoicePlugin: ChannelPlugin<MacvoiceAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "MacVoice",
    selectionLabel: "MacVoice (Local App)",
    detailLabel: "Mac Voice",
    docsPath: "/channels/macvoice",
    docsLabel: "macvoice",
    blurb: "Local macOS voice channel for custom desktop clients.",
    aliases: ["mac"],
    systemImage: "waveform",
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  configSchema: MacvoiceChannelConfigSchema,
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (cfg, _accountId) => {
      const enabled = cfg.channels?.macvoice?.enabled !== false;
      return { accountId: "default", enabled };
    },
    defaultAccountId: () => "default",
    isConfigured: () => true,
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to }) => ({
      channel: CHANNEL_ID,
      messageId: `macvoice:${Date.now()}`,
      chatId: to,
      timestamp: Date.now(),
    }),
  },
};

const plugin = {
  id: CHANNEL_ID,
  name: "MacVoice",
  description: "macOS voice channel bridge",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: macvoicePlugin as ChannelPlugin });


    api.registerHttpRoute({
      path: "/api/channels/macvoice/health",
      handler: async (req, res) => {
        const cfg = api.runtime.config.loadConfig();
        const allowOrigins = (cfg.channels?.macvoice?.allowOrigins as string[] | undefined) ?? ["*"];
        const cors = buildCorsHeaders(typeof req.headers.origin === "string" ? req.headers.origin : undefined, allowOrigins);
        for (const [k, v] of Object.entries(cors)) {
          res.setHeader(k, v);
        }

        if (req.method === "OPTIONS") {
          writeJson(res, 204, { ok: true });
          return;
        }

        if (req.method !== "GET") {
          writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }

        writeJson(res, 200, {
          ok: true,
          channel: CHANNEL_ID,
          status: "ready",
          sharedSessionKey:
            typeof cfg.channels?.macvoice?.sharedSessionKey === "string"
              ? cfg.channels.macvoice.sharedSessionKey
              : null,
        });
      },
    });

    api.registerHttpRoute({
      path: "/api/channels/macvoice/message",
      handler: async (req, res) => {
        const cfg = api.runtime.config.loadConfig();
        const allowOrigins = (cfg.channels?.macvoice?.allowOrigins as string[] | undefined) ?? ["*"];
        const cors = buildCorsHeaders(typeof req.headers.origin === "string" ? req.headers.origin : undefined, allowOrigins);
        for (const [k, v] of Object.entries(cors)) {
          res.setHeader(k, v);
        }

        if (req.method === "OPTIONS") {
          writeJson(res, 204, { ok: true });
          return;
        }

        if (req.method !== "POST") {
          writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }

        try {
          const body = await parseJsonBody(req);
          const message = String(body.message ?? "").trim();
          const clientId = String(body.clientId ?? "macbook").trim() || "macbook";
          const requestedSession = String(body.sessionId ?? body.sessionKey ?? "").trim();

          if (!message) {
            writeJson(res, 400, { error: "message is required" });
            return;
          }

          const route = api.runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: CHANNEL_ID,
            accountId: "default",
            peer: { kind: "direct", id: clientId },
          });

          const sessionKey =
            requestedSession ||
            (typeof cfg.channels?.macvoice?.sharedSessionKey === "string"
              ? cfg.channels.macvoice.sharedSessionKey.trim()
              : "") ||
            route.sessionKey;

          const storePath = api.runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          const previousTimestamp = api.runtime.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey,
          });
          const envelopeOptions = api.runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const now = Date.now();
          const wrapped = api.runtime.channel.reply.formatAgentEnvelope({
            channel: "MacVoice",
            from: clientId,
            timestamp: now,
            previousTimestamp,
            envelope: envelopeOptions,
            body: message,
          });

          const ctx = api.runtime.channel.reply.finalizeInboundContext({
            Body: wrapped,
            RawBody: message,
            CommandBody: message,
            BodyForAgent: message,
            BodyForCommands: message,
            From: `macvoice:${clientId}`,
            To: "macvoice:assistant",
            Provider: CHANNEL_ID,
            Surface: CHANNEL_ID,
            OriginatingChannel: CHANNEL_ID,
            OriginatingTo: "macvoice:assistant",
            SessionKey: sessionKey,
            AccountId: "default",
            ChatType: "direct",
            ConversationLabel: `MacVoice ${clientId}`,
            SenderId: clientId,
            SenderName: clientId,
            MessageSid: `macvoice-${now}`,
            Timestamp: now,
            CommandAuthorized: true,
          });

          await api.runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey,
            ctx,
            onRecordError: (err) => {
              api.logger.warn(`macvoice: failed updating session meta: ${String(err)}`);
            },
          });

          const chunks: string[] = [];

          await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx,
            cfg,
            dispatcherOptions: {
              deliver: async (payload) => {
                const text = typeof payload.text === "string" ? payload.text.trim() : "";
                if (text) {
                  chunks.push(text);
                }
              },
              onError: (err) => {
                api.logger.warn(`macvoice: dispatch error: ${String(err)}`);
              },
            },
            replyOptions: {
              disableBlockStreaming: true,
            },
          });

          writeJson(res, 200, {
            ok: true,
            channel: CHANNEL_ID,
            sessionKey,
            reply: chunks.join("\n\n").trim() || "(no reply)",
          });
        } catch (err) {
          writeJson(res, 500, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });
  },
};

export default plugin;
