# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue for a vulnerability.

脆弱性は、公開の issue ではなく、このリポジトリの **Security → Report a vulnerability** から非公開で報告してください。

Include what you found, how to reproduce it, and the version (release tag or commit). Never include real API keys, tunnel IDs, webhook secrets or terminal output from your machine in a report.

## Scope

This bridge runs on your Mac and can, when you allow it, send an instruction to one agent in Orca, create an Orca workspace (git worktree) and start an agent in it, close an agent's terminal, or remove a workspace from Orca and git. Creating starts an agent with Orca's usual permissions on this Mac, and removing cannot be undone, so each of these is a separate ChatGPT plugin setting that is off by default and can only be turned on from the plugin settings page. Removal never passes `--force` or runs hooks, refuses a repository's main checkout and workspaces with open terminals, and leaves Orca's refusal of uncommitted changes in place. Issues of particular interest:

- Ways for content read from Orca (titles, terminal output) or from ChatGPT to make the bridge send an instruction, create, close or remove anything, or to turn any of these on, without the user's action on the ChatGPT plugin settings page.
- Ways to make removal reach a main checkout, a workspace other than the exact `worktreeId` given, or to bypass Orca's refusal of uncommitted changes.
- Ways for keys stored by `setup` (`~/.orca-dots-bridge/`, macOS Keychain) to leak into logs, command arguments, the renderer of the menu bar app, or other processes.
- Ways for the local listeners (`127.0.0.1` only) or the Secure MCP Tunnel path to be reached or abused by another user or a remote party.

Known limitations are documented rather than treated as vulnerabilities: the menu bar app is not signed by a developer, anyone who controls the ChatGPT account can change the plugin settings, and telling settings-page calls apart relies on observed (undocumented) ChatGPT behavior. See [docs/chatgpt-tunnel.md](docs/chatgpt-tunnel.md).

## Supported versions

Only the latest release receives fixes.
