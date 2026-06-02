import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentBusHttpHandler } from "../src/http-handler.js";
import { openEventStore } from "../src/store.js";

const ROUTE = "/plugins/agent-bus";
const OWNER_KEY = "test-owner-key";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-http-"));
  return openEventStore(join(dir, "events.sqlite"));
}

function safeTask(overrides = {}) {
  return {
    task_id: "http-owner-1",
    source_agent: "main-agent",
    source_session_key: "agent:main:telegram:direct:USER_ID",
    target_agent: "agent-engineer",
    target_session_key: "agent:agent-engineer:main",
    objective: "HTTP route activation smoke task.",
    artifact_root: "runs/http-owner-1",
    completion_contract: {
      result_file: "runs/http-owner-1/result.json",
      deliver_to_user: false,
      required_artifacts: [],
      result_schema: null,
    },
    safety_boundary: {
      runtime_mutation: false,
      external_delivery: false,
      credential_access: false,
      db_mutation: false,
      notes: "http handler test",
    },
    ...overrides,
  };
}

function makeApi() {
  return {
    runtime: {
      system: {
        enqueueSystemEvent: () => ({ queued: true }),
        requestHeartbeat: () => ({ requested: true }),
      },
    },
  };
}

async function withServer(config, fn) {
  const db = tempDb();
  const handler = createAgentBusHttpHandler({
    api: makeApi(),
    db,
    config,
    defaults: { targetSessionKey: "agent:main:telegram:direct:USER_ID", targetAgentId: "main" },
    routePath: ROUTE,
  });
  const server = createServer((req, res) => {
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(baseUrl, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

test("HTTP task routes stay disabled by default", async () => {
  await withServer({
    enabled: true,
    dbPath: ":memory:",
    taskRoutesEnabled: false,
    specialistTaskWritesEnabled: false,
  }, async (baseUrl) => {
    const list = await requestJson(baseUrl, `${ROUTE}/tasks`);
    assert.equal(list.status, 404);
    assert.equal(list.body.error, "task_routes_disabled");

    const create = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask(),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(create.status, 404);
    assert.equal(create.body.error, "task_routes_disabled");
  });
});

test("owner-only HTTP routes require key and keep specialist writes disabled", async () => {
  await withServer({
    enabled: true,
    dbPath: ":memory:",
    taskRoutesEnabled: true,
    specialistTaskWritesEnabled: false,
    ownerTaskRouteKey: OWNER_KEY,
  }, async (baseUrl) => {
    const missingKey = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask(),
    });
    assert.equal(missingKey.status, 403);
    assert.equal(missingKey.body.error, "owner_route_forbidden");

    const wrongKey = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask(),
      headers: { "x-agent-bus-owner-key": "wrong" },
    });
    assert.equal(wrongKey.status, 403);
    assert.equal(wrongKey.body.error, "owner_route_forbidden");

    const created = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask(),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.task.status, "queued");

    const tasks = await requestJson(baseUrl, `${ROUTE}/tasks`);
    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.tasks.length, 1);

    const cancelWrongKey = await requestJson(baseUrl, `${ROUTE}/tasks/http-owner-1/cancel`, {
      method: "POST",
      body: { summary: "wrong owner key should not cancel" },
      headers: { "x-agent-bus-owner-key": "wrong" },
    });
    assert.equal(cancelWrongKey.status, 403);
    assert.equal(cancelWrongKey.body.error, "owner_route_forbidden");

    const unsafeDelivery = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask({
        task_id: "unsafe-delivery",
        completion_contract: {
          result_file: "runs/unsafe/result.json",
          deliver_to_user: true,
          required_artifacts: [],
          result_schema: null,
        },
      }),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(unsafeDelivery.status, 400);
    assert.match(unsafeDelivery.body.error, /deliver_to_user/);

    const unsafeDb = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask({
        task_id: "unsafe-db",
        safety_boundary: {
          runtime_mutation: false,
          external_delivery: false,
          credential_access: false,
          db_mutation: true,
        },
      }),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(unsafeDb.status, 400);
    assert.match(unsafeDb.body.error, /db_mutation/);

    const specialistBodies = {
      claim: {
        agent_id: "agent-engineer",
        session_key: "agent:agent-engineer:main",
      },
      heartbeat: {
        agent_id: "agent-engineer",
        session_key: "agent:agent-engineer:main",
        summary: "working",
      },
      artifacts: {
        agent_id: "agent-engineer",
        session_key: "agent:agent-engineer:main",
        path: "runs/http-owner-1/result.json",
        kind: "result",
      },
      result: {
        agent_id: "agent-engineer",
        session_key: "agent:agent-engineer:main",
        result_file: "runs/http-owner-1/result.json",
      },
    };

    for (const [action, body] of Object.entries(specialistBodies)) {
      const response = await requestJson(baseUrl, `${ROUTE}/tasks/http-owner-1/${action}`, {
        method: "POST",
        body,
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.error, "specialist_task_writes_disabled");
    }

    const cancelled = await requestJson(baseUrl, `${ROUTE}/tasks/http-owner-1/cancel`, {
      method: "POST",
      body: { summary: "R1 smoke task has no specialist execution." },
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.status, "cancelled");

    const reconcileCreated = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask({ task_id: "http-reconcile-1" }),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(reconcileCreated.status, 201);
    assert.equal(reconcileCreated.body.task.status, "queued");

    const dispatched = await requestJson(baseUrl, `${ROUTE}/tasks/http-reconcile-1/dispatch`, {
      method: "POST",
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(dispatched.status, 200);
    assert.equal(dispatched.body.task.status, "wake_requested");

    const reconciled = await requestJson(baseUrl, `${ROUTE}/tasks/http-reconcile-1/reconcile`, {
      method: "POST",
      body: { summary: "Recovered from callback-only evidence." },
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.task.status, "recovered");
  });
});

test("specialist HTTP writes require enabled mode and matching active claim", async () => {
  await withServer({
    enabled: true,
    dbPath: ":memory:",
    taskRoutesEnabled: true,
    specialistTaskWritesEnabled: true,
    ownerTaskRouteKey: OWNER_KEY,
  }, async (baseUrl) => {
    const created = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask({ task_id: "http-r2-specialist-1" }),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.task.status, "queued");

    for (const headers of [{}, { "x-agent-bus-owner-key": "wrong" }]) {
      const response = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/dispatch`, {
        method: "POST",
        headers,
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.error, "owner_route_forbidden");
    }

    const dispatched = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/dispatch`, {
      method: "POST",
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(dispatched.status, 200);
    assert.equal(dispatched.body.task.status, "wake_requested");

    const specialist = {
      agent_id: "agent-engineer",
      session_key: "agent:agent-engineer:main",
    };

    for (const [action, body] of Object.entries({
      heartbeat: { ...specialist, summary: "working without claim" },
      artifacts: { ...specialist, path: "runs/http-r2-specialist-1/result.json", kind: "result" },
      result: { ...specialist, result_file: "runs/http-r2-specialist-1/result.json" },
    })) {
      const response = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/${action}`, {
        method: "POST",
        body,
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /no active claim/);
    }

    const claimed = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/claim`, {
      method: "POST",
      body: specialist,
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.task.status, "claimed");
    assert.equal(claimed.body.claim.agent_id, "agent-engineer");

    const duplicateClaim = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/claim`, {
      method: "POST",
      body: specialist,
    });
    assert.equal(duplicateClaim.status, 400);
    assert.match(duplicateClaim.body.error, /already has an active claim|invalid transition/);

    for (const action of ["ack", "cancel", "retry", "reconcile", "late", "block", "fail"]) {
      const response = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/${action}`, {
        method: "POST",
        body: { ...specialist, summary: `specialist must not ${action}` },
      });
      assert.equal(response.status, 403, action);
      assert.equal(response.body.error, "owner_route_forbidden", action);
    }

    const wrongAgentHeartbeat = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/heartbeat`, {
      method: "POST",
      body: {
        agent_id: "agent-designer",
        session_key: "agent:agent-engineer:main",
        summary: "wrong agent",
      },
    });
    assert.equal(wrongAgentHeartbeat.status, 400);
    assert.match(wrongAgentHeartbeat.body.error, /agent mismatch/);

    const wrongSessionArtifact = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/artifacts`, {
      method: "POST",
      body: {
        agent_id: "agent-engineer",
        session_key: "agent:agent-designer:main",
        path: "runs/http-r2-specialist-1/result.json",
        kind: "result",
      },
    });
    assert.equal(wrongSessionArtifact.status, 400);
    assert.match(wrongSessionArtifact.body.error, /session mismatch/);

    const heartbeat = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/heartbeat`, {
      method: "POST",
      body: { ...specialist, summary: "working" },
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.task.status, "running");

    const artifact = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/artifacts`, {
      method: "POST",
      body: {
        ...specialist,
        path: "runs/http-r2-specialist-1/result.json",
        kind: "result",
      },
    });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.body.task.status, "artifact_ready");

    const result = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/result`, {
      method: "POST",
      body: {
        ...specialist,
        result_file: "runs/http-r2-specialist-1/result.json",
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.task.status, "callback_pending");

    const completed = await requestJson(baseUrl, `${ROUTE}/tasks/http-r2-specialist-1/ack`, {
      method: "POST",
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.task.status, "completed");

    const unsafe = await requestJson(baseUrl, `${ROUTE}/tasks`, {
      method: "POST",
      body: safeTask({
        task_id: "http-r2-unsafe",
        safety_boundary: {
          runtime_mutation: true,
          external_delivery: false,
          credential_access: false,
          db_mutation: false,
        },
      }),
      headers: { "x-agent-bus-owner-key": OWNER_KEY },
    });
    assert.equal(unsafe.status, 400);
    assert.match(unsafe.body.error, /runtime_mutation/);
  });
});
