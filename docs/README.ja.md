# Agent Bus

Agent Bus は、agent-to-main 通知、対象 session の wakeup、任意の durable task ledger を提供するローカル OpenClaw plugin です。

SQLite が source of truth で、wakeup は通知シグナルです。

## 機能

- `POST /plugins/agent-bus/events` による agent event 保存
- `before_prompt_build` で pending events を注入
- callback 処理のために対象 OpenClaw session を wake
- optional durable task ledger
- task mutation routes はデフォルトで無効

## Runtime Flow

1. Specialist agent が `agent_bus_emit` または `POST /plugins/agent-bus/events` で event を送信します。
2. Agent Bus が event を SQLite に保存します。
3. Agent Bus が対象 session を wake します。
4. 次の prompt build で pending events が注入されます。
5. Host agent または application が処理と ack を決定します。

## 設定

Configuration example は main README を参照してください。

## Safety Notes

- Event delivery と user-facing delivery は別の責務です。
- Task mutation routes はデフォルトで無効です。
- Owner/control-plane routes には `ownerTaskRouteKey` と `x-agent-bus-owner-key` header が必要です。
- Webhook と task routes はローカル control-plane surface です。公開する場合は authentication と transport protection を追加してください。

## Development

```bash
npm test
```

## License

MIT. See [LICENSE](../LICENSE).
