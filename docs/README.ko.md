# Agent Bus

Agent Bus는 agent-to-main 알림, 대상 session wakeup, 선택적 durable task ledger를 제공하는 로컬 OpenClaw plugin입니다.

SQLite가 source of truth이며, wakeup은 알림 신호입니다.

## 기능

- `POST /plugins/agent-bus/events`로 agent event 저장
- `before_prompt_build`에서 pending events 주입
- callback 처리를 위해 대상 OpenClaw session wake
- 선택적 durable task ledger
- task mutation routes는 기본적으로 비활성화

## Runtime Flow

1. Specialist agent가 `agent_bus_emit` 또는 `POST /plugins/agent-bus/events`로 event를 전송합니다.
2. Agent Bus가 event를 SQLite에 저장합니다.
3. Agent Bus가 대상 session을 깨웁니다.
4. 다음 prompt build에서 pending events가 주입됩니다.
5. Host agent 또는 application이 처리와 ack 방식을 결정합니다.

## 설정

Configuration example은 main README를 참고하세요.

## Safety Notes

- Event delivery와 user-facing delivery는 별도의 책임입니다.
- Task mutation routes는 기본적으로 꺼져 있습니다.
- Owner/control-plane routes에는 `ownerTaskRouteKey`와 `x-agent-bus-owner-key` header가 필요합니다.
- Webhook과 task routes는 로컬 control-plane surface입니다. 공개하려면 authentication과 transport protection을 추가하세요.

## Development

```bash
npm test
```

## License

MIT. See [LICENSE](../LICENSE).
