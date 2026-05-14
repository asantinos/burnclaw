# BurnClaw — Claude Code hooks setup

BurnClaw runs a local HTTP server at `http://127.0.0.1:9876` that receives
Claude Code lifecycle events and reflects them in the UI (orange border +
console banner) and in native Windows notifications.

For Claude Code to send those events, a few hooks have to be registered in your
`~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json`).

> BurnClaw's setup wizard — and the **Activity hooks** section of its Settings
> window — can do this for you. They merge into `settings.json` safely and keep
> a `.bak` backup. This document is for doing it by hand, or just to understand
> exactly what gets added.

## Why there's no overwrite script

Your `settings.json` probably **already has hooks configured** (e.g. a
`SessionStart` hook from another tool). A script that overwrites the `hooks`
key would break them. The hooks have to be **merged**: add entries to the
existing array of each event, without removing what's already there.

## The command

Every hook uses the same command. Claude Code passes the event JSON over
**stdin**; `curl -d @-` forwards it as-is to BurnClaw's server, which knows how
to interpret the native format (`hook_event_name`, `tool_input`, etc.):

```
curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H "Content-Type: application/json" -d @-
```

- `--max-time 1`: if BurnClaw isn't running, the curl fails within 1s and
  **doesn't block** Claude Code.
- `curl.exe` ships with Windows 10/11 — nothing to install.

## What to add to settings.json

Merge this block into the `"hooks"` key of your `settings.json`. If you already
have an array for an event (e.g. `SessionStart`), **append** the object to that
array instead of replacing it.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Merge example

If your `settings.json` already has this:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "...another tool..." }] }
  ]
}
```

it should end up like this — BurnClaw's object is **appended** to the array, it
doesn't replace it:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "...another tool..." }] },
    { "hooks": [{ "type": "command", "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-", "timeout": 5 }] }
  ]
}
```

## Verifying

1. Make sure BurnClaw is running (you'll see it in the tray).
2. Test the server by hand (PowerShell):
   ```powershell
   curl -X POST http://127.0.0.1:9876/event -H "Content-Type: application/json" -d "{\"event_type\":\"PreToolUse\",\"tool_name\":\"Edit\",\"tool_target\":\"src/main.rs\"}"
   ```
   The expanded widget should show a pulsing orange border and the banner
   `running Edit—src/main.rs`.
3. Restart Claude Code (so it reloads `settings.json`) and send a simple
   prompt. BurnClaw's border should turn orange while Claude works and show
   `response complete` when it finishes.

## Notes

- The server listens on **`127.0.0.1` only** (localhost), never exposed to the
  network.
- If BurnClaw isn't running, the hooks fail silently within 1s and Claude Code
  carries on as normal.
- To disable the integration, remove BurnClaw's objects from the `hooks` arrays
  in `settings.json` — or use BurnClaw's Settings window (**Activity hooks →
  Remove hooks**), which removes only its own entries and leaves the rest
  untouched.
