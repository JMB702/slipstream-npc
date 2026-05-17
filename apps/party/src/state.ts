import { PLAYER, getActiveMap, type CharacterId, type HostilityEntry, type PlayerState, type Vec3 } from '@slipstream-npc/shared';

export type BotState = 'patrol' | 'hunt' | 'engage' | 'reposition' | 'dead';

export interface ServerPlayer extends PlayerState {
  connectionId: string;
  pendingInputSeq: number;
  grounded: boolean;
  // Wall-clock time (ms, server frame) of the last physics integration.
  // runTick uses this to fill gaps when a player isn't sending inputs so they
  // don't freeze in mid-air after spawn or during an AFK pause.
  lastIntegratedAt: number;
  // Wall-clock time (ms, server frame) the player last took damage.
  // Health regen kicks in once `now - lastDamagedAt >= PLAYER.regenDelayMs`.
  lastDamagedAt: number;
  // Window-vault state. When `vaultEndAt` is non-null, the server is tweening
  // the player from `vaultFrom` to `vaultTo` and ignores movement input until
  // `now >= vaultEndAt`. The wire-visible `vaulting` boolean on PlayerState
  // mirrors `vaultEndAt !== null`.
  vaultFrom: Vec3 | null;
  vaultTo: Vec3 | null;
  vaultEndAt: number | null;
  // Lag-compensation rewind buffer. Each tick pushes (serverTime, position).
  // tryFire looks up each potential victim's position at
  // `now - NET.interpolationDelayMs` so we hit-test against where the
  // shooter SAW them on screen, not where they happen to be at receipt.
  // Cleared on respawn so a freshly respawned player can't be hit at their
  // last-life location.
  positionHistory: Array<{ t: number; pos: Vec3 }>;
  // Per-shooter hostility timers. NPCs only fire on names listed here whose
  // `until` is in the future. `social.markAttack` pushes entries on confirmed
  // hits (the victim and every name in victim.friendsWith).
  hostility: HostilityEntry[];
  // Per-bot controller state. None of these cross the wire — stripped in
  // server.ts before broadcast. All optional so humans pay no extra cost.
  botState?: BotState;
  botPath?: Vec3[];
  botPathIdx?: number;
  botGoal?: Vec3 | null;
  botTargetId?: string | null;
  botLastReplanAt?: number;
  botLastTargetCheckAt?: number;
  botLastLosCheckAt?: number;
  botLastSawTargetAt?: number;
  botEngagedAt?: number;
  botInputSeq?: number;
  botStuckSince?: number;
  botSawTargetSince?: number;
  botStrafeSign?: number;
  botStrafeFlipAt?: number;
  // Recently chosen patrol goal node indices — drives variety in
  // pickExplorationGoal so bots don't oscillate between the same two nodes.
  botVisitedRecent?: number[];
  // Player id this NPC is currently in a voice conversation with. Set by
  // server.handleVoiceSessionStart, cleared on voice_session_end / player
  // disconnect. tickBot freezes movement and faces this player when set
  // (unless interrupted by hostility-driven engage).
  botConversationWith?: string | null;
  // Conversation-session id active with `botConversationWith`. Used by the
  // server to address npc_alert messages back to the right session — the
  // SDK uses sessionId to discard stale alerts after a reconnect.
  botActiveSessionId?: string | null;
  // Player id the NPC is currently following (because the agent called the
  // follow_player tool during a session). tickBot path-finds toward this
  // player while patrol/engage haven't taken precedence.
  botFollowing?: string | null;
  // Follow state machine. `botFollowMoving` is true when the bot is actively
  // walking toward the follow target (FOLLOWING sub-state), false when it's
  // standing in the standoff/hysteresis band (HOLD sub-state). Hysteresis
  // gap (BOT.followStandoffDist → BOT.followResumeDist) means the player
  // can walk past the bot at close range without the bot retreating to
  // maintain distance — they just stay put until the player is far enough
  // away to retrigger FOLLOWING. `botFollowHoldUntil` is a wall-clock deadline
  // set on HOLD → FOLLOWING transitions; until it expires, forward motion is
  // suppressed (yaw still slews) so the bot turns toward the player BEFORE
  // walking.
  botFollowMoving?: boolean;
  botFollowHoldUntil?: number;
  // Player id the NPC is fleeing FROM (because the agent called flee_from).
  // `until` is a wall-clock deadline after which fleeing decays back to
  // patrol unless re-triggered.
  botFleeingFrom?: { id: string; until: number } | null;
  // When true, the bot sprints in non-engage states regardless of next-waypoint
  // distance. Set by /tools/sprint_patrol, cleared by /tools/patrol and by
  // any state that overrides patrol (engage, follow, flee, lean). Combat
  // already governs its own sprint behavior, so this is irrelevant during engage.
  botForceSprint?: boolean;
  // Set by /tools/lean_wall. Once set, the bot path-finds to this point;
  // when within waypointArriveDist the controller applies pose='lean_wall'
  // and clears the field. Bot's facing is computed to put its back against
  // the wall at the requested standoff. Cleared by patrol/sprint_patrol/
  // follow/flee/stop_attacking transitions.
  botLeanTarget?: { position: Vec3; yaw: number } | null;
  // Wall-clock time (ms, server frame) when the current pose / poseTransition
  // started. tickBot and the simulation loop use this to flip transitions to
  // their steady-state pose after the matching POSE.*Ms duration elapses.
  poseStartedAt?: number;
  // Date.now() of this player's most recent successful coffee drink. Server-
  // only — the wire-visible buff window lives in PlayerState.coffeeBuffUntil.
  // Used for telemetry and for future nonzero cooldowns if we re-enable one.
  lastCoffeeDrinkAt?: number;
  // Wall-clock deadline by which this bot wants to reach the coffee maker.
  // Set when the agent calls the drink_coffee tool; the bot controller
  // overrides its patrol goal with the coffee maker's navigation point until either
  // (a) the bot gets within COFFEE.interactRadius and tryDrinkCoffee fires,
  // or (b) the deadline elapses (couldn't reach the maker — give up).
  // Cleared in both cases.
  botGoingForCoffeeUntil?: number;
}

export const initialPlayer = (
  connectionId: string,
  id: string,
  name: string,
  spawn: Vec3,
  now: number,
  options?: { isBot?: boolean; characterId?: CharacterId },
): ServerPlayer => ({
  id,
  connectionId,
  name,
  position: spawn,
  velocity: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  health: PLAYER.maxHealth,
  alive: true,
  respawnAt: null,
  ammo: 30,
  reloading: false,
  reloadDoneAt: null,
  vaulting: false,
  kills: 0,
  deaths: 0,
  lastSeenSeq: 0,
  isBot: options?.isBot ?? false,
  characterId: options?.characterId ?? 'soldier',
  friendsWith: [],
  // Casual is the default vibe — peaceful NPCs, players hands-down. Combat
  // mode (pose === null) engages on the H key, RB on Xbox, or any incoming
  // fire/damage event via applyInput / tryFire's clearPose calls.
  pose: 'casual_idle',
  poseTransition: null,
  danceVariant: 0,
  pendingInputSeq: 0,
  grounded: true,
  lastIntegratedAt: now,
  lastDamagedAt: 0,
  vaultFrom: null,
  vaultTo: null,
  vaultEndAt: null,
  positionHistory: [],
  hostility: [],
});

export const randomSpawn = (): Vec3 => {
  const map = getActiveMap();
  // Prefer hand-authored spawn points when the map provides them — picking
  // from a known-safe list eliminates the wall-clip edge cases that random
  // rejection sampling can hit when the playable area is densely occupied.
  if (map.spawnPoints.length > 0) {
    const i = Math.floor(Math.random() * map.spawnPoints.length);
    const [x, y, z] = map.spawnPoints[i]!;
    return [x, y, z];
  }
  // Fallback: rejection-sample in the spawnArea box. Reject candidates that
  // overlap an obstacle's inflated AABB so we don't spawn stuck inside one.
  const half = map.spawnArea;
  const r = PLAYER.radius;
  const halfH = PLAYER.height / 2;
  for (let attempt = 0; attempt < 32; attempt++) {
    const x = (Math.random() * 2 - 1) * half;
    const z = (Math.random() * 2 - 1) * half;
    const y = map.spawnHeight;
    if (!insideAnyObstacle(x, y, z, r, halfH)) {
      return [x, y, z];
    }
  }
  return [0, map.spawnHeight, 0];
};

const insideAnyObstacle = (
  x: number,
  y: number,
  z: number,
  r: number,
  halfH: number,
): boolean => {
  for (const o of getActiveMap().obstacles) {
    if (
      x > o.pos[0] - o.halfSize[0] - r &&
      x < o.pos[0] + o.halfSize[0] + r &&
      y > o.pos[1] - o.halfSize[1] - halfH &&
      y < o.pos[1] + o.halfSize[1] + halfH &&
      z > o.pos[2] - o.halfSize[2] - r &&
      z < o.pos[2] + o.halfSize[2] + r
    ) {
      return true;
    }
  }
  return false;
};
