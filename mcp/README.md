# dhmz-session-mcp

MCP server that exposes the [DHMZ analog chart digitizer](https://dhmz.aldo.tech)
session API to any MCP host (Claude Desktop, Claude Code, etc.). It is a
thin wrapper around the HTTP endpoints documented in the briefing at
`/api/sessions/{id}/context`.

## Install

```bash
# from this directory
pipx install .
# or, for an isolated one-shot run:
uvx --from . dhmz-session-mcp
```

The entry point `dhmz-session-mcp` runs the server on stdio.

## Claude Desktop config

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "dhmz": {
      "command": "dhmz-session-mcp",
      "env": {
        "DHMZ_SESSION_ID": "PASTE_SESSION_ID_HERE"
      }
    }
  }
}
```

Restart Claude Desktop. The 27 tools (`get_state`, `get_image`,
`set_calibration`, `extract_trace`, `post_chat`, `poll_chat`, …) will
appear in the tools picker.

`DHMZ_SESSION_ID` is optional: if set, every tool defaults to that
session and you don't have to pass `session_id` on each call. To switch
sessions without restarting, just pass `session_id="..."` explicitly to
any tool — env-var is a default, not a lock.

## Claude Code config

```bash
claude mcp add dhmz dhmz-session-mcp \
    --env DHMZ_SESSION_ID=PASTE_SESSION_ID_HERE
```

Or edit `~/.claude/mcp.json` directly with the same JSON shape as above.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DHMZ_BASE_URL` | `https://dhmz.aldo.tech/api` | Override for local dev. |
| `DHMZ_SESSION_ID` | _unset_ | Default session for tools when the call omits `session_id`. |
| `DHMZ_HTTP_TIMEOUT` | `120` | Seconds; raise if extract-trace times out. |
| `DHMZ_LOG_LEVEL` | `INFO` | Standard `logging` levels. |

## Tool surface

State / read: `get_state`, `get_briefing`, `get_image`, `get_csv`.

Calibration & geometry: `set_rotation`, `set_calibration`,
`set_polylines`, `swap_image`.

Drawing layer: `add_annotation`, `replace_annotations`,
`delete_annotation`, `clear_annotations`, `add_roi`, `delete_roi`,
`clear_rois`.

Sidebar / UI: `set_panel`, `delete_panel`, `set_scratch_html`,
`clear_scratch_html`, `add_note`.

Pipeline + data: `extract_trace`, `add_data_point`, `update_data_point`,
`delete_data_point`, `clear_data_points`.

Chat (primary I/O): `post_chat`, `poll_chat`.

Each tool's docstring spells out the request shape — they show up
inside the MCP host as the tool's description.
