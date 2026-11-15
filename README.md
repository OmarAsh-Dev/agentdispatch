# AgentDispatch

AgentDispatch connects a local Kanzo board to Codex and OpenCode on Windows. Each project has an orchestrator that can plan a goal, assign tasks, and coordinate implementation and review.

## Requirements

- Windows x64, Node.js 24 or later, and PowerShell 7.
- A running Kanzo board on the same machine. The default is `http://localhost:4242/#all`.
- A working Codex login and an OpenCode account with access to your chosen model. Authenticate in the respective apps. Keep provider credentials in the apps' own configuration.

## Install

Download the source ZIP or clone the repository. In PowerShell 7, open the extracted source directory and run:

```powershell
pwsh -NoProfile -File .\scripts\install.ps1
```

The installer uses `%LOCALAPPDATA%\AgentDispatch` by default. Use `-Destination` to pick another new directory. It installs locked npm dependencies and checks for both worker executables. It leaves desktop settings and Windows login startup under your control. When the destination already exists, choose another folder. Stop any previous bridge before starting the new copy, since they share the same local ports.

Open the installed `bridge.config.json` and set `model.providerID` and `model.modelID` to a connected OpenCode provider and model. You can also pass them to the installer with `-ProviderId` and `-ModelId`.

```powershell
$bridge = Join-Path $env:LOCALAPPDATA 'AgentDispatch'
& "$bridge\agentdispatch.cmd" start
& "$bridge\agentdispatch.cmd" status
node "$bridge\scripts\client.mjs" opencode_health
```

The first start creates fresh credentials in the installation's `.state` directory. Review the worker health before running a board task. For startup errors, check `.state/bridge.log` and `.state/opencode.log`. Use `agentdispatch.cmd stop` to stop the services for this installation.

## Run a project

Use a disposable Kanzo project to try the bridge. Replace the slug and the absolute workspace with your own values. Registration can release existing eligible cards.

```powershell
& "$bridge\agentdispatch.cmd" start-project codex my-project 'C:\Projects\My Project'
& "$bridge\agentdispatch.cmd" goal my-project setup-01 .\goal.txt
```

Use `opencode` for the first argument to make OpenCode the initial orchestrator. The initial choice persists until you explicitly run `assign <project> <agent>`. Give each new goal a stable request ID so retries can be recognized.

You can also assign cards yourself with the exact tag `owner:codex` or `owner:opencode`. Moving the card to **Todo** or adding `ready` triggers the readiness checks. The bridge starts work when the workspace, task, and dependencies are ready. After implementation it posts a result and moves the card to **Review**. A passing agent review lets dependencies continue while the card remains in Review. Use `review:human` for acceptance that you want to handle yourself. Cards flagged as Human stay with the user.

## Connect the desktop apps

- **Codex Desktop** can show worker sessions in the chat list. Search by the full task ID, such as `my-project#12`. The title includes the worker role and attempt. For direct access to bridge tools in your Codex chats, register the local MCP launcher:

  ```powershell
  codex mcp add kanzo_bridge -- node "$bridge\scripts\mcp-launcher.mjs"
  ```

- **OpenCode Desktop** can connect through **Settings → Servers** at `http://127.0.0.1:4096`. Use the username `opencode` and the locally generated `openCodePassword` in `.state/runtime.json`. Open the same workspace under that server to find its sessions. To use the bridge's MCP tools from OpenCode, add a local MCP server whose command runs `node` and the installed absolute path to `scripts/mcp-launcher.mjs`. [OpenCode MCP setup](https://opencode.ai/docs/mcp-servers/)

## Local settings

The bridge listens on loopback. The installer defaults to scoped worker access and password authentication for OpenCode. Register projects and scope them according to who can edit their Kanzo cards. Keep `bridge.config.json`, `.state`, logs, tokens, account-specific model IDs, and worker transcripts out of commits and issue attachments.

## Development

```powershell
npm ci --ignore-scripts
npm test
npm run check
```

To run from the checkout, copy `bridge.config.example.json` to `bridge.config.json`, complete the model settings, and run `node .\scripts\bridge.mjs start`. The test suite includes a fresh installation into a temporary directory.

## License

[MIT](LICENSE)
