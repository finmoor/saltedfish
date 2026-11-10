# SaltedFish

> You chill. Agents browse.

[中文](README.md)

SaltedFish lets AI agents use the Chrome you already use, over MCP: your signed-in accounts, your installed extensions, and multiple Chrome profiles, with nothing to set up again. Current version: **0.3.27**.

It has two parts: a service that runs on your computer (or on a machine in your LAN), and an extension installed in each Chrome profile. Agents connect to the service's MCP endpoint, the extension connects to the service, and the service handles authorization, queuing, the operation log and recovery.

```
Claude Code / Codex / OpenCode / …  ──MCP──▶  SaltedFish service  ◀──WebSocket──  Chrome extension (one per Chrome profile)
                                              dashboard · grants · operation log
```

> Most of the detailed documentation under `docs/` is currently in Chinese. Issues and pull requests in English are welcome.

## Why SaltedFish

- **Your own browser.** No separate clean browser to sign in to again. Each Chrome profile is paired and authorized on its own, so profiles never get mixed up even if they share a name. When a profile is offline, calls fail clearly instead of falling back to another account.
- **Stays out of your way.** Agents work in background tabs and never switch the tab you are looking at. Each agent session keeps its tabs in its own tab group, and writes are only allowed inside that group.
- **No replays.** Every write is logged before it is dispatched. An operation whose result is unknown after a disconnect, crash or timeout blocks further writes until someone checks the page and explicitly recovers. Submits and payments are never retried automatically.
- **Fewer round trips.** Action results include what changed on the page; `chrome_batch` runs a sequence of fills, clicks and waits inside the browser in one call.
- **Many agents.** `saltedfish connect` writes the configuration for Codex CLI, Claude Code, OpenCode, pi, agy, Claude Desktop, CodeBuddy and WorkBuddy, and backs up the original first.

## Quick start

Requires Node.js 24+ and Chrome.

```sh
npm install -g saltedfish
saltedfish install
```

`install` starts the service, connects the agents it detects on this computer, and prints the extension folder. Then:

1. In each Chrome profile you want to use, open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select the printed extension folder.
2. Run `saltedfish dashboard` to open the dashboard, create a pairing code for this Chrome under "Browsers", and paste it into the extension's settings.
3. Start a new session in your agent and ask it to use SaltedFish.

Everyday commands:

```sh
saltedfish status          # service status
saltedfish dashboard       # open the dashboard (one-time login code, valid for 5 minutes)
saltedfish connect         # connect local agents; --clients to choose, --trust-browser to skip per-call approval
saltedfish upgrade         # download and switch to the latest release, rolling back on failure
saltedfish rollback        # switch back to the previous compatible version
saltedfish logs --lines 100
```

**Where the service listens.** On Windows and macOS it listens on localhost only. On Linux it listens on the LAN IP, port 18445 by default, so Chrome extensions on other computers can connect; this mode uses plain HTTP and is only meant for a trusted LAN. Use a certificate for anything else. In every mode the agent endpoint `/mcp` only accepts connections from the machine the service runs on.

## Handing it to an agent

Example prompt:

> Use SaltedFish. List the browser profiles, find "Work", and only use that profile. Open a new tab for the task and check the result on the page when you are done.

A typical agent flow:

1. `chrome_profiles` to pick the profile, `chrome_tabs` to see its tabs.
2. Writes are limited to the session's tab group: tabs opened with `chrome_new_tab` can be used directly, existing tabs need `chrome_claim_tab` first. Reads are not limited.
3. `chrome_inspect` and `chrome_find` read the page and locate elements, `chrome_action` clicks and types. If `pageChange` in the result already shows the outcome, there is no need to read the page again.
4. Hand deterministic multi-step work to `chrome_batch`:

```json
{
  "profileId": "the profile ID you picked",
  "tabId": 123,
  "steps": [
    { "operation": "page.action", "args": { "action": "fill", "selector": "#name", "text": "Example" } },
    { "operation": "page.action", "args": { "action": "click", "selector": "#preview" } },
    { "operation": "page.wait", "args": { "selector": ".preview-ready" } }
  ],
  "timeoutMs": 60000
}
```

A batch stops at the first failure. A completed click only means the input events were sent; confirm business results on the page or in network responses.

There are 64 tools, 46 listed by default; rarely used ones such as tasks and saved workflows appear after enabling "advanced tools" for that agent in the dashboard. Schemas live in [src/tools.ts](src/tools.ts).

## Security and data

- The service checks Host, Origin and credentials. The extension and the service authenticate each other with a challenge–response handshake; the pairing secret never goes over the wire.
- Grants restrict this service's API; they are not an operating-system sandbox. An authorized agent can click, type, read pages and run page scripts in the granted profiles as the signed-in user, and with "trust once" it no longer asks for each call. Grant only the profiles that are needed and revoke when done.
- Non-admin agents cannot read or write SaltedFish's data directory or network shares, cannot open `file:` URLs, and cannot operate the dashboard. Access to other local files is decided by the agent's own permission settings.
- No telemetry. Page content and screenshots returned by tools go to the agent that called them, and from there to whatever model service that agent uses.
- The operation log stores tool names, targets, times and states, not scripts, page text or file contents.

See [PRIVACY.md](PRIVACY.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Known limitations

- Verified on Windows and Linux; macOS distribution is not verified.
- No automation guarantees for Chrome internal pages, other extensions' pages, native OS windows, CAPTCHAs or OS permission dialogs.
- Web pages can observe the DOM and input events; SaltedFish does not promise that sites cannot tell automation apart from a person.
- While an agent is connected, Chrome shows a "being debugged" bar on every tab. Starting Chrome with `--silent-debugger-extension-api` removes it; see the install guide for the trade-offs.
- Chrome's debugger API can conflict with DevTools and other extensions, and some CDP domains are not available to extensions.
- Actions that were already sent cannot be undone. Editing the page by hand while a task runs can affect the result; pause the extension before taking over.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/testing.md](docs/testing.md).

```sh
npm ci
npm run build
npm run typecheck
npm test
```

## License

[MIT](LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
