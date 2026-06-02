# Agent Bus

Agent Bus is a local OpenClaw plugin for agent-to-main notifications, targeted session wakeups, and an optional durable task ledger.

SQLite is the source of truth; wakeups are just a notification signal.

## Documentation

- English: this file
- Traditional Chinese: [docs/README.zh-TW.md](docs/README.zh-TW.md)
- Simplified Chinese: [docs/README.zh-CN.md](docs/README.zh-CN.md)
- Japanese: [docs/README.ja.md](docs/README.ja.md)
- Korean: [docs/README.ko.md](docs/README.ko.md)

## Features

- Stores agent events through `POST /plugins/agent-bus/events`
- Injects pending events during `before_prompt_build`
- Wakes a target OpenClaw session for callback handling
- Provides an optional durable task ledger for longer agent workflows
- Keeps task mutation routes disabled by default

## Runtime Flow

1. A specialist agent emits an event through `agent_bus_emit` or `POST /plugins/agent-bus/events`.
2. Agent Bus writes the event to SQLite.
3. Agent Bus wakes the target session.
4. Pending events are injected into the next prompt build for that session.
5. The host agent or application decides how to handle and acknowledge the event.

## Configuration

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

## HTTP Routes

- `GET /plugins/agent-bus/health`
- `GET /plugins/agent-bus/events`
- `POST /plugins/agent-bus/events`
- `POST /plugins/agent-bus/wake`
- `POST /plugins/agent-bus/events/:id/ack`

Optional task routes are available when `taskRoutesEnabled` is set to `true`.

## Safety Notes

- Event delivery and user-facing delivery are separate concerns.
- Task mutation routes are off by default.
- Owner/control-plane routes require `ownerTaskRouteKey` and the `x-agent-bus-owner-key` header.
- Treat webhook and task routes as local control-plane surfaces; do not expose them publicly without authentication and transport protection.

## Development

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
