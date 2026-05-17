# Slipstream Rift — project guide for Claude

3D third-person multiplayer arena. NPCs are peaceful by default, voiced by ElevenLabs Conversational AI, and retaliate only when shot at. Players make friends with NPCs through conversation; NPC friends defend each other. Forked from the combat-only Slipstream prototype.

- **Repo**: https://github.com/JMB702/slipstream-rift
- **Live game**: TBD
- **PartyKit prod**: set by the maintainer at deploy time; cloners should expect `slipstream-rift.<your-username>.partykit.dev` after `pnpm deploy:party`.
- **Internal package name**: `@slipstream-npc/shared` — left unchanged to avoid a destructive workspace rename. Treat it as the historical id of this monorepo; the user-facing project is Slipstream Rift.

## Stack

- **pnpm monorepo**: `apps/client`, `apps/party`, `packages/shared`
- **TypeScript strict** end-to-end, ESM, `.js` extensions in TS source (Node ESM resolver — Vite doesn't care, the server build does)
- **Client**: Vite + React 18 + React Three Fiber + drei + Three.js + zustand + partysocket
- **Server**: PartyKit, single `Party.Server` class per room
- **Shared**: wire types + constants + the deterministic `applyMovement` function used by both sides

Tick rate 30 Hz, snapshot rate 20 Hz, input rate 30 Hz.

## Architecture

- **Server is the source of truth.** It runs `applyMovement` (from `@slipstream/shared`) on every input frame. Hit detection, health, ammo, kills/deaths all live server-side.
- **Client predicts locally** using the same `applyMovement`. On every snapshot the client drops acked inputs from its buffer, replays the rest from the server-confirmed state, and extrapolates a partial frame from the live input for the time since the last input was sent. No rubber-banding when math matches.
- **Position is the capsule's center**, not the feet. Floor clamp is `PLAYER.height / 2`. Visual capsule renders at the group origin (no extra Y lift). Eye height for raycasts is `position.y + height * 0.3`.
- **Remote players are time-interpolated** ~100ms behind the latest snapshot. Snapshot buffer is in `useGame.snapshots`.
- **Wire format**: `ClientMessage` / `ServerMessage` discriminated unions in `packages/shared/src/messages.ts`. Anything that crosses the wire MUST be defined there.

### Hit detection chain (READ THIS BEFORE TOUCHING tryFire)

The fire path looks simple but stacks three load-bearing pieces. They were each added because the user reported them missing in turn — don't simplify by removing one.

1. **Camera-anchored cast** (third-person parallax fix). Each `InputFrame` carries `aimOrigin` (camera world position) and `aim` (camera-resolved hit point in 3D). Server's `tryFire` casts from `aimOrigin` toward `aim`, **not** from the player's eye along yaw/pitch. Reason: the camera sits behind+above the player, so a low ledge in front of the player blocks the EYE's forward ray but not the camera ray. Reticle says clear, eye-cast says blocked, miss. Camera-anchored cast resolves to what the player sees. Bots and frames before the first snapshot pass `null` aim and fall back to eye-from-yaw/pitch.

2. **Vertical capsule hit volume** (matches the visible body). `rayCapsuleVertical` in `packages/shared/src/sim.ts` — cylinder body between `position.y ± (height/2 - radius)` with hemispherical caps of `PLAYER.radius + 0.1` at each end. The old single-sphere-at-center test reached only `[0.18, 1.62]` vertically; head shots from elevation never registered.

3. **Lag-compensated rewind** (so what you saw is what gets hit). Each `ServerPlayer` keeps a 500ms ring of `(serverTime, position)` samples, pushed once per tick after physics settles. `tryFire` rewinds each potential victim to `now - NET.interpolationDelayMs` (linear interp between bracketing samples) before running the capsule test. Without this, a target moving at walk speed (6 m/s) is offset ~0.6m from where the shooter sees them. History clears on respawn so a delayed shot can't tag someone back at their pre-death spot.

The visible tracer in the `shot` event is decoupled from the cast: server splits authoritative cast (`castOrigin = aimOrigin`) from visual event (`origin = eyeOrigin, direction = eye→impact`). Bullet appears to leave the rifle even though the hit logic ran from the camera. Don't merge these — that re-introduces the parallax bug.

## Where things live

```
packages/shared/src/
  constants.ts   — PLAYER (incl. stepHeight), MAP defaults, WEAPON, NET,
                   HOUSE_WALLS + SCATTERED_OBSTACLES (used by 'arena' map)
  maps.ts        — MapDef registry, MAPS, DEFAULT_MAP_ID, isMapId,
                   setActiveMap / getActiveMap singleton
  maps/fps_shooter.collision.ts — auto-generated AABBs for the GLTF map
  sim.ts         — applyMovement (reads getActiveMap obstacles + size),
                   rayAABB, raycastObstacles
  state.ts       — PlayerState, GameSnapshot, GameEvent
  messages.ts    — wire types + encode/decode
apps/party/src/
  server.ts      — Party.Server, tick + snapshot loops, room lifecycle.
                   onStart calls setActiveMap(this.room.id) so room id
                   IS the map id; onConnect rejects mismatched ?mapId=.
  simulation.ts  — applyInput, tryFire, integrateIdle, maybeRespawn
  state.ts       — ServerPlayer, randomSpawn (uses getActiveMap spawnArea)
  bots/
    waypoints.ts — getNavGraph(): per-map cache, built from MapDef.waypoints
    path.ts      — planPath, randomPatrolGoal (defensive on empty graphs)
apps/client/src/
  net/client.ts          — PartySocket wrapper. Room is the mapId; passes
                           ?mapId= alongside name/killTarget/etc.
  store.ts               — Zustand: snapshots, events, conn state, activeMapId
  game/Scene.tsx         — R3F Canvas root
  game/Map.tsx           — branches on activeMapId: 'arena' renders
                           HOUSE_WALLS + SCATTERED_OBSTACLES procedurally;
                           'fps_shooter' renders <MapGltf>
  game/MapGltf.tsx       — drei useGLTF wrapper. Per-map URL + scale (must
                           match SCALE in scripts/extract-map-collision.mjs)
  game/LocalPlayer.tsx   — input loop, prediction, sprint-demote-on-fire
  game/RemotePlayer.tsx  — snapshot interpolation
  game/Camera.tsx        — over-the-shoulder, spring-arm collision
  game/Character.tsx     — Mixamo character, anim state machine, gun
  game/local-state.ts    — singletons for input + predicted state
  game/input.ts          — pointer-lock + WASD + mouse handlers
  game/Tracers.tsx       — bullet tracers from shot events
  game/sfx.ts            — Web Audio one-shot SFX (gunshot, dry-fire, hit-marker, reload)
  ui/Lobby.tsx           — Map dropdown (replaces the old Room input)
  ui/Minimap.tsx         — reads activeMapId + MapDef.obstacles
public/models/Soldier.glb — Mixamo character + animations (Idle/Walk/Run/Fire/Reload/StrafeL/StrafeR)
public/audio/             — gunshot, dry-fire, hit-marker, reload (mp3)
public/maps/fps_shooter/  — GLTF served to the client (scene.gltf + bin + textures)
scripts/extract-map-collision.mjs — voxelizes Maps/<src>/scene.gltf into
                                    fps_shooter.collision.ts. Run via
                                    `pnpm extract:collision`. (Largely retired:
                                    fps_shooter.collision.ts is now authored
                                    in Blender's Colliders collection.)
scripts/extract-map-nav.mjs       — turns walkarea.json (baked from Blender
                                    `Walk area` mesh) into a typed waypoint
                                    graph. Run via `pnpm extract:nav`.
scripts/feedback-report.mjs       — joins events.jsonl + DO transcripts →
                                    markdown. LLM-backed extraction via Haiku
                                    when ANTHROPIC_API_KEY is in env.
scripts/session-last.mjs          — calls `/admin/sessions` on every room,
                                    pretty-prints the most-recent session(s).
                                    Replaces the SQLite-decode dance.
scripts/set-npc-state.mjs         — persona-delta CRUD via /admin/npc-state.
scripts/upload-knowledge-base.mjs — uploads docs/world-bible.md to ElevenLabs
                                    Knowledge Base and re-attaches to every
                                    per-NPC agent.
Maps/fps_shooter_game_arena_map_v3/walkarea.json — Blender-baked walk area
                                    mesh (input to extract:nav). World-coord
                                    pre-transformed in the Blender Python step
                                    to match the collision file's origin.
docs/
  agent-tools.md     — paste-ready ElevenLabs dashboard JSON for the 6 tools
                       (follow_player / stop_following / make_friend /
                       flee_from / start_attacking / stop_attacking)
  elevenlabs-setup.md — one-time agent setup notes (voice override toggle)
  world-bible.md      — shared knowledge base attached to all NPC agents
                        (arena setting, mechanics, what NPCs can/can't do)
  workbook.html       — durable bug+feature tracker with status pills (B#/F#)
logs/                 — gitignored. `pnpm dev | tee logs/events-YYYY-MM-DD.jsonl`
                        to capture [EVENT] lines for `pnpm feedback:report`.
```

## Maps

Two maps ship today; the lobby dropdown picks one and the server keys its
PartyKit room by the map id, so different maps live in different rooms.

| id | display | collision | size |
| --- | --- | --- | --- |
| `arena` | Original Arena | hand-authored `HOUSE_WALLS` + `SCATTERED_OBSTACLES` in `constants.ts` | 60×60 |
| `fps_shooter` | FPS Shooter Arena | hand-authored in Blender (`Colliders` collection) + nav graph from Blender `Walk area` mesh (inset 0.4m for capsule radius) — see `extract:nav` | 30×30 |

Default map id: `fps_shooter` (set in `packages/shared/src/maps.ts` as `DEFAULT_MAP_ID`).

**Adding a map:**
1. Drop the GLTF and textures under `apps/client/public/maps/<id>/`.
2. If you want collision auto-extracted, add the source GLTF under `Maps/<dir>/`, point `scripts/extract-map-collision.mjs` at it, and run `pnpm extract:collision` to emit `packages/shared/src/maps/<id>.collision.ts`.
3. Add the new `MapId` literal + `MAPS[id]` entry in `packages/shared/src/maps.ts` (size, spawnArea, spawnHeight, obstacles, waypoints, edges, gltfOffset).
4. Register the URL + scale in `apps/client/src/game/MapGltf.tsx`. SCALE there must match `SCALE` in `scripts/extract-map-collision.mjs` so collision and visuals line up.
5. Branch the renderer in `apps/client/src/game/Map.tsx` (procedural arena vs `<MapGltf>`).

**Stair-step:** `PLAYER.stepHeight` (constants.ts) lets `applyMovement` auto-step grounded movement over obstacles up to that tall. Anything taller still needs a jump.

## Build / dev

```
pnpm install
pnpm dev               # client on :5173, party on :1999, parallel
pnpm typecheck         # strict TS across the workspace
pnpm build
pnpm deploy:party      # PartyKit deploy (requires Adobe-free PartyKit login)

# Map asset pipeline
pnpm extract:collision # voxelize Maps/<src>/scene.gltf → fps_shooter.collision.ts
pnpm extract:nav       # Blender-authored Walk area → fps_shooter.nav.ts (waypoint graph)

# NPC + feedback workflow (see "Feedback pipeline" + "Workflow tooling" below)
pnpm feedback:report   # join events.jsonl + DO transcripts → markdown report (LLM extract optional)
pnpm session:last [N]  # last N voice sessions across all rooms, markdown — primary debug tool
pnpm npc:state <npcId> "<summary>" [--evidence=…] [--source=…]   # add a persona delta
pnpm npc:state --list <npcId>      # inspect persona deltas
pnpm npc:state --clear <npcId>     # wipe persona deltas
pnpm sync:kb           # upload docs/world-bible.md → ElevenLabs knowledge base, attach to all agents
```

`vercel.json` at the repo root pins client builds for Vercel. `VITE_PARTYKIT_HOST` is set as a Vercel project env var (production scope) pointing at the deployed PartyKit host (e.g. `slipstream-rift.<your-username>.partykit.dev`). `apps/party/.env` (gitignored; see `apps/party/.env.example` for the schema) holds `ACCESS_CODE=<4 digits>` and the ElevenLabs secrets for local dev — the `partykit dev` server reads it on startup.

### Deployment (manual; not auto-on-merge)

Branch protection on `main` requires a code-owner approval before any PR can merge — see `CONTRIBUTING.md` and `.github/CODEOWNERS`. **Merging does NOT trigger a deploy.** The maintainer ships when satisfied with the merged commits:

```
# Client (Vercel; uses the linked project from `vercel link`)
vercel --prod

# Server, only when apps/party/ or packages/shared/ changed
cd apps/party && npx partykit deploy --var ACCESS_CODE=<code>
```

The two-gate model is intentional: code-owner review gates what merges, the maintainer's manual deploy gates what ships. Don't reconnect Vercel ↔ GitHub auto-deploy without flipping `CONTRIBUTING.md` and `apps/client/src/ui/clonePrompt.ts` to match — the lobby's Copy AI Agent Prompt button hands agents a workflow that explicitly says "do not run deploy commands; the maintainer ships manually."

## LAN multiplayer testing

`pnpm dev` binds both servers to `0.0.0.0` so a second computer on the same local network can join without deploying. Three pieces make this work:

- `apps/client/vite.config.ts` sets `server.host: true` → Vite prints both `Local:` and `Network:` URLs on startup.
- `apps/party/package.json` runs `partykit dev --port 1999`. PartyKit already binds 0.0.0.0 by default; the explicit `--port` keeps the port stable so the client's `localhost:1999` fallback works without env vars.
- `apps/client/src/net/client.ts` reads an optional `?host=` URL query and uses it before falling back to `VITE_PARTYKIT_HOST`, then `localhost:1999`. Lets the second computer override the host without its own `.env`.

**Procedure (host machine):**
1. `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1` (Ethernet) → call it `HOST_IP`.
2. `pnpm dev`.
3. macOS firewall is the #1 blocker. System Settings → Network → Firewall: either turn it off for the test, or open it and explicitly allow incoming connections for `node` and `workerd`. The first-launch popup is unreliable for processes spawned by `pnpm` — better to set this up in advance.
4. Player 1 (host) opens `http://localhost:5173/`.
5. Player 2 (other computer, same LAN) opens `http://<HOST_IP>:5173/?host=<HOST_IP>:1999`.

Wi-Fi vs Ethernet doesn't matter — what matters is that both machines sit on the same subnet (almost always true if they share one home router; a `192.168.x.x` IP on each is the tell). A Windows player should run `ipconfig` in PowerShell and confirm its `IPv4 Address` shares the first three octets with `HOST_IP`.

**Sanity checks from another shell on the host:**
- `curl -I http://<HOST_IP>:5173/` → HTTP 200 means Vite is reachable on the LAN interface.
- `curl -I http://<HOST_IP>:1999/parties/main/test` → any HTTP response (even 404/500) proves PartyKit is reachable; connection-refused or timeout means firewall.
- From the second machine's browser, hitting `http://<HOST_IP>:5173/` should load the page. If that fails but localhost on the host works, it's network/firewall, not the code.

**If LAN doesn't work** (firewall stays in the way, hotel/office Wi-Fi with client isolation, separate VLANs): `cloudflared tunnel --url http://localhost:1999`, then pass the printed `*.trycloudflare.com` host via `?host=`. The URL-query override handles arbitrary hosts, no code change needed. Last resort: `pnpm deploy:party` and point `?host=` at the prod PartyKit host while keeping the client local.

## Gotchas (hard-won)

These are the things that have eaten hours. Read before changing related code.

1. **Mixamo bone world scale is ~0.001.** Bones come out of the FBX → Blender → glTF pipeline with a tiny cumulative scale. Don't `bone.add(child)` — the child renders at 0.001× size, invisible. Track the bone via `bone.getWorldPosition()` + `wrapper.worldToLocal()` per frame and skip rotation extraction (its `decompose()` inherits the bad scale).
2. **Mixamo animations carry root motion** in the `Hips.position` track unless downloaded with "In Place" enabled. Server is authoritative for position, so root motion fights every snapshot. `stripRootMotion()` in `Character.tsx` filters those tracks at runtime — don't remove it.
3. **Three.js auto-disables actions after `fadeOut` completes.** Specifically, `_updateWeight` sets `enabled = false` when the weight interpolant hits 0. A subsequent `fadeIn().play()` does NOT re-enable — the mixer forces effective weight to 0 and the bind pose (T-pose) blends through. **Always set `action.enabled = true` on every transition.** `applyClipMode()` does this.
4. **`integrateIdle` must gate on `TICK_MS * 1.5`.** Server's gravity-for-idle-players runs every tick, but if it fires for active players too it overwrites velocity to zero — client snapshots see velocity oscillating between sprint-speed and zero, animation state machine flickers Walk↔Idle on every snapshot.
5. **Don't add an `isRunning()` defensive check to the animation state machine.** It misfires for paused actions (Jump's frozen pose), continuously calls `fadeIn()`, weight permanently near 0 → T-pose blend. State machine should only act on actual state transitions.
6. **drei's `useGLTF` returns a shared scene.** Clone via `SkeletonUtils.clone(gltf.scene)` for each instance. Pass the **cloned object** to `useAnimations`, not a wrapper ref — the latter relies on tree traversal and binds intermittently.
7. **Sprint+fire is silently demoted to walk+fire** in two places: server `onMessage('input')` and client `LocalPlayer` input frame builder. Both must be kept in sync or prediction rubber-bands.
8. **Camera in tight spaces uses spring-arm with asymmetric damping.** Retract fast (lerp 0.6), return slow (lerp 0.1), 0.15m hysteresis. Camera radius (0.3m) inflates obstacle AABBs at ray-cast time so corners pull the camera in before clipping.
9. **Don't bump GLB version timestamps unless the file changed.** drei caches by URL — adding `?v=${Date.now()}` forces re-downloads of multi-MB files for every player on every reload.
10. **HMR debt**. After many hot reloads (especially across `Character.tsx`), WebGL contexts get exhausted and Vite's optimizer cache desyncs. If errors look weird and reloads don't help, restart the dev server. Symptoms: Character component throws on mount, `Context Lost` log spam.

11. **PartyKit env on Cloudflare Workers**: read via `this.room.env.X`, NOT `process.env.X`. The Workers runtime doesn't populate `process.env`; `room.env` is the only path that works in both `partykit dev` and prod. The access-code gate failed silently in prod for an entire deploy because of this.

12. **ADS is a presentation flag, not a gameplay flag.** `state.aiming` (RMB or LT) drives camera framing (back-distance / shoulder / FOV lerp) and look-sensitivity scaling only. Don't gate fire rate, damage, or accuracy on it — keep gameplay invariant under aim.

13. **The local character body hides when the camera is within `LOCAL_HIDE_DIST` (1.9m).** Spring-arm collision and ADS framing both pull the camera that close. Without the hide, the player's own head occludes the aim cone. The gun stays visible because it's a sibling of the cloned mesh inside the wrapper group, not a child.

14. **Shot/hit-marker subscribers must gate on event timestamp, not array length.** The store caps `events` at 200; once full, length stays pinned and length-based comparison silently no-ops every subscriber forever (~25s into a session). HUD hit-marker and Character muzzle-flash both use a `lastAtRef` of the highest-seen `ev.at` instead.

15. **`pendingFire` is a `Map<id, aim|null>`, not a Set.** The aim travels with the fire press from input dispatch into the next tick's `tryFire`, so the server fires from the camera state at the moment of the click — not the most recent yaw/pitch (which can drift between press and tick).

16. **Sister `.claude/worktrees/` are a reversion vector.** Concurrent agent sessions in sister worktrees can check files out into the main directory and clobber uncommitted work. If the same edits keep being undone, check `git worktree list` and remove stale worktrees: `git worktree remove --force .claude/worktrees/<name>` + `git branch -D claude/<name>`. Commit aggressively to lock work in.

## Conventions

- **Wire types only** in `@slipstream/shared`. Server `ServerPlayer` extends `PlayerState` privately; the public wire shape is `PlayerState`.
- **Constants only** in `@slipstream/shared/constants` — even when used only on one side. Keeps tuning in one file.
- **`stripServerOnly`** in `server.ts` strips fields like `grounded`, `pendingInputSeq`, `lastIntegratedAt` before broadcasting. Client derives these if it needs them.
- **Server tunables** that affect prediction must be in shared constants (gravity, jump speed, etc.). Server-only state (timers, room id) stays in `apps/party`.
- **No NaN math.** Clamp input axes (`forward`, `right`) to [-1, 1] before integrating. Clamp `dtMs` to ≤100ms before division.
- **No comments narrating WHAT.** Names do that. Comments only for non-obvious WHY (a gotcha, an invariant, a workaround).

## Asset pipeline (Mixamo character)

To swap or add animations:

1. Mixamo → download character FBX with skin (T-pose) into `Characters/`. Animations → FBX without skin, **In Place ✓**, into `Animations/Slim Shooter Pack/`.
2. Edit `/tmp/merge_mixamo.py`: set `CHARACTER_PATH`, add to `ANIMATIONS` list (clip name → FBX path).
3. Run merge:
   ```
   /Applications/Blender.app/Contents/MacOS/Blender --background --python /tmp/merge_mixamo.py
   ```
4. Compress (Blender output is usually 100MB+ from embedded textures):
   ```
   cp apps/client/public/models/Soldier.glb /tmp/Soldier_uncompressed.glb
   npx --yes @gltf-transform/cli resize /tmp/Soldier_uncompressed.glb /tmp/_step1.glb --width 1024 --height 1024
   npx --yes @gltf-transform/cli webp /tmp/_step1.glb apps/client/public/models/Soldier.glb
   ```
   Don't use `gltf-transform optimize` — it adds meshopt compression which Three.js's default `GLTFLoader` can't decode without `MeshoptDecoder` registration.
5. If clip names changed, update `CLIP_NAMES` at the top of `Character.tsx`.

`Animations/`, `Characters/`, and `*.fbx` are gitignored — keep sources local, only the merged Soldier.glb ships.

## Audio

`apps/client/src/game/sfx.ts` — Web Audio singleton. Lazy `AudioContext` (browser autoplay policy: created on first `play*()` call, which always lands inside a user-gesture call stack via pointer-lock + click). One shared cache of decoded `AudioBuffer`s; each play allocates a fresh `AudioBufferSourceNode` so overlap works.

- **Gunshot**: triggered for every `shot` event in `Character.tsx` (subscriber runs once per character; each fires for its own `playerId` only, so own + remote shots all play uniformly). Distance-attenuated — gain falls linearly to a floor at `GUNSHOT_MAX_DIST` (60m). Camera position resolved via `useThree(s => s.camera)`.
- **Dry-click**: triggered in `LocalPlayer.tsx` when `consumeFire()` is true with `meNow.alive && meNow.ammo <= 0`. Server silently ignores no-ammo fires (`tryFire` early-returns), so this is a pure client-side feedback; the local player already knows ammo from the snapshot.
- **Hit-marker**: same `Character.tsx` shot subscriber, gated on `playerId === myId && ev.hit !== null`. Non-spatial (it's UI feedback). The mp3 has ~217ms of leading silence before the impact transient — `findOnset()` scans for the first sample at ≥10% of peak amplitude (cached per URL) and `src.start(0, offset)` skips the lead-in so the impact lands with the gunshot.
- **Reload**: triggered by a `useEffect` in `Character.tsx` watching the `reloading` prop for a `false → true` transition; looks up the player's position from the latest snapshot for distance attenuation. Tighter falloff than gunshot (`RELOAD_MAX_DIST = 25`) — only audible to nearby enemies as a tactical cue. Audio is 2.0s, server `WEAPON.reloadMs` is 1500ms; the tail plays past reload completion (intentional, no truncation).

Volume constants live at the top of `sfx.ts`. Source SFX live in `Audio/SFX/` (not committed); the in-game files are 1:1 copies in `public/audio/`.

## Known issues

- **Shots from elevation get blocked above the visible wall on `fps_shooter`.** The hit-detection chain (camera-anchored cast + capsule + lag-comp rewind) all behave correctly when validated in isolation. The problem is geometry data: `OBSTACLES` collision AABBs for some elevated platforms appear to extend higher than the rendered wall geometry. Standing behind cover at the top of the multi-level map and aiming down at someone — reticle is on the target, server's `raycastObstacles` from the camera origin still hits an invisible AABB above the visible top edge, shot returns blocked, no hit marker. From above the cover (jumping onto the ledge instead of behind it) the rate improves but isn't perfect. **Don't try to fix in `tryFire`** — the cast is correct; the geometry data is wrong. Fix path: audit the AABBs emitted by `scripts/extract-map-collision.mjs` for `fps_shooter` against the visible mesh top edges. The voxelizer's greedy merge step is the most likely culprit (it can extend an AABB upward past the mesh top when the cell above is also "solid" by the conservative voxelization). Compare voxel cell tops to actual mesh `boundingBox.max.y` per merged region and clamp.

## State of the art (open polish items)

**Fork-specific in-flight work lives in [`docs/workbook.html`](docs/workbook.html).** Open the file in a browser for status pills + action items. Cards include B1 (voice session drops while stationary — instrumented, awaiting reproduction with ring buffer hot), B5/B9 (arena nav + sky-walking), F1 (Halsey — meta-fiction NPC creation, will use persona deltas), F2/F3 (sense-of-time follow-on, jump action). Pulling from there before doing other engine polish keeps the persona work cohesive.

Queued fork-specific features (not yet in the workbook):

- **NPC vision (player-triggered).** When a player asks an NPC to look at something ("what do you see," "look over there"), the NPC describes the scene in character. Architecture: ElevenLabs `look_around` tool + regex fallback → server requests an offscreen render from the talking player's client (camera at NPC's eye, yaw aligned with player's yaw so "look there" = "look where I'm looking") → client uploads ~30KB JPEG → server calls Claude Haiku vision → result returned as a `self_vision_result` self-state alert → agent's next turn voices it. Stall mechanic: tool response instructs the agent to say "hmm, let me see..." while the ~2s round-trip resolves. Bounded: one pending look per session, 8s timeout with fallback alert, only on explicit player request (no autonomous looking). Caveats noted in design: GL state restoration during the offscreen render, `LOCAL_HIDE_DIST` body-hide should be disabled for NPC POV captures, drei `<Html>` nameplates won't render into the target. Adds a new `GameChange` so personas know the capability exists. Promote to an `F#` workbook card when work starts.

Engine-level (inherited from upstream Slipstream, all still real):

- **Audit obstacle Y-bounds for `fps_shooter`** (see Known issues above). Highest-impact gameplay fix outstanding.
- **RTT-component lag compensation.** Today's rewind covers `NET.interpolationDelayMs` only; not per-client RTT/2. Adding it requires a client ping loop (none exists today — the `ping`/`pong` wire types are defined but no code sends pings), an RTT estimator on the client, and a new `rtt` field on `InputFrame` so the server can rewind by `now - interpolationDelayMs - rtt/2`.
- **Reload state**: clip exists in GLB, R-key sends `input.reload`, server runs `WEAPON.reloadMs` timer, but state machine never enters Reload (no event triggers it). Need to wire a "reload started" event from server.
- **Real Jump clip**: `Jump` state currently maps to `RunF` frozen mid-stride (`JUMP_POSE_TIME = 0.35`). Replace with a Mixamo `Jump` clip and remove the freeze code in `applyClipMode`.
- **Gun tracks hand rotation**: gun follows hand position but its rotation is fixed at `[0, π, 0]`. Need to extract rotation from `bone.matrixWorld` after scale-normalization.
- **Multi-character UI**: `Ch35.glb` ships and the wire format carries `characterId`, but the lobby has no character picker.
- **Strafe clips**: `StrafeL` / `StrafeR` exist but aren't picked by the locomotion state machine (it uses 8-direction `WalkX`/`RunX` instead). Either wire strafe or delete the unused clips.

## What NOT to do

- Don't push directly to `main`. Branch protection requires a code-owner approval on every PR. Even the maintainer goes through PRs in normal cases.
- Don't add auto-deploy on merge. The two-gate model (PR review + manual deploy) is intentional. If you change this, update `CONTRIBUTING.md` and `apps/client/src/ui/clonePrompt.ts` to match.
- Don't merge the authoritative cast and the visible tracer in `tryFire`. They look duplicative and aren't — splitting them is the only way the shot can come from the camera while the bullet appears to come from the gun.
- Don't commit `Animations/`, `Characters/`, `Audio/`, `Maps/`, or `apps/party/.env` — gitignored. Source files run hundreds of MB and `.env` carries the access code.
- Don't run destructive git operations (`reset --hard`, `push --force`, `worktree remove --force`) without explicit user authorization.
- Don't add features beyond what was asked. Bug fixes don't need surrounding cleanup; one-shot operations don't need helpers.
- Don't add comments narrating what the code does. Names + tests do that.
- Don't introduce backwards-compat shims for code paths the user is fine changing.
- Don't `git add -A` blindly after generating large artifacts — check `git status` first to catch the next 246MB FBX commit before it lands.

---

# Fork-specific: NPC voice + friendship system

Everything above this section is inherited from upstream Slipstream and applies verbatim. The section below documents the fork's additions.

## Social contract

- **NPCs are peaceful by default.** Bot AI (`apps/party/src/bots/controller.ts`) still patrols and explores, but `findVisibleTarget` is replaced with `findVisibleHostileTarget` — bots only consider players hostile if the social state says they are.
- **Hostility is shooter-keyed and time-decayed.** When a shot lands on a player (server confirms hit in `tryFire`), `social.markAttack(shooterName, victimId)` pushes a `HostilityEntry { towardsName, until }` onto the victim AND every player in `victim.friendsWith`. `HOSTILITY_MS = 30_000`. Pruned each tick. After it expires the NPC returns to patrol.
- **Friendship is a real graph.** Both NPCs and humans can have `friendsWith: string[]`. NPCs start with seed friendships from the roster. Players earn NPC friendship via conversation: the ElevenLabs agent has a `make_friend(player_name)` tool that webhooks back into PartyKit (`POST /tools/make_friend`).
- **Friendship is authoritative on the server.** Stored in PartyKit Durable Object storage keyed by `friend:<npcId>:<playerName>`. Survives room restarts.

## Voice topology (V1)

- **Per-player 1:1 ConvAI sessions.** Each player runs its own ElevenLabs Conversational AI session with whichever NPC is in proximity. Browser ↔ ElevenLabs direct WebRTC; PartyKit is not in the audio path.
- **NPC memory is the bridge between sessions.** On `voice_session_start`, the server returns an `npc_context` message with a 2KB memory blob: friendship score + last 10 lines with this player + last 5 lines with anyone recently in earshot of this NPC. The agent receives the blob as a session prompt override, so the same NPC "remembers" what other players said.
- **Other players in earshot hear the agent's TTS** via a PartyKit-broadcast `npc_audio` event, played positionally on listener clients (PannerNode HRTF). Speaker mic stays direct to ElevenLabs.
- **Always-on, proximity-gated mic** within `NPC_VOICE_RADIUS = 5m` with 0.5m hysteresis. At most one session at a time per local player; closest wins on overlap.
- **Mute** is keyboard `M` plus Xbox controller button (Y or LSB). Muted = `track.enabled = false`; session stays open so NPC voice is still heard.

### Known limitation
V1 is per-listener sessions, not true N→1→N multi-speaker. Agent has cross-player context via memory blob but each response is driven by one speaker. True multi-speaker bridge (server-side STT per stream, single LLM conversation, broadcast TTS) is deferred to V2.

## Identity & consent

- **Player identity is `hello.name`** for v1. Two players named "Bob" share friendship and transcript state. Real fix is a per-player UUID flow — track as future work.
- **Voice recording requires consent.** `ConsentGate.tsx` renders before `Lobby.tsx`; checkbox covers voice recording, transcription, storage, and third-party (ElevenLabs) transmission. Florida is a two-party-consent state — do not bypass this gate. Consent is stored both in `localStorage` (`slipstream_consent_v1`) and server-side (Durable Object `consent:<playerName>`).

## Wire types (additions to `packages/shared/src/messages.ts`)

`ClientMessage`:
- `consent { agreed, version }`
- `voice_session_start { npcId, sessionId }`
- `voice_session_end { sessionId, reason? }` — `reason` is diagnostic (`proximity | npc_disappeared | sdk_ended | sdk_error | teardown | manual`); server emits it into the feedback pipeline so B1-style "session dropped without a user action" cases are visible
- `transcript { npcId, sessionId, role: 'user' | 'agent', text, at }`

`ServerMessage`:
- `consent_required { version }`
- `npc_context { npcId, sessionId, agentId? | signedUrl?, memoryBlob, friendship, elapsedSinceLastMs? }` — elapsed-since-last drives the B2 greeting-recency bucket on the client
- `npc_alert { npcId, sessionId, text }` — system message pushed into the live ConvAI session via `sendContextualUpdate`. Used to feed the agent in-game events (`damaged`, `shot_fired`, `friend_attacked`, etc.) AND self-state confirmations (`self_follow_started`, `self_attack_stopped`, etc.) so the LLM's perception stays aligned with server state. See "Self-state alerts" below.

## Where things live (new files in this fork)

```
packages/shared/src/
  npc-roster.ts                       — NpcDef + NPCS (7 personas with baked agentIds)
  npc-voice.ts (if present) / VOICE_BY_CHARACTER in npc-roster.ts — source of truth for
                                        per-character voice ids (not a runtime input;
                                        each agent has its tts.voice_id baked in)
apps/party/src/
  social.ts                           — markAttack, isHostileTo, pruneHostility,
                                        adoptHostility, clearHostility
  storage.ts                          — GameStorage: write-back cache over DO storage.
                                        consent / friendship / transcript / lastSession /
                                        npcState (persona deltas — see F5 section).
  bots/
    controller.ts                     — tickBot. State machine: patrol/hunt/engage.
                                        Follow sub-state machine (HOLD ↔ FOLLOWING
                                        with hysteresis + turn-first delay) — see
                                        "Follow state machine" below.
    aim.ts                            — findVisibleTarget (hostility-gated),
                                        slewAngle, yawPitchToward
    path.ts                           — planPath (returns null on unreachable goal
                                        so the controller can drop+repick instead
                                        of steering into walls)
    waypoints.ts                      — getNavGraph: per-map cache from MapDef
apps/client/src/voice/
  mic.ts                              — getUserMedia + permission flow
  ConvAISession.ts                    — @elevenlabs/client wrapper. firstMessage
                                        picked by recency bucket (B2 sense-of-time);
                                        memoryBlob pushed via sendContextualUpdate
                                        AFTER connect so it layers on the baked
                                        persona instead of replacing it.
  manager.ts                          — proximity-gated session start/end with
                                        reason-tagged voice_session_end emits (B1)
  mute.ts                             — global mute singleton (keyboard + gamepad)
apps/client/src/ui/
  ConsentGate.tsx                     — pre-lobby consent
  MuteIndicator.tsx                   — HUD widget
```

## ElevenLabs agent system (current — supersedes the older "dashboard setup" notes)

The voice stack is now substantially automated. Skim once; everything below is reproducible without dashboard clicks.

### One agent per NPC, created via REST API

Every NPC in `npc-roster.ts` has a real `agentId` (no more `TODO_AGENT_ID_*` placeholders). Each agent has:

- **Baked system prompt** = the NPC's `personality` field (multi-paragraph backstory + speech tics + topic rotation + things-to-avoid).
- **Baked voice** (`tts.voice_id`) per `VOICE_BY_CHARACTER` mapping — no per-session voice override; the agent ID alone selects the right voice.
- **Six webhook tools** attached (see "Tool webhooks" below).
- **Shared knowledge base** attached (the world bible — see below).
- **Overrides** still enabled for `voice_id` / `first_message` / `prompt` on the platform side, so legacy override paths don't 422 — but the client only uses `firstMessage` (greeting selection) and pushes memoryBlob via `sendContextualUpdate` instead of overriding `prompt`.

`resolveAgentId(npc)` in `server.ts` returns `npc.agentId` directly. The old `ELEVENLABS_AGENT_ID` env-var fallback is dead.

### Tool webhooks (six total)

All routed by `apps/party/src/server.ts:onRequest` under `/parties/main/<roomId>/tools/<name>`, secret-gated by `ELEVENLABS_AGENT_TOOL_SECRET`. Each tool's dashboard JSON is in [`docs/agent-tools.md`](docs/agent-tools.md).

| Tool | Effect on the game |
|---|---|
| `make_friend` | Friendship score += `SOCIAL.friendBoost`. Past threshold the player and NPC are mutually `friendsWith` and the bot defends them on damage cascade. |
| `follow_player` | Sets `bot.botFollowing = humanId`. Bot path-finds with the follow state machine. |
| `stop_following` | Clears `bot.botFollowing`. |
| `flee_from` | Sets `bot.botFleeingFrom = { id, until: now + SOCIAL.hostilityMs }`. Bot paths away. |
| `start_attacking` | Conversationally-induced hostility (`adoptHostility`). 30s window, no friend cascade. |
| `stop_attacking` | Clears hostility toward a target (`clearHostility`). Also drops `botTargetId` if it matches. |

Tool params arrive as either query string OR JSON body. Both forms supported because the dashboard form-config defaults to query and the JSON-mode dashboard defaults to body.

### Knowledge base (shared world bible)

Every agent has a shared knowledge base document attached: [`docs/world-bible.md`](docs/world-bible.md). Describes the arena, what NPCs can/can't do, who the other NPCs are, the outside world, and the deliberately-ambiguous "who runs this." Re-upload with `pnpm sync:kb` after editing — the script POSTs to `/v1/convai/knowledge-base/text` and re-PATCHes every agent's `knowledge_base` array.

### memoryBlob (dynamic per-session)

Built in `server.ts:buildMemoryBlob` at session start, pushed to the agent via `sendContextualUpdate` after connect. Sections (in order):

1. **`## What's changed about you (authoritative — overrides your persona)`** — persona deltas. If non-empty, instructs the LLM to treat these as TRUE NOW and the baked persona as the prior baseline. See "Persona deltas (F5)" below.
2. **`## The game you live in`** — boilerplate world description.
3. **`## Time since you last talked`** — present only when this player has spoken with this NPC before (per `getLastSessionEnd`). Tells the LLM how to phrase the gap.
4. **`## Right now`** — live state: health, ammo, follow target, flee target, hostility toward this player.
5. **Friendship score** + **recent transcript** + **cross-pollination** lines (other players this NPC spoke with in the last 5 min).

Persona (the agent's static system prompt) is NOT in the blob — it lives on the agent and the blob layers above it.

## Persona deltas (F5) — durable NPC self-knowledge

When in-fiction events change a character ("your shoulder pain is gone", "your friend Halsey is back"), we don't re-PATCH the ElevenLabs agent. We write a delta to DO storage and surface it via memoryBlob.

- Storage key: `state:<npcId>` → `NpcStateEntry[]` (`{ at, summary, evidence?, source }`). Capped at 50, oldest dropped.
- API: `GET/POST/DELETE /admin/npc-state?npcId=…` (secret-gated, no consent check — operator action).
- CLI: `pnpm npc:state <npcId> "<summary>" [--evidence=…] [--source=…]`, plus `--list` / `--clear`.
- memoryBlob front-loads the delta list under `## What's changed about you` with instructions that it overrides the persona where they conflict.
- **Per-room** today (each map's DO has its own state). A delta written on `fps_shooter` won't appear when the same NPC is talking on `arena`. Documented v1 limitation; same applies to transcripts and friendships.

The first hand-applied delta is Mira's shoulder-pain healing (5/16). The next likely use is the Halsey return (F1 in the workbook).

### Game changes — the durable "NPCs notice every change you ship" pattern

Hand-applying deltas via `pnpm npc:state` is for one-offs. **For permanent changes to the world that every NPC should know about** (new mechanics, new characters, world-state shifts), use the registry instead:

- File: [`packages/shared/src/game-changes.ts`](packages/shared/src/game-changes.ts) exports `GAME_CHANGES: readonly GameChange[]`.
- Each entry: `{ id, at, scope: 'all' | npcId[], summary, evidence? }`. Summary is NPC-POV, second person, present tense — same shape as a manual delta.
- Server's `onStart` calls `seedGameChanges()`, which walks the array. For each `id` whose `seeded:<id>` flag is absent in this room's DO, it appends a delta to every in-scope NPC's `state:<npcId>` and sets the flag. Idempotent — re-seeding never duplicates.
- Logs each seed: `[game-change] seeded <id> → N NPC(s) in room <map>`.

**The workflow is:**

1. Ship the code change (add coffee, add a character, fix a bug, etc.).
2. Add a `GameChange` entry describing what NPCs should know.
3. Reload the server. Each room's onStart writes the delta into NPC state exactly once.
4. Next session, NPCs reference the change in character via memoryBlob.

**Important conventions:**

- The `id` is the dedup key. **Never rename or reuse.** If you change an entry's wording after it's seeded into a room, existing rooms keep the old wording — bump the id (e.g. add `-v2`) to re-seed everywhere.
- `at` should be deterministic across deploys. Use `Date.parse('2026-05-16T00:00:00Z')`, not `Date.now()`.
- Each map's DO has its own seeded state. A change seeded on `fps_shooter` will re-seed when a fresh `arena` DO wakes up (correct — both maps need the knowledge), then mark seeded there too.
- The 50-entry cap on `state:<npcId>` means very old game-changes drop off. If the registry grows past ~40 entries, raise `NPC_STATE_CAP` in storage.ts or partition into tiered storage.
- **What does NOT go here:** per-player history (use friendship), event-triggered cascades like "first player to drink coffee" (those stay imperative — see `coffee:discovered`), or one-off character changes you applied with `pnpm npc:state`. If you DO want a one-off to be reproducible across fresh rooms, add it here instead.

## Follow state machine (B6 + B10)

The bot's follow behavior is a discrete state machine, NOT a continuous "stay 3m behind player" computation. The naïve version had two visible bugs (always-behind-player, walks-backward-on-180°-approach) that the state machine fixes.

```
HOLD          (close)  ────────────→ stand still, goal = bot.position
              dist > followResumeDist (4m)
              ────────────────────────────→ FOLLOWING
FOLLOWING     (far)    ────────────→ walk toward player, goal = player.position
              dist ≤ followStandoffDist (2.5m)
              ────────────────────────────→ HOLD
```

On `HOLD → FOLLOWING`, the controller sets `botFollowHoldUntil = now + followResumeDelayMs (500ms)`. During that window the movement section zeroes forward/right while the path planner and yaw slew continue to run, so the bot turns to face the player FIRST and then walks. Eliminates the "walks-backwards-while-turning" gait.

Hysteresis gap (2.5m inner, 4m outer): the player can walk past the bot at close range without the bot retreating to maintain standoff. State fields live on `ServerPlayer`: `botFollowMoving?: boolean`, `botFollowHoldUntil?: number`. Constants in `BOT`: `followStandoffDist`, `followResumeDist`, `followResumeDelayMs`.

State is reset on every transition (tool handler clear/set, regex fallback, disconnect) so a fresh follow always gets the turn-first delay.

## Self-state alerts (B10)

The agent's LLM has no proprioception. When the server changes a bot's `botFollowing` / `botFleeingFrom` / `hostility` / `friendsWith` (regardless of which code path made the change), the LLM doesn't notice — and will confidently deny what its body is doing ("my feet are stuck") on the next turn.

Fix: `server.ts:pushSelfStateAlert(bot, alert)` formats an `npc_alert` ServerMessage and sends it to the bot's active voice session (if any). The SDK queues it as a contextual update for the agent's next turn. Wired into every state-change site:

- All six tool handlers
- The regex fallback in `applyTranscriptIntent` (the path that catches "follow me" / "stop following" in user transcripts when the LLM doesn't fire the tool)
- Damage cascade (`markAttack` cascading hostility to friends) — fires `friend_attacked`
- Hostility expiry (`pruneHostility`) — fires `hostility_ended`

`NpcAlert` (in `apps/party/src/simulation.ts`) is the discriminated union of all alert kinds. Currently 15 kinds: `damaged | shot_fired | friend_attacked | kill_witnessed | hostility_ended | npc_befriended_player | player_reloaded | player_joined | player_left | self_follow_started | self_follow_stopped | self_flee_started | self_attack_started | self_attack_stopped | self_befriended_player`. `server.ts:formatNpcAlert` is the single point where each kind becomes a `[System: …]` system message.

## Feedback pipeline

The server emits structured `[EVENT] {json}` lines on stdout for every interesting thing. In dev: `pnpm dev 2>&1 | tee logs/events-$(date +%Y-%m-%d).jsonl`. The lines are greppable past PartyKit's ANSI noise.

Event kinds (defined in `server.ts`):
- `tool_call` — every webhook tool, ok=true/false
- `voice_session` — start / end (with `reason` for B1 diagnostics, `durationMs` for telemetry)
- `hostility_change` — set / clear / expire / cascade
- `shot_fired` — every bot fire (hit + killed flags + shooter NPC id)
- `friendship_change` — delta, new score, becameFriend boolean
- `nav_blocked` — controller fires when `planPath` returns null
- `feedback_signal` — regex-extracted from user transcripts (`bug`, `stuck`, `should`, etc. — see `FEEDBACK_TRIGGERS`)

Also kept as a **1000-event in-memory ring buffer** on the server (per-DO isolate) so the admin HTTP routes can join events with transcripts without needing the tee'd file.

`pnpm feedback:report [--player=X] [--since=24h] [--no-llm]` — reads logs/events-*.jsonl + decodes DO transcripts directly (via `v8.deserialize`) + retroactively regex-scans transcripts for feedback signals + (if `ANTHROPIC_API_KEY` is set) calls Haiku for structured `{category, summary, evidence, urgency, area}` extraction from the player's utterances. Produces markdown.

## Workflow tooling (F6) — the durable feedback path

Don't decode DO SQLite by hand. The path going forward is:

1. Player plays the game.
2. Player tells the agent something interesting happened.
3. `pnpm session:last [N]` — calls `/admin/sessions` on both `fps_shooter` and `arena` rooms, merges, sorts by recency, pretty-prints markdown with: room, time range, NPCs, transcript, events fired during the window, persona deltas that were active at session start.

Admin HTTP routes, all secret-gated by `ELEVENLABS_AGENT_TOOL_SECRET`, scoped per-room (per-DO):

| Route | Method(s) | Returns |
|---|---|---|
| `/admin/sessions?count=N&player=X&since=2h` | GET | Last N sessions decoded from transcripts, joined with ring-buffer events + persona-delta snapshots |
| `/admin/state` | GET | Every NPC's persona-delta entries in one call |
| `/admin/snapshot` | GET | Live game state: positions, hostility (with msRemaining), follow targets, friendsWith |
| `/admin/npc-state?npcId=…` | GET / POST / DELETE | Persona-delta CRUD (used by `pnpm npc:state`) |

## Workbook

[`docs/workbook.html`](docs/workbook.html) is the durable bug + feature tracker. Self-contained HTML with CSS, opens in any browser. Status pills (`todo` / `doing` / `done` / `blocked`), priority pills, item cards (bugs vs features), TOC with anchor jumps.

The convention: every observed bug gets a `B<N>` card. Every feature gets an `F<N>` card. Each card has: symptom, root cause, fix, action items (checkboxes), and a verification block. Promote pills as work lands.

The workbook is the canonical place to plan and track multi-turn work. CLAUDE.md describes the architecture; the workbook tracks the in-flight changes.

## What NOT to do (fork additions)

- Don't put microphone audio through PartyKit in V1. Browser → ElevenLabs direct keeps audio off the Workers runtime, which has tight limits on long-running streams.
- Don't trust client-side friendship claims. Server is authoritative; client just renders what comes back in snapshots and `npc_context`.
- Don't bypass `ConsentGate` for testing convenience — Florida two-party consent applies. If you need a dev mode, document it explicitly and gate on a Vite env var so it can't ship.
- Don't store raw audio. Only transcripts are persisted (and only with consent).
- **Don't change a bot's `botFollowing` / `botFleeingFrom` / `hostility` / `friendsWith` without calling `pushSelfStateAlert`.** The LLM has no proprioception; without the alert it will confidently deny what its body is doing on the next turn (B10's root cause). Every state-change site must push.
- **Don't add a new `NpcAlert` kind without also adding a `formatNpcAlert` case.** The default branch returns `null` and silently drops the alert.
- **Don't decode DO SQLite by hand to look at sessions.** Use `pnpm session:last`. The script walks all rooms, joins events, and renders markdown in one shot. If `session:last` doesn't show what you need, EXTEND IT — that's the durable workflow path (F6).
- **Don't add work items outside the workbook ([`docs/workbook.html`](docs/workbook.html)) for anything multi-turn.** The workbook is the canonical tracker; CLAUDE.md is the architectural doc. Status pills + B/F numbering give us a thread to follow across sessions.
- **Don't PATCH agent system prompts to fix one-off character changes.** Use persona deltas instead (`pnpm npc:state`). The agent's baked persona is the prior baseline; deltas are how in-fiction changes propagate without destroying the persona or requiring rollback machinery.
- **Don't ship a game mechanic without a `GameChange` entry** if it's something NPCs should be able to talk about. The registry lives in `packages/shared/src/game-changes.ts` and is auto-seeded on `onStart`. Bug fixes that don't change in-game reality (e.g. internal nav improvements) don't need entries; player-visible mechanics (coffee, weapons, mode changes) do.
- **Don't rename or reuse a `GameChange.id`.** It's the dedup key. If you change an entry's wording after it's seeded into a room, the room keeps the old wording — bump the id to re-seed everywhere.
- **Don't assume cross-room state continuity.** Each map's PartyKit room is its own DO. Transcripts, friendships, persona deltas, last-session timestamps are all per-room. A delta written on `fps_shooter` is invisible on `arena`. Either accept this v1 limitation or implement a global state plane.
