// Self-contained prompt copied to the clipboard from the lobby button.
// Designed to drop into a fresh AI coding agent (Claude Code, Cursor, etc.)
// and set up a collaborative loop: the agent clones, then takes the user's
// change requests, makes a feature branch, opens a PR back to the upstream
// repo. The maintainer reviews/merges, and separately decides when (and
// whether) to deploy. There is no auto-deploy on merge — that's the second
// of two gates protecting the live game.
//
// Editing notes:
// - Plain ASCII; some agents stumble on smart quotes when re-quoting prompts.
// - Canonical GitHub URL so the agent can verify it.
// - Don't bake in the live access code or any ElevenLabs credentials —
//   players type the access code themselves and cloners create their own
//   ElevenLabs account.
export const CLONE_PROMPT = `You are going to help me propose changes to Slipstream Rift, a live multiplayer browser game with peaceful voice-chat NPCs. The repo is public; the live game is gated behind code-owner review on every PR plus a manual deploy step that only the maintainer runs. We work as a pair: I describe what I want, you make the change as a pull request, the maintainer decides whether it ships.

Repo: https://github.com/JMB702/slipstream-rift
Live game: TBD

ONE-TIME SETUP

1. Make sure 'gh' CLI and 'pnpm' are installed and you are signed into GitHub.
2. Fork and clone:
   - gh repo fork JMB702/slipstream-rift --clone --remote
   - cd slipstream-rift
   - pnpm install
3. Sanity check:
   - pnpm typecheck
   - pnpm build
4. Local dev environment files (NEVER commit these, they are gitignored):
   - cp apps/client/.env.example apps/client/.env.local
   - cp apps/party/.env.example apps/party/.env
   - In apps/party/.env, fill in:
     * ACCESS_CODE — any 4-digit number you choose for your local dev gate.
     * ELEVENLABS_AGENT_TOOL_SECRET — generate with 'openssl rand -hex 24'.
     * ELEVENLABS_API_KEY — only needed if you intend to run the upload-knowledge-base script.
5. ElevenLabs Conversational AI agents are REQUIRED for the voice loop. Each NPC in packages/shared/src/npc-roster.ts has an empty agentId: '' that you must fill in. The full walkthrough is in docs/elevenlabs-setup.md — it covers:
   - Creating one ElevenLabs agent per NPC persona (six today).
   - Pasting each persona's system prompt from npc-roster.ts into the agent's prompt field.
   - Registering the webhook tools per docs/agent-tools.md.
   - Wiring ELEVENLABS_AGENT_TOOL_SECRET into every tool definition.
   Without this setup the game still runs, but NPCs are silent and the voice loop is non-functional. Skip this step if you only need to work on non-voice changes (movement, hit-detection, UI, etc.).
6. Run the dev servers:
   - pnpm dev   (client on :5173, party on :1999)
7. Read the root CLAUDE.md. It documents the architecture (server-authoritative sim on PartyKit, R3F client on Vercel, pnpm monorepo with apps/client, apps/party, packages/shared) and the gotchas list. Do not skip it.

WORKING LOOP

When I ask for a change:
1. Confirm you understand the request in one or two sentences before writing code.
2. Sync your fork: git fetch upstream && git checkout main && git merge upstream/main && git push origin main
3. Create a feature branch: git checkout -b <descriptive-kebab-name>
4. Make the change. Keep edits scoped to what I asked for; don't reformat unrelated files. Follow the conventions in CLAUDE.md.
5. Verify locally: pnpm typecheck (always) and pnpm dev for behavioral changes.
6. Commit with a message that explains WHY, not just what.
7. Push the branch: git push origin <branch>
8. Open a pull request against JMB702/slipstream-rift main:
   - gh pr create --repo JMB702/slipstream-rift --title "<short title>" --body "<what + why + how to test>"
9. Give me the PR URL. I review and merge.

DEPLOYMENT

Deployment is intentionally NOT automatic. Merging to main does not push your change to the live game on its own. The maintainer reviews the merged commits and runs the deploy manually when satisfied — Vercel for the client, PartyKit for the server. This is the gate that keeps random PRs from shipping straight to production.

You don't run any deploy commands yourself. Don't add 'vercel --prod' or 'partykit deploy' steps to your workflow. If a PR description claims "this auto-deploys on merge", that's wrong — point it out.

GROUND RULES

- Public repo. Don't commit secrets. The .env files in apps/party/ and apps/client/.env.local are gitignored — never copy ACCESS_CODE, ELEVENLABS_AGENT_TOOL_SECRET, ELEVENLABS_API_KEY, or real agent IDs into source.
- Don't push to JMB702/slipstream-rift main directly even if you have access. Always go through a PR.
- If a request is ambiguous, ask one clarifying question before writing code.
- If a change spans the wire format (packages/shared/src/state.ts or messages.ts), call that out in the PR description so I know clients and server need to redeploy together.
- If a change adds a new ElevenLabs webhook tool, update docs/agent-tools.md with paste-ready JSON for the new tool. The dashboard side of the contract has to stay in sync with the server route.
- For Mixamo / animation work, follow the asset pipeline section in CLAUDE.md exactly.

Acknowledge by listing the steps you'll take for the first change I ask for.`;
