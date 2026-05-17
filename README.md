# Slipstream Rift

3D third-person multiplayer browser game. Peaceful NPCs voiced by ElevenLabs Conversational AI explore the arena, chat with players, and only retaliate when shot at. Players make friends with NPCs through conversation; NPC friends defend each other.

- **Client:** React + React Three Fiber + Three.js, deployed on Vercel
- **Server:** PartyKit (authoritative simulation, WebSockets) on Cloudflare Durable Objects
- **Shared:** TypeScript wire types between client and server
- **Voice:** ElevenLabs Conversational AI (one agent per NPC; you bring your own account)

## Run locally

```
pnpm install
cp apps/client/.env.example apps/client/.env.local   # leave VITE_PARTYKIT_HOST blank for local dev
cp apps/party/.env.example apps/party/.env           # fill in your secrets (see below)
pnpm dev
```

Open http://localhost:5173 in two browser windows, pick names, type the 4-digit access code you set in `apps/party/.env`, and you should see each other.

**Controls:** WASD move · Shift sprint · Space jump · Mouse aim (click canvas to lock) · Click fire · R reload · Tab scoreboard · M mute mic.

## ElevenLabs setup (required for talking NPCs)

The game expects one ElevenLabs Conversational AI agent per NPC in the roster. Without these, the game still runs, but NPCs are silent and the voice loop is non-functional.

**[docs/elevenlabs-setup.md](./docs/elevenlabs-setup.md)** has the full walkthrough:

1. Create an ElevenLabs account.
2. Author one agent per persona (six today: Mira, Guts, Vicky, Rook, Vex, Jacqueline). System prompts are in [`packages/shared/src/npc-roster.ts`](./packages/shared/src/npc-roster.ts) — copy each persona's `personality` field into its agent's system prompt.
3. Generate `ELEVENLABS_AGENT_TOOL_SECRET` (any random hex), put it in `apps/party/.env`, and paste the same value into every agent's webhook tools.
4. Register the webhook tools per [docs/agent-tools.md](./docs/agent-tools.md) — paste-ready JSON for `make_friend`, `follow_player`, `stop_following`, `flee_from`, `start_attacking`, `stop_attacking`, `set_pose`, `drink_coffee`, `patrol`, `sprint_patrol`, `lean_wall`.
5. Paste the agent IDs from the ElevenLabs dashboard into the `agentId: ''` fields in `packages/shared/src/npc-roster.ts`.
6. Optional: upload `docs/backstory.html` as a shared Knowledge Base attached to every agent via `pnpm scripts:upload-kb`.

## Deploy

You need free accounts on [Vercel](https://vercel.com), [PartyKit](https://www.partykit.io), and ElevenLabs.

### 1. Deploy the multiplayer server

```
pnpm --filter party deploy
```

First run prompts a login. The output prints a host like `slipstream-rift.<your-username>.partykit.dev`. Save that.

Set the production env on PartyKit:

```
npx partykit env add ACCESS_CODE <your-4-digit-code>
npx partykit env add ELEVENLABS_AGENT_TOOL_SECRET <the same value you put in apps/party/.env>
```

### 2. Deploy the client

Push the repo to GitHub and import it into Vercel. Vercel reads `vercel.json` at the repo root and builds the client.

In Vercel project settings → Environment Variables, add:

```
VITE_PARTYKIT_HOST = slipstream-rift.<your-username>.partykit.dev
```

Trigger a redeploy.

(CLI alternative: `vercel --prod` from the repo root.)

## Project structure

```
apps/
  client/           Vite + React + R3F. Vercel build target.
  party/            PartyKit server. Authoritative simulation at 30 Hz.
packages/
  shared/           TypeScript types for messages, state, constants, NPC roster.
                    Imported by both client and party as `@slipstream-npc/shared`.
docs/
  elevenlabs-setup.md   Step-by-step agent setup.
  agent-tools.md        Paste-ready webhook tool JSON.
  backstory.html        Shared knowledge base for all NPC agents.
  workbook.html         Bug + feature tracker.
scripts/                Build / nav / animation / admin scripts.
vercel.json             Pins build/output for Vercel.
```

See [CLAUDE.md](./CLAUDE.md) for the networking model, gotchas, and how to add a weapon, map, or feature.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run client + party in parallel |
| `pnpm build` | Build everything |
| `pnpm typecheck` | Strict TS check across the monorepo |
| `pnpm deploy:party` | Deploy multiplayer server to PartyKit |
| `pnpm extract:nav` | Re-extract nav graph from `Maps/<id>/walkarea.json` |
| `pnpm feedback:report` | Build a session feedback report from logs |
| `pnpm format` | Prettier write |

## Requirements

- Node 20+ (`.nvmrc` pins 20)
- pnpm 10+
- An ElevenLabs account (free tier works for testing)
