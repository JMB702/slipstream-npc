# Agent dashboard setup — paste-ready tool JSON

Every NPC's ElevenLabs agent needs the same set of webhook tools. The server route table in [`apps/party/src/server.ts`](../apps/party/src/server.ts) is the source of truth; this doc mirrors it.

The instructions below are dashboard-specific and need to be repeated for every agent in the roster (one agent per NPC).

## Prerequisites

- The agent has already been created and its system prompt pasted in. See [`docs/elevenlabs-setup.md`](./elevenlabs-setup.md) for the agent-authoring walkthrough.
- `ELEVENLABS_AGENT_TOOL_SECRET` is set in `apps/party/.env` (generate with `openssl rand -hex 24`). The same value goes into every tool definition below as `<SECRET>`.

## One-time override toggles (per agent)

Both of these are off by default in the dashboard. Without them, the game's per-session overrides do nothing.

- **Tab:** Security → Overrides
- Flip ON: **First message** (so the game can pick the greeting).
- Flip ON: **Voice** (so the game can pass a per-character `voiceId`).
- Leave **Stability**, **Similarity**, **Speed** off — the game doesn't override those.
- **Publish** at the top right.

## One-time dev: tunnel URL

ElevenLabs needs to reach your PartyKit server. For local dev, expose `localhost:1999` via a tunnel:

```sh
cloudflared tunnel --url http://localhost:1999
# wait for "https://<random-words>.trycloudflare.com"
```

Use that URL as `<TUNNEL_URL>` below. Each time you restart cloudflared the URL changes and you have to repaste every tool. For production, replace `<TUNNEL_URL>` with your deployed PartyKit host (e.g. `https://slipstream-rift.<your-username>.partykit.dev`).

## How to add each tool

1. ElevenLabs dashboard → your agent → **Tools** tab → **Add tool** → **Webhook**.
2. Click **`</> Edit as JSON`** at the bottom-left of the dialog.
3. Triple-click into the JSON box, **Cmd-A** to select all, **Delete**, then paste the JSON for the tool from below.
4. **Add tool**.
5. Repeat for each of the eleven tools.
6. After all eleven are added, click **Publish** at the top.

> **Before pasting:** replace every `<TUNNEL_URL>` and `<SECRET>` literal in the JSON with your actual values. The dynamic variables `{{npc_id}}`, `{{player_name}}`, `{{session_id}}` are supplied by `ConvAISession` at session start and need no edit.

## Tool catalog

| Tool | What it does in-game |
| --- | --- |
| `make_friend` | Increments friendship score with the player. Past `SOCIAL.friendThreshold` the player and NPC are mutual friends. |
| `follow_player` | NPC starts following the player at ~3m. Hostility / engage still wins. |
| `stop_following` | NPC stops following. |
| `flee_from` | NPC moves away from the player for `SOCIAL.hostilityMs`. |
| `start_attacking` | NPC begins actively shooting at the named target (player name). |
| `stop_attacking` | NPC stops attacking the named target; falls back to defensive behavior. |
| `set_pose` | NPC adopts an idle stance. Valid: `casual_idle` (weapon stowed, relaxed standing — use when player asks to holster), `lean_wall`, `sit`, `lay`, `dance` (optional `danceVariant` int), `clear` (back to default combat-ready). Any non-`clear` pose hides the rifle. |
| `drink_coffee` | NPC walks to the coffee maker (fps_shooter map only) and drinks after arrival. |
| `patrol` | NPC switches to patrol mode. |
| `sprint_patrol` | Patrol mode at sprint speed. |
| `lean_wall` | NPC leans against the nearest wall. |

---

### make_friend

```json
{
  "type": "webhook",
  "name": "make_friend",
  "description": "Mark the player you are currently talking to as a friend of this NPC. Call this sparingly — only after the conversation has reached a real moment of trust or shared experience (a personal story shared, a small ritual completed, expressed solidarity). Do NOT call it as a greeting, on the first exchange, or just because the player asked.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/make_friend",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### follow_player

```json
{
  "type": "webhook",
  "name": "follow_player",
  "description": "Begin physically following the player you are currently talking to. Call this when the player asks you to follow them AND you agree. After calling this, the player will literally see you start walking toward them in the game. Use it sparingly — usually only if you are friends with the player or you have just agreed to a request.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/follow_player",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### stop_following

```json
{
  "type": "webhook",
  "name": "stop_following",
  "description": "Stop following the player. Call this when you no longer want to follow them — they dismissed you, you got tired of it, or the situation changed.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/stop_following",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### flee_from

```json
{
  "type": "webhook",
  "name": "flee_from",
  "description": "Physically retreat away from the player you are talking to. Call this when your persona would genuinely want to back off — they insulted you, threatened you, or you're scared of them. The game will path you away from them for ~30 seconds. Do NOT call this just to leave a conversation politely.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/flee_from",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### start_attacking

```json
{
  "type": "webhook",
  "name": "start_attacking",
  "description": "Begin actively shooting at a named target. Call this only when the situation has escalated beyond polite withdrawal — your persona feels genuinely threatened by a specific named person, or has decided to defend someone. Pass the target's player name as `targetName`. The NPC's normal hostility / defense logic still runs alongside this directive.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/start_attacking",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Calling player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "targetName", "type": "string", "description": "Player to attack", "value_type": "llm_prompt" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### stop_attacking

```json
{
  "type": "webhook",
  "name": "stop_attacking",
  "description": "Stop actively shooting at a named target. Call this when the threat has passed, your persona has cooled off, or the target has surrendered. Pass the target name; if omitted, defaults to the player you're currently talking to.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/stop_attacking",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Calling player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "targetName", "type": "string", "description": "Player to stop attacking (optional)", "value_type": "llm_prompt" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### set_pose

```json
{
  "type": "webhook",
  "name": "set_pose",
  "description": "Adopt an idle stance. Pose values: 'casual_idle' (stows your weapon and stands relaxed — call this when the player asks you to put your gun away or holster it), 'lean_wall' (leans against the nearest wall, weapon stowed), 'sit' (sits down, weapon stowed), 'lay' (lies down, weapon stowed), 'dance' (dances; pass danceVariant 0-3 to pick a clip), 'clear' (returns to default combat-ready stance with weapon out). Call when your persona naturally would (Vex might dance, Rook would not). The pose persists until you set another or until combat preempts it.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/set_pose",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "pose", "type": "string", "description": "Pose name", "value_type": "llm_prompt" },
      { "id": "danceVariant", "type": "string", "description": "Dance variant index (optional)", "value_type": "llm_prompt" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### drink_coffee

```json
{
  "type": "webhook",
  "name": "drink_coffee",
  "description": "Walk over to the free coffee maker in the arena and have a cup. Call this when your persona naturally would — Guts grumbles about coffee prices and might do it sarcastically, Vex would do it for fun, Vicky might decline entirely. You decide. The game will path you to the maker. There is no cooldown right now. Only available on the fps_shooter map. Don't call reflexively; only when it fits the character. The tool starts the walk; do not claim you drank until the game sends a system message confirming you had a cup.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/drink_coffee",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### patrol

```json
{
  "type": "webhook",
  "name": "patrol",
  "description": "Switch to patrol mode — walk a random circuit of the map. Call when your persona is bored, restless, or wants visible activity to break tension. Walking pace.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/patrol",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### sprint_patrol

```json
{
  "type": "webhook",
  "name": "sprint_patrol",
  "description": "Same as patrol, but sprint speed. Call when your persona is amped up, training, or showing off.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/sprint_patrol",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

### lean_wall

```json
{
  "type": "webhook",
  "name": "lean_wall",
  "description": "Lean against the nearest wall. Idle stance for personas that would rather hang back than patrol. Call sparingly; pose persists until you set another stance or get engaged.",
  "api_schema": {
    "url": "<TUNNEL_URL>/parties/main/fps_shooter/tools/lean_wall",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [
      { "id": "npcId", "type": "string", "description": "NPC id", "value_type": "constant", "constant_value": "{{npc_id}}" },
      { "id": "playerName", "type": "string", "description": "Player name", "value_type": "constant", "constant_value": "{{player_name}}" },
      { "id": "sessionId", "type": "string", "description": "Voice session id", "value_type": "constant", "constant_value": "{{session_id}}" },
      { "id": "secret", "type": "string", "description": "Shared secret", "value_type": "constant", "constant_value": "<SECRET>" }
    ],
    "request_body_schema": null,
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null
  },
  "response_timeout_secs": 10,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "disable_interruptions": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate",
  "tool_error_handling_mode": "auto",
  "response_mocks": []
}
```

## Verifying

After adding all eleven and publishing, smoke-test the secret from your terminal:

```sh
curl -i -X POST "<TUNNEL_URL>/parties/main/fps_shooter/tools/make_friend?npcId=mira&playerName=YOUR_NAME&sessionId=test&secret=<SECRET>"
# Expect HTTP 200 with { "ok": true, ... } OR HTTP 403 "no consent on record" if you haven't joined the room.
# HTTP 401 means the secret didn't match — re-check the tool definition in the dashboard.
# HTTP 503 means ELEVENLABS_AGENT_TOOL_SECRET is unset on the server — fix apps/party/.env and restart partykit dev.
```

In-game, walk to an NPC, build rapport ("we should team up"), then say "follow me." The agent should call `follow_player` and you should see a 200 in the PartyKit dev console plus the NPC walking after you in the game.
