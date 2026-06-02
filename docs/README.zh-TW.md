# Agent Bus

Agent Bus 是一個本機 OpenClaw plugin，用於 agent-to-main 通知、指定 session wakeup，以及可選的 durable task ledger。

SQLite 是事實來源；wakeup 只是通知訊號。

## 功能

- 透過 `POST /plugins/agent-bus/events` 儲存 agent event
- 在 `before_prompt_build` 注入 pending events
- 喚醒指定 OpenClaw session 以處理 callback
- 提供可選的 durable task ledger
- 預設關閉 task mutation routes

## Runtime Flow

1. Specialist agent 透過 `agent_bus_emit` 或 `POST /plugins/agent-bus/events` 送出 event。
2. Agent Bus 將 event 寫入 SQLite。
3. Agent Bus 喚醒指定 session。
4. 下一次 prompt build 時，pending events 會被注入該 session。
5. Host agent 或 application 決定如何處理並 ack event。

## 設定

請參考主 README 的 configuration 範例。

## 安全注意事項

- Event delivery 和使用者可見 delivery 是不同層級。
- Task mutation routes 預設關閉。
- Owner/control-plane routes 需要 `ownerTaskRouteKey` 與 `x-agent-bus-owner-key` header。
- Webhook 和 task routes 屬於本機控制面；公開暴露前應加入 authentication 與 transport protection。

## 開發

```bash
npm test
```

## 授權

MIT. See [LICENSE](../LICENSE).
