# Publishing Jira Agent to the marketplaces

## Table of Contents
- [Overview](#overview)
- [Before you publish: fill the placeholders](#before-you-publish-fill-the-placeholders)
- [Add a listing icon](#add-a-listing-icon)
- [VS Code Marketplace](#vs-code-marketplace)
- [Open VSX](#open-vsx)
- [Release checklist](#release-checklist)

## Overview
The extension is published as a single VSIX. On install it copies its bundled skills
(`jira-poller`, `implement-task`) into the user's home skills folder (e.g. `%USERPROFILE%\.claude\skills` on Windows, or `~/.claude/skills` on Linux/macOS), so no separate installer is
needed. It supports Windows, Linux, and macOS.

Two independent registries:
- VS Code Marketplace (`marketplace.visualstudio.com`) - for VS Code and Cursor. Tool: `vsce`.
- Open VSX (`open-vsx.org`) - for Antigravity, VSCodium, Gitpod. Tool: `ovsx`.

Publish to both to cover VS Code and Antigravity. Both read the same `extension/package.json`.

## Before you publish: fill the placeholders
Edit `extension/package.json`:
- `publisher` - currently `your-publisher-id`. Set to your real publisher ID (see below; the ID
  must match the publisher you create on each registry).
- `repository.url` and `bugs.url` - currently `https://github.com/OWNER/...`. Point to your public
  repo, or remove both fields if you have no public repo (the tools will warn but still publish).

Edit `extension/LICENSE`:
- Replace `REPLACE_WITH_YOUR_NAME_OR_ORG` in the copyright line. The license is MIT; change it if you
  want a different one (also update `"license"` in `package.json`).

## Add a listing icon
The Marketplace listing needs a 128x128 PNG. A source `extension/media/icon.svg` is provided.
1. Convert it to PNG (any of):
   - ImageMagick: `magick extension/media/icon.svg -resize 128x128 extension/media/icon.png`
   - or an online SVG-to-PNG converter, output 128x128.
2. Add to `extension/package.json`:
   ```json
   "icon": "media/icon.png",
   ```
Without an icon the extension still publishes, but the listing shows a default gray tile.

## VS Code Marketplace
One-time publisher setup:
1. Sign in to Azure DevOps (`https://dev.azure.com`) with a Microsoft account.
2. Create an organization if you do not have one.
3. Create a Personal Access Token (PAT): User settings -> Personal Access Tokens -> New Token.
   - Organization: "All accessible organizations".
   - Scopes: "Marketplace" -> "Manage".
   - Copy the token (shown once).
4. Create a publisher at `https://marketplace.visualstudio.com/manage` (the publisher ID you pick
   here must equal `publisher` in `package.json`).

Publish:
```
cd extension
npx vsce login <your-publisher-id>     # paste the PAT when prompted
npm run publish:vsce                    # runs `vsce publish` (compiles + bundles skills first)
```
`vsce publish patch|minor|major` bumps the version and publishes in one step.

## Open VSX
One-time setup:
1. Sign in to `https://open-vsx.org` with GitHub.
2. Create an access token: user menu -> Settings -> Access Tokens -> Generate New Token.
3. Sign the Eclipse Publisher Agreement (prompted on first publish or under your profile).
4. Create your namespace (equals `publisher` in `package.json`):
   ```
   npx ovsx create-namespace <your-publisher-id> -p <open-vsx-token>
   ```

Publish (reuses the VSIX that `vsce package` produced):
```
cd extension
npm run package                                     # produces jira-agent-<version>.vsix
npx ovsx publish jira-agent-<version>.vsix -p <open-vsx-token>
```

## Release checklist
- [ ] Bump `version` in `extension/package.json`.
- [ ] `publisher`, `repository`, LICENSE holder filled in (no placeholders left).
- [ ] `media/icon.png` present and `icon` field set.
- [ ] `npm run package` succeeds and `vsce ls --tree` shows `skills/` inside the VSIX.
- [ ] Install the VSIX locally, reload, confirm skills land in `%USERPROFILE%\.claude\skills` and a
      workflow can Start.
- [ ] `vsce publish` (VS Code Marketplace).
- [ ] `ovsx publish` (Open VSX).
