# Agent Bus

Local OpenClaw plugin for agent-to-main notifications, targeted session wakeups, and an optional durable task control plane.

Languages: [繁體中文](#繁體中文) | [English](#english) | [简体中文](#简体中文) | [日本語](#日本語) | [한국어](#한국어)

## 繁體中文

### 用途

Agent Bus 是一個本機 OpenClaw plugin，用 SQLite 保存 agent 事件，並喚醒指定 session。它適合用在 specialist agent 完成工作後，回報給 main agent，而不是直接對使用者發送訊息。

核心原則：SQLite 是事實來源，wake 只是提醒鈴。

### 功能

- `POST /plugins/agent-bus/events` 寫入 agent event
- `before_prompt_build` 注入該 session 的 pending events
- 支援 targeted wake，讓 main session 重新醒來處理 callback
- 可選的 durable task ledger，記錄 task lifecycle
- 預設關閉 task mutation routes，避免未審核的控制面寫入

### Runtime Flow

1. Specialist agent 呼叫 `agent_bus_emit` tool，或送出 `POST /plugins/agent-bus/events`。
2. Plugin 將 event 寫入 SQLite。
3. Plugin 對目標 session 發出 wake。
4. 下一次 prompt build 時，pending events 會被注入 context。
5. Main agent 彙整結果，再自行決定是否對使用者回覆。

### Task Ledger

常見狀態：

```text
queued -> dispatch_requested -> wake_requested -> claimed -> running
running -> artifact_ready -> callback_pending -> completed
blocked -> retry_requested -> queued
failed -> replacement task with parent_task_id
```

Terminal states: `completed`, `failed`, `cancelled`, `recovered`

### 安全邊界

- Specialist agent 不應直接對外發送訊息。
- `completion_contract.deliver_to_user` 應維持 `false`。
- `runtime_mutation`、`external_delivery`、`credential_access`、`db_mutation` 應維持 `false`，除非有明確控制面授權。
- `taskRoutesEnabled` 預設 `false`。
- Owner/control-plane routes 需要 `ownerTaskRouteKey` 與 `x-agent-bus-owner-key`。

### 設定範例

```json
{
  "plugins": {
    "load": {
      "paths": ["./plugins/agent-bus"]
    },
    "allow": ["agent-bus"],
    "entries": {
      "agent-bus": {
        "enabled": true,
        "config": {
          "enabled": true,
          "dbPath": "~/.openclaw/agent-bus/events.sqlite",
          "routePath": "/plugins/agent-bus",
          "defaultTargetSessionKey": "agent:main:telegram:direct:USER_ID",
          "defaultTargetAgentId": "main",
          "injectLimit": 5,
          "taskRoutesEnabled": false,
          "specialistTaskWritesEnabled": false
        }
      }
    }
  }
}
```

### HTTP Routes

- `GET /plugins/agent-bus/health`
- `GET /plugins/agent-bus/events?status=pending&target_session_key=...`
- `POST /plugins/agent-bus/events`
- `POST /plugins/agent-bus/wake`
- `POST /plugins/agent-bus/events/:id/ack`
- `GET /plugins/agent-bus/tasks`
- `POST /plugins/agent-bus/tasks`
- `GET /plugins/agent-bus/tasks/:task_id`
- `GET /plugins/agent-bus/tasks/:task_id/events`
- `POST /plugins/agent-bus/tasks/:task_id/dispatch`
- `POST /plugins/agent-bus/tasks/:task_id/claim`
- `POST /plugins/agent-bus/tasks/:task_id/heartbeat`
- `POST /plugins/agent-bus/tasks/:task_id/artifacts`
- `POST /plugins/agent-bus/tasks/:task_id/result`
- `POST /plugins/agent-bus/tasks/:task_id/ack`
- `POST /plugins/agent-bus/tasks/:task_id/late`
- `POST /plugins/agent-bus/tasks/:task_id/block`
- `POST /plugins/agent-bus/tasks/:task_id/fail`
- `POST /plugins/agent-bus/tasks/:task_id/cancel`
- `POST /plugins/agent-bus/tasks/:task_id/retry`
- `POST /plugins/agent-bus/tasks/:task_id/reconcile`

Task routes are disabled unless `taskRoutesEnabled: true`.

## English

### Purpose

Agent Bus is a local OpenClaw plugin that stores agent events in SQLite and wakes a target session. It is designed for specialist agents to report back to the main agent instead of directly messaging the user.

The core rule: SQLite is the source of truth; wakeups are only a bell.

### Features

- Writes agent events through `POST /plugins/agent-bus/events`
- Injects pending events during `before_prompt_build`
- Supports targeted wakeups for callback handling
- Provides an optional durable task ledger
- Keeps task mutation routes disabled by default

### Runtime Flow

1. A specialist agent calls the `agent_bus_emit` tool or sends `POST /plugins/agent-bus/events`.
2. The plugin writes the event to SQLite.
3. The plugin wakes the target session.
4. Pending events are injected into the next prompt for that session.
5. The main agent reviews the result and decides whether to reply to the user.

### Safety

- Specialist agents should not deliver directly to users.
- Keep `completion_contract.deliver_to_user` as `false`.
- Keep runtime mutation, external delivery, credential access, and database mutation disabled unless an owner control plane explicitly allows them.
- `taskRoutesEnabled` defaults to `false`.
- Owner routes require `ownerTaskRouteKey` and the `x-agent-bus-owner-key` header.

## 简体中文

### 用途

Agent Bus 是一个本机 OpenClaw plugin，用 SQLite 保存 agent 事件，并唤醒指定 session。它适合让 specialist agent 向 main agent 回报结果，而不是直接对用户发消息。

核心原则：SQLite 是事实来源，wake 只是提醒铃。

### 功能

- 通过 `POST /plugins/agent-bus/events` 写入事件
- 在 `before_prompt_build` 注入 pending events
- 支持 targeted wake
- 可选 durable task ledger
- task mutation routes 默认关闭

### 安全边界

- Specialist agent 不应直接对外发送消息。
- `completion_contract.deliver_to_user` 应保持 `false`。
- 未经控制面授权，不应允许 runtime mutation、external delivery、credential access、db mutation。
- Owner routes 需要 `ownerTaskRouteKey` 和 `x-agent-bus-owner-key`。

## 日本語

### 目的

Agent Bus は、agent から main agent への通知を SQLite に保存し、対象 session を wake するローカル OpenClaw plugin です。Specialist agent がユーザーへ直接送信せず、main agent に結果を戻すために使います。

基本原則: SQLite が source of truth で、wake は通知ベルにすぎません。

### 機能

- `POST /plugins/agent-bus/events` による event 保存
- `before_prompt_build` で pending events を注入
- targeted wakeup
- optional durable task ledger
- task mutation routes はデフォルトで無効

### 安全境界

- Specialist agent はユーザーへ直接配信しないこと。
- `completion_contract.deliver_to_user` は `false` のままにすること。
- runtime mutation、external delivery、credential access、db mutation は、owner control plane の明示的な許可なしに有効化しないこと。
- Owner routes には `ownerTaskRouteKey` と `x-agent-bus-owner-key` header が必要です。

## 한국어

### 목적

Agent Bus는 agent 이벤트를 SQLite에 저장하고 대상 session을 깨우는 로컬 OpenClaw plugin입니다. Specialist agent가 사용자에게 직접 메시지를 보내지 않고 main agent에게 결과를 보고하도록 설계되었습니다.

핵심 원칙: SQLite가 source of truth이고, wake는 알림 벨일 뿐입니다.

### 기능

- `POST /plugins/agent-bus/events`로 event 저장
- `before_prompt_build`에서 pending events 주입
- targeted wakeup 지원
- 선택적 durable task ledger
- task mutation routes는 기본적으로 비활성화

### 안전 경계

- Specialist agent는 사용자에게 직접 전달하지 않아야 합니다.
- `completion_contract.deliver_to_user`는 `false`로 유지합니다.
- owner control plane의 명시적 허가 없이 runtime mutation, external delivery, credential access, db mutation을 허용하지 않습니다.
- Owner routes는 `ownerTaskRouteKey`와 `x-agent-bus-owner-key` header가 필요합니다.
