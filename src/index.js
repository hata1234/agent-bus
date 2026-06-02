import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentBusHttpHandler } from "./http-handler.js";
import {
  ackEvent,
  completeTask,
  createEvent,
  formatPendingEvents,
  getEvent,
  listEvents,
  listPendingForSession,
  markInjected,
  markWakeRequested,
  openEventStore,
  resolveDbPath,
} from "./store.js";

const DEFAULT_ROUTE = "/plugins/agent-bus";
const DEFAULT_LIMIT = 5;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function guarded(res, status, error) {
  json(res, status, { ok: false, error });
  return true;
}

function readBody(req, maxBytes = 256_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function relativePath(url, routePath) {
  const parsed = new URL(url || "/", "http://localhost");
  let path = parsed.pathname;
  if (path === routePath) return { path: "/", query: parsed.searchParams };
  if (path.startsWith(`${routePath}/`)) {
    path = path.slice(routePath.length);
  }
  return { path, query: parsed.searchParams };
}

function buildWakeText(event) {
  return [
    `[Agent Bus] event_id=${event.id}`,
    `source=${event.source_agent}`,
    `severity=${event.severity}`,
    `kind=${event.kind}`,
    `summary=${event.summary}`,
    "Read pending Agent Bus events from plugin context before responding.",
  ].join(" ");
}

function buildTaskWakeText(task) {
  return [
    `[Agent Bus Task] task_id=${task.task_id}`,
    `target_agent=${task.target_agent}`,
    `status=${task.status}`,
    `objective=${task.objective}`,
    "Read the assigned task packet/artifact root before claiming.",
  ].join(" ");
}

function wakeSession(api, event, reason = "agent-bus event") {
  const runtime = api.runtime;
  if (!runtime?.system?.enqueueSystemEvent || !runtime?.system?.requestHeartbeat) {
    return { ok: false, reason: "runtime_system_api_unavailable" };
  }

  const queued = runtime.system.enqueueSystemEvent(buildWakeText(event), {
    sessionKey: event.target_session_key,
    contextKey: `agent-bus:${event.id}`,
  });
  runtime.system.requestHeartbeat({
    source: "hook",
    intent: "event",
    reason,
    agentId: event.target_agent_id || undefined,
    sessionKey: event.target_session_key,
  });
  return { ok: true, queued };
}

function wakeTaskSession(api, task, reason = "agent-bus task dispatch") {
  const runtime = api.runtime;
  if (!runtime?.system?.enqueueSystemEvent || !runtime?.system?.requestHeartbeat) {
    return { ok: false, reason: "runtime_system_api_unavailable" };
  }

  const queued = runtime.system.enqueueSystemEvent(buildTaskWakeText(task), {
    sessionKey: task.target_session_key,
    contextKey: `agent-bus-task:${task.task_id}`,
  });
  runtime.system.requestHeartbeat({
    source: "hook",
    intent: "event",
    reason,
    agentId: task.target_agent || undefined,
    sessionKey: task.target_session_key,
  });
  return { ok: true, queued };
}

function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_agent: row.source_agent,
    source_session: row.source_session,
    task_id: row.task_id,
    kind: row.kind,
    severity: row.severity,
    target_session_key: row.target_session_key,
    target_agent_id: row.target_agent_id,
    summary: row.summary,
    detail: row.detail,
    artifact_path: row.artifact_path,
    status: row.status,
    wake_requested_at: row.wake_requested_at,
    injected_at: row.injected_at,
    acked_at: row.acked_at,
  };
}

function taskIdFromPath(path) {
  const match = path.match(/^\/tasks\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return {
    taskId: decodeURIComponent(match[1]),
    action: match[2] || "",
  };
}

function isOwnerRequest(req, ownerKey) {
  return Boolean(ownerKey) && req.headers["x-agent-bus-owner-key"] === ownerKey;
}

function createEmitTool(api, db, defaults) {
  return {
    name: "agent_bus_emit",
    label: "Agent Bus Emit",
    description: "Write a concise internal agent event to the local Agent Bus SQLite store and optionally wake the target session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["source_agent", "summary"],
      properties: {
        source_agent: { type: "string", minLength: 1 },
        source_session: { type: "string" },
        task_id: { type: "string" },
        kind: { type: "string", description: "Short machine kind, e.g. task_complete, blocker, watchdog_finding." },
        severity: { type: "string", enum: ["debug", "info", "success", "warning", "error", "critical"] },
        target_session_key: { type: "string" },
        target_agent_id: { type: "string" },
        summary: { type: "string", minLength: 1 },
        detail: { type: "string" },
        artifact_path: { type: "string" },
        payload: { type: "object" },
        wake: { type: "boolean" },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams || {};
      const event = createEvent(db, params, defaults);
      let wake = { ok: false, reason: "wake_not_requested" };
      if (params.wake !== false) {
        wake = wakeSession(api, event, "agent-bus tool event");
        markWakeRequested(db, event.id);
      }
      const stored = publicEvent(getEvent(db, event.id));
      return {
        content: [
          {
            type: "text",
            text: `AGENT_BUS_EVENT ${stored.id} status=${stored.status} target=${stored.target_session_key} wake=${wake.ok ? "requested" : "skipped"}`,
          },
        ],
        details: { event: stored, wake },
      };
    },
  };
}

export default definePluginEntry({
  id: "agent-bus",
  name: "Agent Bus",
  description: "Local SQLite event bus for agent-to-main notifications and targeted session wakeups.",
  kind: "tool",
  register(api) {
    const config = api.pluginConfig || {};
    if (config.enabled !== true) {
      api.logger.info("agent-bus disabled; set plugin config enabled=true to register routes and prompt injection");
      return;
    }

    const routePath = config.routePath || DEFAULT_ROUTE;
    const db = openEventStore(resolveDbPath(config));
    const defaultTargetSessionKey = config.defaultTargetSessionKey;
    const defaultTargetAgentId = config.defaultTargetAgentId || "main";
    const injectLimit = Math.max(1, Math.min(20, Number(config.injectLimit) || DEFAULT_LIMIT));
    const taskRoutesEnabled = config.taskRoutesEnabled === true;
    const specialistTaskWritesEnabled = config.specialistTaskWritesEnabled === true;
    const ownerTaskRouteKey = typeof config.ownerTaskRouteKey === "string" ? config.ownerTaskRouteKey : "";
    const defaults = {
      targetSessionKey: defaultTargetSessionKey,
      targetAgentId: defaultTargetAgentId,
    };

    if (api.registerTool) {
      api.registerTool(() => createEmitTool(api, db, defaults), { name: "agent_bus_emit" });
    }

    api.registerHttpRoute({
      path: routePath,
      match: "prefix",
      auth: "gateway",
      handler: async (req, res) => {
        const { path, query } = relativePath(req.url, routePath);

        try {
          if (req.method === "GET" && path === "/health") {
            json(res, 200, { ok: true, route: routePath, dbPath: resolveDbPath(config) });
            return true;
          }

          if (req.method === "GET" && path === "/events") {
            const rows = listEvents(db, {
              status: query.get("status") || undefined,
              targetSessionKey: query.get("target_session_key") || undefined,
              limit: query.get("limit") || undefined,
            }).map(publicEvent);
            json(res, 200, { ok: true, events: rows });
            return true;
          }

          if (req.method === "POST" && path === "/events") {
            const body = await readJson(req);
            const event = createEvent(db, body, defaults);
            let wake = { ok: false, reason: "wake_not_requested" };
            if (body.wake !== false) {
              wake = wakeSession(api, event, "agent-bus event created");
              markWakeRequested(db, event.id);
            }
            json(res, 201, { ok: true, event: publicEvent(getEvent(db, event.id)), wake });
            return true;
          }

          if (req.method === "POST" && path === "/wake") {
            const body = await readJson(req);
            const event = getEvent(db, body.id || body.event_id);
            if (!event) {
              json(res, 404, { ok: false, error: "event_not_found" });
              return true;
            }
            const wake = wakeSession(api, event, "agent-bus wake requested");
            markWakeRequested(db, event.id);
            json(res, 200, { ok: true, event: publicEvent(getEvent(db, event.id)), wake });
            return true;
          }

          const ackMatch = path.match(/^\/events\/([^/]+)\/ack$/);
          if (req.method === "POST" && ackMatch) {
            const event = ackEvent(db, decodeURIComponent(ackMatch[1]));
            if (!event) {
              json(res, 404, { ok: false, error: "event_not_found" });
              return true;
            }
            json(res, 200, { ok: true, event: publicEvent(event) });
            return true;
          }

          return createAgentBusHttpHandler({ api, db, config, defaults, routePath })(req, res);
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      },
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return undefined;
      const events = listPendingForSession(db, sessionKey, injectLimit);
      if (!events.length) return undefined;
      const prependContext = formatPendingEvents(events);
      markInjected(db, events.map((event) => event.id));
      return { prependContext };
    }, { priority: 40 });
  },
});
