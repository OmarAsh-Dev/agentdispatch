# AgentDispatch

AgentDispatch connects a local Kanzo board to Codex and OpenCode on Windows. Each project has an orchestrator that can plan a goal, assign tasks, and coordinate implementation and review.

## Requirements

- Windows x64, Node.js 24 or later, and PowerShell 7.
- A running Kanzo board on the same machine. The default is `http://localhost:4242/#all`. See [Kanzo's installation guide](https://github.com/emanuele-em/kanzo#install).
- A working Codex login and an OpenCode account with access to your chosen model. Authenticate in the respective apps. Keep provider credentials in the apps' own configuration.

## Install the Windows desktop app

Download the Windows x64 setup executable from [GitHub Releases](https://github.com/OmarAsh-Dev/agentdispatch/releases). Install Node.js 24 x64 and PowerShell 7, then run the setup executable and open **AgentDispatch Desktop** from Start. PowerShell runs in the background during initial bridge installation.

1. Under **Setup → Bridge installation**, click **Install bridge**. If you already have an AgentDispatch or Kanzo Bridge installation, enter its folder and click **Use folder** to keep its settings, registrations, and goals.
2. For a fresh bridge, enter the provider and model IDs you use in OpenCode, then click **Save model** and **Start bridge**. Keep Kanzo running on the same PC.
3. If the project list is empty, expand **Register a project**. Enter the Kanzo project slug, its actual folder, and its orchestrator.
4. Select the project, write your goal, and click **Submit goal**. Watch for the planned cards in Kanzo. Use **Refresh** to update recent goal states.

If a long-running bridge reports that its connection limit is reached, use **Restart bridge** when Kanzo work is idle. The bridge keeps its registrations and goals on disk.

The desktop setup is unsigned. The [Tauri Windows build instructions](https://v2.tauri.app/distribute/windows-installer/) describe how to build it from source with `npm exec --package=@tauri-apps/cli@2 -- tauri build --bundles nsis`.

## Install the bridge from a source checkout

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

You can also assign cards yourself with the exact tag `owner:codex` or `owner:opencode`. Moving the card to **Todo** or adding `ready` triggers the readiness checks. The bridge starts work when the workspace, task, and dependencies are ready. After implementation it posts a result, moves the card to **Review**, and starts an independent Codex review. An implementer's request for human input goes to the reviewer as context.

A passing technical review lets dependencies continue while the card remains in Review, unless human approval is required. Add `review:human` to get the same technical review and keep dependencies waiting until you mark the card Done. Cards flagged as Human stay with the user.

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

## Attribution

AgentDispatch uses Kanzo for its task board and task API. Thanks to `emanuele-em` and the Kanzo contributors. [Upstream Kanzo repository](https://github.com/emanuele-em/kanzo)

## License

[MIT](LICENSE)
