# BurnClaw — Configuración de hooks de Claude Code

BurnClaw levanta un servidor HTTP local en `http://127.0.0.1:9876` que recibe
eventos del lifecycle de Claude Code y los refleja en la UI (borde naranja +
console banner) y en notificaciones nativas de Windows.

Para que Claude Code envíe esos eventos hay que registrar unos hooks en tu
`~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json`).

## Por qué no hay script automático

Tu `settings.json` **ya tiene hooks configurados** (p. ej. el `SessionStart` de
superpowers). Un script que sobrescriba la clave `hooks` los rompería. Hay que
**fusionar** manualmente: añadir entradas a los arrays existentes de cada
evento, sin borrar lo que ya hay.

## El comando

Todos los hooks usan el mismo comando. Claude Code pasa el JSON del evento por
**stdin**; `curl -d @-` lo reenvía tal cual al servidor de BurnClaw, que ya sabe
interpretar el formato nativo (`hook_event_name`, `tool_input`, etc.):

```
curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H "Content-Type: application/json" -d @-
```

- `--max-time 1`: si BurnClaw está cerrado, el curl falla en 1s y **no bloquea**
  Claude Code.
- `curl.exe` viene de serie en Windows 10/11, no hay que instalar nada.

## Qué añadir a settings.json

Fusiona este bloque dentro de la clave `"hooks"` de tu `settings.json`. Si ya
tienes un array para un evento (p. ej. `SessionStart`), **añade** el objeto a
ese array en lugar de reemplazarlo.

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

### Ejemplo de fusión

Si tu `settings.json` ya tiene esto:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "...superpowers..." }] }
  ]
}
```

Queda así (el objeto de BurnClaw **se añade** al array, no lo reemplaza):

```json
"hooks": {
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "...superpowers..." }] },
    { "hooks": [{ "type": "command", "command": "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-", "timeout": 5 }] }
  ]
}
```

## Verificación

1. Arranca BurnClaw (`bun run tauri dev`). En consola debe aparecer:
   `Hook server listening on http://127.0.0.1:9876`
2. Comprueba el servidor a mano (PowerShell):
   ```powershell
   curl -X POST http://127.0.0.1:9876/event -H "Content-Type: application/json" -d "{\"event_type\":\"PreToolUse\",\"tool_name\":\"Edit\",\"tool_target\":\"src/main.rs\"}"
   ```
   El widget expandido debe mostrar borde naranja pulsante + banner
   `running Edit—src/main.rs`.
3. Reinicia Claude Code (para que recargue `settings.json`) y manda un prompt
   simple. El borde de BurnClaw debe ponerse naranja mientras Claude trabaja y
   mostrar `response complete` al terminar.

## Notas

- El servidor escucha **solo en `127.0.0.1`** (localhost), nunca expuesto a la
  red.
- Si BurnClaw no está abierto, los hooks fallan en silencio en 1s y Claude Code
  sigue normal.
- Para desactivar la integración, quita los objetos de BurnClaw de los arrays
  de `hooks` en `settings.json`.
