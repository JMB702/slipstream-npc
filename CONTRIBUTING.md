# Contributing to Slipstream Rift

Slipstream Rift is set up as a collaborative AI-coding playground. Players paste a prompt from the lobby into their AI coding agent (Claude Code, Cursor, etc.) and the agent helps them propose changes via pull requests. This file explains the rules of the road.

## How changes get into the live game

1. **Anyone can fork and propose.** The repo is public. Fork it, branch, code, push, and open a PR back to `JMB702/slipstream-rift:main`.
2. **Pull requests are required.** Direct pushes to `main` are blocked by branch protection. Even the maintainer goes through PRs in normal cases.
3. **A code owner must approve.** GitHub branch protection requires approval from someone listed in [`.github/CODEOWNERS`](./.github/CODEOWNERS) before a PR can merge. Today that's `@JMB702`. Trusted devs can be added to that file over time.
4. **On merge, the change is NOT live yet.** Deployment is a separate, manual step the maintainer does after reviewing the merged commits:
   - Client: `vercel --prod` (Vercel CLI, maintainer's account).
   - Server (PartyKit): `cd apps/party && npx partykit deploy --var ACCESS_CODE=<code>` when `apps/party/` or `packages/shared/` changes.

   This is intentional. Code-owner review on a PR is one gate, but the maintainer also wants a final eyes-on-it pass before anything reaches the live game. There is no auto-deploy on merge.

## What this means in practice

- A random user (or their AI agent) can open as many PRs as they like. **They cannot merge their own PRs**, no matter what. The CODEOWNERS check enforces this.
- Trusted devs added to CODEOWNERS can review and approve other people's PRs. They still can't bypass review on their own PRs — branch protection requires approval from a different reviewer.
- The maintainer (`@JMB702`) can self-merge in emergencies (`enforce_admins` is off) but should still get a second pair of eyes when one is available.

## Becoming a trusted dev

The maintainer adds your GitHub `@handle` to `.github/CODEOWNERS` via a PR like any other change. Send a few well-scoped contributions first.

## What a good PR looks like

- One concern per PR. Don't bundle a refactor with a feature.
- `pnpm typecheck` passes locally before you push.
- The PR description explains *why*, not just *what*. Mention how to test the change.
- Don't reformat unrelated files. Don't bump random dependency versions.
- Wire-format changes (anything in `packages/shared/src/state.ts` or `messages.ts`) need a clear note — clients and server have to redeploy together.
- Read `CLAUDE.md` first. The "Gotchas" section catches the bugs that have already cost hours.

## What not to do

- Don't try to add your own AI-agent secret, PartyKit token, or Vercel hook to the repo. The deploy credentials live with the maintainer.
- Don't open issues asking for free real-time multiplayer hosting. The deployed server is small and ungated to PR-driven content only.
- Don't commit anything from `apps/party/.env`. It's gitignored for a reason.
