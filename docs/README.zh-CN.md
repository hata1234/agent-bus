# Agent Bus

Agent Bus 是一个本机 OpenClaw plugin，用于 agent-to-main 通知、指定 session wakeup，以及可选的 durable task ledger。

SQLite 是事实来源；wakeup 只是通知信号。

## 功能

- 通过 `POST /plugins/agent-bus/events` 保存 agent event
- 在 `before_prompt_build` 注入 pending events
- 唤醒指定 OpenClaw session 以处理 callback
- 提供可选 durable task ledger
- 默认关闭 task mutation routes

## Runtime Flow

1. Specialist agent 通过 `agent_bus_emit` 或 `POST /plugins/agent-bus/events` 送出 event。
2. Agent Bus 将 event 写入 SQLite。
3. Agent Bus 唤醒指定 session。
4. 下一次 prompt build 时，pending events 会被注入该 session。
5. Host agent 或 application 决定如何处理并 ack event。

## 配置

请参考主 README 的 configuration 示例。

## 安全注意事项

- Event delivery 和用户可见 delivery 是不同层级。
- Task mutation routes 默认关闭。
- Owner/control-plane routes 需要 `ownerTaskRouteKey` 与 `x-agent-bus-owner-key` header。
- Webhook 和 task routes 属于本机控制面；公开暴露前应加入 authentication 与 transport protection。

## 开发

```bash
npm test
```

## 许可证

MIT. See [LICENSE](../LICENSE).
