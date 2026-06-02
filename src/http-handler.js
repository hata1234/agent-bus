import {
  blockTask,
  cancelTask,
  claimTask,
  completeTask,
  createEvent,
  createTask,
  dispatchTask,
  failTask,
  getEvent,
  getTask,
  listLifecycleEvents,
  listEvents,
  listTasks,
  markTaskLate,
  markTaskWakeRequested,
  markWakeRequested,
  recordArtifact,
  recordHeartbeat,
  reconcileTask,
  reportTaskResult,
  requestRetry,
  resolveDbPath,
} from "./store.js";

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

function buildTaskWakeText(task) {
  return [
    `[Agent Bus Task] task_id=${task.task_id}`,
    `target_agent=${task.target_agent}`,
    `status=${task.status}`,
    `objective=${task.objective}`,
    "Read the assigned task packet/artifact root before claiming.",
  ].join(" ");
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

export function createAgentBusHttpHandler({ api, db, config, defaults, routePath }) {
  const taskRoutesEnabled = config.taskRoutesEnabled === true;
  const specialistTaskWritesEnabled = config.specialistTaskWritesEnabled === true;
  const ownerTaskRouteKey = typeof config.ownerTaskRouteKey === "string" ? config.ownerTaskRouteKey : "";

  return async (req, res) => {
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
          wake = api.wakeSession ? api.wakeSession(event, "agent-bus event created") : { ok: false, reason: "wake_unavailable" };
          markWakeRequested(db, event.id);
        }
        json(res, 201, { ok: true, event: publicEvent(getEvent(db, event.id)), wake });
        return true;
      }

      const taskRoute = taskIdFromPath(path);
      const isTaskCollectionRoute = path === "/tasks";
      if ((isTaskCollectionRoute || taskRoute) && !taskRoutesEnabled) {
        return guarded(res, 404, "task_routes_disabled");
      }

      if (req.method === "GET" && path === "/tasks") {
        const rows = listTasks(db, {
          status: query.get("status") || undefined,
          targetAgent: query.get("target_agent") || undefined,
          targetSessionKey: query.get("target_session_key") || undefined,
          limit: query.get("limit") || undefined,
        });
        json(res, 200, { ok: true, tasks: rows });
        return true;
      }

      if (req.method === "POST" && path === "/tasks") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        const task = createTask(db, body);
        json(res, 201, { ok: true, task });
        return true;
      }

      if (req.method === "GET" && taskRoute && taskRoute.action === "") {
        const task = getTask(db, taskRoute.taskId);
        if (!task) {
          json(res, 404, { ok: false, error: "task_not_found" });
          return true;
        }
        json(res, 200, { ok: true, task });
        return true;
      }

      if (req.method === "GET" && taskRoute && taskRoute.action === "events") {
        const task = getTask(db, taskRoute.taskId);
        if (!task) {
          json(res, 404, { ok: false, error: "task_not_found" });
          return true;
        }
        json(res, 200, { ok: true, events: listLifecycleEvents(db, { taskId: taskRoute.taskId, limit: query.get("limit") || undefined }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "dispatch") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        let task = dispatchTask(db, taskRoute.taskId);
        const wake = wakeTaskSession(api, task, "agent-bus task dispatch");
        task = markTaskWakeRequested(db, task.task_id);
        json(res, 200, { ok: true, task, wake });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "claim") {
        if (!specialistTaskWritesEnabled) return guarded(res, 403, "specialist_task_writes_disabled");
        const body = await readJson(req);
        json(res, 200, { ok: true, ...claimTask(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "heartbeat") {
        if (!specialistTaskWritesEnabled) return guarded(res, 403, "specialist_task_writes_disabled");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: recordHeartbeat(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "artifacts") {
        if (!specialistTaskWritesEnabled) return guarded(res, 403, "specialist_task_writes_disabled");
        const body = await readJson(req);
        json(res, 200, { ok: true, ...recordArtifact(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "result") {
        if (!specialistTaskWritesEnabled) return guarded(res, 403, "specialist_task_writes_disabled");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: reportTaskResult(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "ack") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        json(res, 200, { ok: true, task: completeTask(db, taskRoute.taskId) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "late") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: markTaskLate(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "block") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: blockTask(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "fail") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: failTask(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "cancel") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: cancelTask(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "retry") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: requestRetry(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      if (req.method === "POST" && taskRoute && taskRoute.action === "reconcile") {
        if (!isOwnerRequest(req, ownerTaskRouteKey)) return guarded(res, 403, "owner_route_forbidden");
        const body = await readJson(req);
        json(res, 200, { ok: true, task: reconcileTask(db, { ...body, task_id: taskRoute.taskId }) });
        return true;
      }

      json(res, 404, { ok: false, error: "not_found" });
      return true;
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };
}
