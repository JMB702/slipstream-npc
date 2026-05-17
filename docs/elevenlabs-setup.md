# ElevenLabs setup — required for talking NPCs

Slipstream Rift's voice loop runs on ElevenLabs Conversational AI. Each NPC in [`packages/shared/src/npc-roster.ts`](../packages/shared/src/npc-roster.ts) is a separate ElevenLabs agent with its own persona, voice, and webhook tools. This doc is the complete walkthrough from "I just cloned the repo" to "an NPC just said hello when I walked up."

The public repo ships with empty `agentId: ''` placeholders on every NPC. You will replace these with the agent IDs the ElevenLabs dashboard hands you below. **No one operator's IDs ever live in this source.**

## 0. What you need

- An [ElevenLabs](https://elevenlabs.io) account. The free tier is enough to validate the setup; serving real players will need a paid plan eventually.
- A local clone with `pnpm install` already run and the rest of the README's local-dev steps done.
- Your `apps/party/.env` with at minimum these two values filled in (see `apps/party/.env.example`):
  - `ACCESS_CODE` — any 4-digit code; you'll type this in the lobby.
  - `ELEVENLABS_AGENT_TOOL_SECRET` — generate one with `openssl rand -hex 24` and paste it back into `apps/party/.env`. Keep the same value handy; you'll paste it into every agent in the dashboard.

## 1. Author one agent per NPC

The roster has six NPCs: Mira, Guts, Vicky, Rook, Vex, Jacqueline. (Add Halsey when [workbook F1](./workbook.html#f1) ships — same pattern.) For each one:

1. In the ElevenLabs dashboard, **Agents → New agent**.
2. **Name** — match the NPC's `name` so the dashboard stays readable.
3. **System prompt** — copy the entire `personality` field for that NPC from `packages/shared/src/npc-roster.ts` and paste it as the system prompt. Don't paraphrase; the personas are tuned and length matters for variety.
4. **Voice** — pick a distinct voice per NPC. The roster's `VOICE_BY_CHARACTER` map lists the voices we currently use per character body (Eve → Sarah, Maria → Alice, etc.); you can use those or pick your own. If `voiceId` is set on an NPC in the roster, the client passes it as a per-session override at session start.
5. **First message** — leave blank. The game picks one of the persona's `greetings` per session based on recency.
6. **Settings → Security → Overrides** — flip ON these two toggles (default off):
   - **First message** — required so the game can override per session.
   - **Voice** — required so the game can pass `voiceId` per session.
   - Leave Stability / Similarity / Speed off.
7. **Publish** (top right). This is the step that's easy to forget. Without publishing, overrides don't take effect.
8. From the agent's page header, copy the agent id (looks like `agent_xxxx…`).
9. Open `packages/shared/src/npc-roster.ts` and paste it as the `agentId` for that NPC.

Repeat for all six. Each persona's system prompt is multi-paragraph and the same one Jeff used in his testing; you're welcome to evolve them, but start with the committed text so you have a known baseline.

## 2. Register the webhook tools

The voice agent calls webhooks at `<host>/parties/main/<roomId>/tools/<tool_name>` to make the NPC do things in-game (start following, drink coffee, become friends, etc.). Every agent needs every tool. The tool definitions, including the full paste-ready JSON, are in [`docs/agent-tools.md`](./agent-tools.md). Open that doc and follow it for each agent — it covers:

- Generating a `cloudflared tunnel` URL so ElevenLabs can reach your local PartyKit dev server.
- The exact tool JSON for each webhook (paste-as-JSON in the dashboard).
- Replacing `<TUNNEL_URL>` and `<SECRET>` placeholders before pasting.

The `<SECRET>` value MUST match `ELEVENLABS_AGENT_TOOL_SECRET` in `apps/party/.env`. The server constant-time compares this field on every tool call; any mismatch fails with HTTP 401.

## 3. (Optional) Attach a shared knowledge base

[`docs/backstory.html`](./backstory.html) is the world bible the NPCs reference for shared canon: what the arena is, who runs it, what the outside world looks like. Attach it to every agent so they answer "where are we?" consistently.

```sh
pnpm scripts:upload-kb
```

This reads `ELEVENLABS_API_KEY` from `apps/party/.env`, uploads the backstory, and re-attaches it to every agent in the roster. The script is in [`scripts/upload-knowledge-base.mjs`](../scripts/upload-knowledge-base.mjs).

If you skip this, the agents still work — they just don't share a baseline world model.

## 4. Verify end-to-end

1. `pnpm dev` — both client and PartyKit running locally.
2. Open `http://localhost:5173`, agree to the consent gate, enter your `ACCESS_CODE`, drop in.
3. Walk near any NPC. In the browser DevTools console you should see:
   - `[voice] session connected for Mira` (or whichever NPC is closest).
4. Have a short conversation. The NPC should respond in their voice using their persona.
5. Ask the NPC to follow you. The agent calls the `follow_player` webhook; in the PartyKit dev terminal you should see a `200` response, and the NPC begins walking toward you in-game.
6. Build rapport ("we should team up", "you can trust me") and explicitly cue the friendship. The agent calls `make_friend`; the nameplate pip should go green. Quit and rejoin — the NPC should greet you as a friend.

If voice doesn't start: open DevTools console. The most common failure mode now prints:

> `[voice] Mira has no agentId. Set it in packages/shared/src/npc-roster.ts after creating the ElevenLabs agent for this NPC.`

Fix the agent id and reload.

If voice connects but tools never fire: check the dashboard tool definitions. The server returns 401 if the `secret` query param doesn't match, 404 if the URL doesn't end in the right `/tools/<name>` path, and 503 if `ELEVENLABS_AGENT_TOOL_SECRET` is unset on the server side.

## 5. Production deploy

When you `pnpm deploy:party`, set the production env vars on PartyKit:

```sh
npx partykit env add ACCESS_CODE <your-production-4-digit-code>
npx partykit env add ELEVENLABS_AGENT_TOOL_SECRET <same-value-you-pasted-into-the-agents>
```

The PartyKit Workers runtime does NOT read `process.env`; it reads from `room.env`, which is what these `partykit env add` calls populate. The local `.env` file is for `partykit dev` only.

Update each agent's tool URLs to point at the production PartyKit host (e.g. `https://slipstream-rift.<your-username>.partykit.dev/parties/main/fps_shooter/tools/make_friend`) instead of the cloudflared tunnel URL.

## What's not in scope here

- **Audio recording / consent law.** The consent gate (`apps/client/src/ui/ConsentGate.tsx`) covers the legal side. Florida is a two-party-consent state; the gate is mandatory before any session starts. Don't bypass it.
- **Voice cloning.** All voices are ElevenLabs library voices; we don't clone real people.
- **`get_memory` / `remember(key, value)`** — deferred tools not yet implemented. When they ship, they follow the same webhook auth pattern.
