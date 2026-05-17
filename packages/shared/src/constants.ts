export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;

export const MAX_PLAYERS = 8;

export const MAP = {
  size: 60,
  // Y-coordinate of the capsule center at spawn = ground-rest height (height/2).
  // Spawning above floor would cause idle players to float forever, since the
  // server only integrates gravity when an input arrives.
  spawnHeight: 0.9,
} as const;

export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  walkSpeed: 6.0,
  sprintSpeed: 9.0,
  // Jump tuned so the short scattered slabs (top y=1 and y=1.5) are reachable.
  // With jumpSpeed=9, gravity=24: peak height ≈ 1.69m above standing, peak
  // center y ≈ 2.59m. Margin to mount a y=1.5 block: 0.19m (comfortable).
  // y=2 blocks still unreachable (margin -0.31m), preserving the cover-vs-
  // platform distinction. Time to peak ≈ 0.375s, total airtime ≈ 0.75s.
  jumpSpeed: 9.0,
  gravity: 24.0,
  // Auto-step over obstacles up to this tall (stairs, low ledges, kerbs).
  // Below the half-meter typical of step risers — anything taller still needs
  // a jump so the cover-vs-platform distinction holds.
  stepHeight: 0.55,
  maxHealth: 100,
  // Corpse stays visible for the full duration before respawn — gives the
  // death animation time to play and lets the killer/victim see what happened.
  respawnMs: 5000,
  // Health regen kicks in after this long without taking damage.
  regenDelayMs: 4000,
  // Once regen starts, restore this many HP per second until full.
  regenPerSec: 30,
} as const;

export const WEAPON = {
  damage: 25,
  fireIntervalMs: 120,
  magazineSize: 30,
  reloadMs: 1500,
  range: 80,
  spreadDeg: 1.5,
} as const;

export const NET = {
  interpolationDelayMs: 100,
  inputBufferMax: 60,
} as const;

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export const MATCH = {
  defaultKillTarget: 10,
  minKillTarget: 1,
  maxKillTarget: 99,
  // How long the victory overlay stays before the round resets.
  victoryHoldMs: 5000,
  defaultBotCount: 3,
  minBotCount: 0,
  // Cap so bots+humans never exceed MAX_PLAYERS=8. Server clamps further if
  // humans have already filled the room. Also matches NPCS.length so every
  // lobby slot can be filled by a distinct persona.
  maxBotCount: 6,
  // Default to easy — the first user reaction was "too good", and easy is a
  // friendlier on-ramp. Selectable from the lobby.
  defaultBotDifficulty: 'easy' as BotDifficulty,
} as const;

// Difficulty-independent bot tuning. These don't affect lethality — they're
// pacing/perf knobs (controller cadence, navigation thresholds, names).
export const BOT = {
  names: ['Wraith', 'Echo', 'Vex', 'Jacqueline', 'Nyx', 'Onyx', 'Reaver', 'Specter'],
  // How often the controller re-evaluates its target pick.
  targetReacquireMs: 250,
  // How often A* recomputes a path to the current goal.
  pathReplanMs: 400,
  // While engaged, refresh line-of-sight at this rate. Cheaper than every tick.
  losCheckMs: 100,
  // Switch to next waypoint when within this distance.
  waypointArriveDist: 1.2,
  // Follow-state-machine thresholds.
  //   followStandoffDist (inner): once inside, bot enters HOLD and stands still.
  //   followResumeDist  (outer):  bot stays in HOLD until player moves past this.
  //   followResumeDelayMs:        on HOLD → FOLLOWING, suppress forward motion
  //                               for this window so the bot turns first.
  // The gap between standoff and resume is the hysteresis: when the player
  // walks past the bot at close range, the bot stays put instead of retreating.
  followStandoffDist: 2.5,
  followResumeDist: 4.0,
  followResumeDelayMs: 500,
  // /tools/lean_wall config. Search radially with N rays from chest height
  // for the nearest obstacle; stop standoff back from the hit, face away.
  // Walls farther than searchDist return "no wall nearby" (tool 404).
  leanSearchRays: 16,
  leanSearchDist: 12.0,
  leanStandoffDist: 0.55,
  // Sprint when next waypoint is at least this far.
  sprintWhenFurtherThan: 12,
  // Reload when ammo drops below this and we're not actively engaged.
  reloadAmmoThreshold: 6,
  // Velocity magnitude under which the bot is considered stuck.
  stuckSpeed: 0.8,
  // Time below stuckSpeed before triggering jump + replan.
  stuckMs: 600,
} as const;

// Per-difficulty knobs. These ARE the lethality dial.
//
//   - aimYawRateRad / aimPitchRateRad: max rad/sec the bot can swing its view.
//     Lower = "snaps" more slowly onto a target → it has to track you, giving
//     you time to break line-of-sight or hit it first.
//   - aimJitterRad: per-tick Gaussian noise added to aim. Bigger = more misses.
//   - engageReachMs: pause between first acquiring line-of-sight and the first
//     shot. Long delay = you can hear-and-react before they fire.
//   - fireRangeMax: maximum engagement distance. Lower = they don't pick you
//     off across the map; you can disengage by retreating.
//   - fireAimDotMin: cosine of the cone width inside which a bot will pull the
//     trigger. Lower (e.g. 0.985) = it might fire while still slightly
//     off-target, which combined with jitter mostly produces misses.
//   - fireDropoutChance: probability the bot SKIPS firing on a given on-target
//     tick. Even when perfectly aimed, an "easy" bot misses opportunities.
export interface BotProfile {
  readonly aimYawRateRad: number;
  readonly aimPitchRateRad: number;
  readonly aimJitterRad: number;
  readonly engageReachMs: number;
  readonly fireRangeMax: number;
  readonly fireRangeMin: number;
  readonly fireAimDotMin: number;
  readonly fireDropoutChance: number;
}

export const BOT_PROFILES: Record<BotDifficulty, BotProfile> = {
  easy: {
    // Slow head-swing — gives the player time to break LOS or land a shot first.
    aimYawRateRad: 1.0,
    aimPitchRateRad: 0.8,
    // ~5° wobble — many shots miss even when the bot "thinks" it's on target.
    aimJitterRad: 0.09,
    // Almost two full seconds of "spotted you" before the trigger pulls.
    engageReachMs: 1800,
    // Short engagement range — if you back off, bots disengage instead of sniping.
    fireRangeMax: 18,
    fireRangeMin: 5,
    fireAimDotMin: 0.98,
    // Bots fire on only ~20% of on-target ticks — very few opportunities land.
    fireDropoutChance: 0.8,
  },
  normal: {
    aimYawRateRad: 3.0,
    aimPitchRateRad: 2.2,
    aimJitterRad: 0.035,
    engageReachMs: 700,
    fireRangeMax: 40,
    fireRangeMin: 4,
    fireAimDotMin: 0.992,
    fireDropoutChance: 0.25,
  },
  hard: {
    aimYawRateRad: 5.0,
    aimPitchRateRad: 3.5,
    aimJitterRad: 0.015,
    engageReachMs: 350,
    fireRangeMax: 60,
    fireRangeMin: 4,
    fireAimDotMin: 0.996,
    fireDropoutChance: 0,
  },
};

export const isBotDifficulty = (s: string): s is BotDifficulty =>
  s === 'easy' || s === 'normal' || s === 'hard';

export interface Obstacle {
  // World-space center of the box.
  readonly pos: readonly [number, number, number];
  // Half-extents (full size = 2 * half on each axis).
  readonly halfSize: readonly [number, number, number];
}

// Loose obstacles scattered around the map outside the house.
export const SCATTERED_OBSTACLES: readonly Obstacle[] = [
  { pos: [-12, 1, -8], halfSize: [2, 1, 2] },
  { pos: [10, 1, -10], halfSize: [1.5, 1, 3] },
  { pos: [-15, 0.5, 12], halfSize: [4, 0.5, 1.5] },
  { pos: [14, 2, 8], halfSize: [1.5, 2, 1.5] },
  { pos: [6, 1, 14], halfSize: [2, 1, 2] },
  { pos: [-6, 0.75, -16], halfSize: [3, 0.75, 1] },
];

// 4-room house centered at origin. Each wall is split into the AABBs that
// frame doors and windows, so the gaps you see in the geometry ARE the
// openings — collision and rendering use the same list.
//
// Layout (top-down, +x right, +z south, -z north — standard right-handed):
//   - 12×12 footprint, walls 3m tall and 0.3m thick
//   - Interior walls at x=0 and z=0 partition into NW/NE/SW/SE rooms
//   - Front door on south wall, offset to x=-3 so it enters the SW room
//     directly without colliding with the central interior wall
//   - Windows on north (x=+3), east (z=-3), west (z=+3) walls so each
//     non-front room has a view outside
//   - Doorway between every adjacent pair of rooms (4 interior doorways:
//     SW↔NW, NW↔NE, NE↔SE, SW↔SE)
//   - Flat roof slab on top
const HOUSE_W = 6;
const WALL_T = 0.15;
const WALL_H = 1.5;
const WALL_TOP_Y = WALL_H * 2;
const DOOR_HW = 0.8;
const DOOR_TOP = 2.2;
const DOOR_HEADER_HALF_H = (WALL_TOP_Y - DOOR_TOP) / 2;
const DOOR_HEADER_Y = (WALL_TOP_Y + DOOR_TOP) / 2;
const WIN_HW = 0.75;
const WIN_BOTTOM = 1.0;
const WIN_TOP = 2.0;
const WIN_SILL_HALF_H = WIN_BOTTOM / 2;
const WIN_SILL_Y = WIN_BOTTOM / 2;
const WIN_HEADER_HALF_H = (WALL_TOP_Y - WIN_TOP) / 2;
const WIN_HEADER_Y = (WALL_TOP_Y + WIN_TOP) / 2;

// Helper: an axis-aligned wall slab spanning [a, b] on the in-wall axis,
// at fixed y from 0..WALL_TOP_Y, sitting at constant `fixed` on the through-axis.
// `axis` is which axis the wall RUNS along (the slab's length axis).
const wallSegment = (
  axis: 'x' | 'z',
  fixed: number, // value on the through-axis
  a: number,
  b: number,
  yCenter = WALL_H,
  yHalf = WALL_H,
): Obstacle => {
  const center = (a + b) / 2;
  const half = Math.abs(b - a) / 2;
  return axis === 'x'
    ? { pos: [center, yCenter, fixed], halfSize: [half, yHalf, WALL_T] }
    : { pos: [fixed, yCenter, center], halfSize: [WALL_T, yHalf, half] };
};

const doorHeader = (axis: 'x' | 'z', fixed: number, doorCenter: number): Obstacle =>
  axis === 'x'
    ? {
        pos: [doorCenter, DOOR_HEADER_Y, fixed],
        halfSize: [DOOR_HW, DOOR_HEADER_HALF_H, WALL_T],
      }
    : {
        pos: [fixed, DOOR_HEADER_Y, doorCenter],
        halfSize: [WALL_T, DOOR_HEADER_HALF_H, DOOR_HW],
      };

const windowSill = (axis: 'x' | 'z', fixed: number, winCenter: number): Obstacle =>
  axis === 'x'
    ? {
        pos: [winCenter, WIN_SILL_Y, fixed],
        halfSize: [WIN_HW, WIN_SILL_HALF_H, WALL_T],
      }
    : {
        pos: [fixed, WIN_SILL_Y, winCenter],
        halfSize: [WALL_T, WIN_SILL_HALF_H, WIN_HW],
      };

const windowHeader = (axis: 'x' | 'z', fixed: number, winCenter: number): Obstacle =>
  axis === 'x'
    ? {
        pos: [winCenter, WIN_HEADER_Y, fixed],
        halfSize: [WIN_HW, WIN_HEADER_HALF_H, WALL_T],
      }
    : {
        pos: [fixed, WIN_HEADER_Y, winCenter],
        halfSize: [WALL_T, WIN_HEADER_HALF_H, WIN_HW],
      };

const FRONT_DOOR_X = -3;
const NORTH_WINDOW_X = 3;
const EAST_WINDOW_Z = -3;
const WEST_WINDOW_Z = 3;
const NW_SW_DOOR_X = -3;
const NE_SE_DOOR_X = 3;
const NW_NE_DOOR_Z = 3;
const SW_SE_DOOR_Z = -3;

export const HOUSE_WALLS: readonly Obstacle[] = [
  // ---- South outer wall (z = -HOUSE_W), front door at x=-3 ----
  wallSegment('x', -HOUSE_W, -HOUSE_W, FRONT_DOOR_X - DOOR_HW),
  wallSegment('x', -HOUSE_W, FRONT_DOOR_X + DOOR_HW, HOUSE_W),
  doorHeader('x', -HOUSE_W, FRONT_DOOR_X),

  // ---- North outer wall (z = +HOUSE_W), window at x=+3 ----
  wallSegment('x', HOUSE_W, -HOUSE_W, NORTH_WINDOW_X - WIN_HW),
  wallSegment('x', HOUSE_W, NORTH_WINDOW_X + WIN_HW, HOUSE_W),
  windowSill('x', HOUSE_W, NORTH_WINDOW_X),
  windowHeader('x', HOUSE_W, NORTH_WINDOW_X),

  // ---- East outer wall (x = +HOUSE_W), window at z=-3 ----
  wallSegment('z', HOUSE_W, -HOUSE_W, EAST_WINDOW_Z - WIN_HW),
  wallSegment('z', HOUSE_W, EAST_WINDOW_Z + WIN_HW, HOUSE_W),
  windowSill('z', HOUSE_W, EAST_WINDOW_Z),
  windowHeader('z', HOUSE_W, EAST_WINDOW_Z),

  // ---- West outer wall (x = -HOUSE_W), window at z=+3 ----
  wallSegment('z', -HOUSE_W, -HOUSE_W, WEST_WINDOW_Z - WIN_HW),
  wallSegment('z', -HOUSE_W, WEST_WINDOW_Z + WIN_HW, HOUSE_W),
  windowSill('z', -HOUSE_W, WEST_WINDOW_Z),
  windowHeader('z', -HOUSE_W, WEST_WINDOW_Z),

  // ---- Interior E-W wall at z=0, doorways at x=-3 and x=+3 ----
  wallSegment('x', 0, -HOUSE_W, NW_SW_DOOR_X - DOOR_HW),
  wallSegment('x', 0, NW_SW_DOOR_X + DOOR_HW, NE_SE_DOOR_X - DOOR_HW),
  wallSegment('x', 0, NE_SE_DOOR_X + DOOR_HW, HOUSE_W),
  doorHeader('x', 0, NW_SW_DOOR_X),
  doorHeader('x', 0, NE_SE_DOOR_X),

  // ---- Interior N-S wall, north half (x=0, z 0..+HOUSE_W), door at z=+3 ----
  wallSegment('z', 0, 0, NW_NE_DOOR_Z - DOOR_HW),
  wallSegment('z', 0, NW_NE_DOOR_Z + DOOR_HW, HOUSE_W),
  doorHeader('z', 0, NW_NE_DOOR_Z),

  // ---- Interior N-S wall, south half (x=0, z -HOUSE_W..0), door at z=-3 ----
  wallSegment('z', 0, -HOUSE_W, SW_SE_DOOR_Z - DOOR_HW),
  wallSegment('z', 0, SW_SE_DOOR_Z + DOOR_HW, 0),
  doorHeader('z', 0, SW_SE_DOOR_Z),

  // ---- Roof ----
  { pos: [0, WALL_TOP_Y + 0.15, 0], halfSize: [HOUSE_W + 0.15, 0.15, HOUSE_W + 0.15] },
];

// Single source of truth for arena geometry. Both the client (rendering) and
// the server (collision) read from this list.
export const OBSTACLES: readonly Obstacle[] = [...HOUSE_WALLS, ...SCATTERED_OBSTACLES];

// Windows the player can vault through. Each entry describes the wall the
// window is in: `axis` is the axis the wall RUNS along, `wallCoord` is its
// position on the perpendicular axis, `openingCenter` is the window's center
// on the wall's run axis, and `openingHalfWidth` is half the opening width.
export interface WindowDef {
  readonly axis: 'x' | 'z';
  readonly wallCoord: number;
  readonly openingCenter: number;
  readonly openingHalfWidth: number;
}

export const WINDOWS: readonly WindowDef[] = [
  // North wall: runs along x at z=+HOUSE_W, window centered at x=NORTH_WINDOW_X
  { axis: 'x', wallCoord: HOUSE_W, openingCenter: NORTH_WINDOW_X, openingHalfWidth: WIN_HW },
  // East wall: runs along z at x=+HOUSE_W, window centered at z=EAST_WINDOW_Z
  { axis: 'z', wallCoord: HOUSE_W, openingCenter: EAST_WINDOW_Z, openingHalfWidth: WIN_HW },
  // West wall: runs along z at x=-HOUSE_W, window centered at z=WEST_WINDOW_Z
  { axis: 'z', wallCoord: -HOUSE_W, openingCenter: WEST_WINDOW_Z, openingHalfWidth: WIN_HW },
];

export const SOCIAL = {
  hostilityMs: 30_000,
  friendThreshold: 50,
  friendBoost: 50,
} as const;

export const NPC_VOICE = {
  // 15m radius gives players a chance to call out to an NPC across a room
  // instead of having to be face-to-face. Hysteresis prevents flapping at
  // the boundary as the player paces.
  radius: 15,
  hysteresis: 1,
} as const;

export const VAULT = {
  // Max distance from the wall plane to trigger a vault. Tight so the player
  // has to be right at the window — not 1.4m away.
  triggerRange: 0.9,
  // Lateral slack beyond the opening half-width — lets the player be slightly
  // off-center and still vault.
  lateralSlack: 0.3,
  // Min |dot(forward, wallNormal)| required — keeps the player from triggering
  // when glancing past the window.
  facingMin: 0.5,
  // How far past the wall the vault deposits the player.
  exitOffset: 1.2,
  // Vault duration. The client skips the first ~1.0s of the Vault clip
  // (approach-run) and plays the remaining 3.2s at 2.1x speed → ~1.5s real
  // time. Match that here so the position tween ends exactly when the clip
  // does.
  durationMs: 1500,
  // Apex height added to the vault arc. Brings the capsule center up to
  // approx the window opening center (y≈1.5) at midpoint so the visual
  // travels THROUGH the opening rather than the solid wall above/below.
  arcHeight: 0.7,
} as const;

// Free-coffee interactable. One mesh placed in the fps_shooter GLTF; players
// press E / gamepad Y near it to play a pickup→drink animation, gain a small
// heal + sprint buff, and (the point) NPCs notice — Guts has been complaining
// about coffee prices for as long as anyone remembers, so a free maker
// appearing in the arena is narratively load-bearing.
export const COFFEE = {
  // Max distance from the player capsule center to the maker's world position
  // for a drink press to register. Tuned to be comfortable but not so wide it
  // triggers from across the room.
  interactRadius: 1.8,
  // No cooldown: repeated drinks are allowed so NPC behavior around the maker
  // can be tested quickly without waiting between attempts.
  cooldownMs: 0,
  // HP restored per drink, capped at PLAYER.maxHealth.
  healAmount: 25,
  // Sprint speed multiplier while the buff is active. Pushed up so the
  // caffeine kick is genuinely felt — base sprint is 9 m/s, so 1.6× puts
  // the drinker at ~14.4 m/s, fast enough to clearly outrun the NPCs.
  sprintMultiplier: 1.6,
  // How long the sprint buff + "NPCs talk faster" effect persist after a drink.
  buffDurationMs: 120_000,
  // How long the player is movement-locked while the drink animation plays.
  // Must cover the client's ALIGN_MS (400) + PICKUP_HOLD_MS (3500) +
  // DRINK_HOLD_MS (9000) so the animation runs to completion without the
  // player sliding around. Tiny buffer past 12900 so the lock releases
  // just after the visual fully resolves.
  drinkLockMs: 13_000,
  // Bots in this radius (around the drinker, when they drink) hear/see the
  // event and — if they're in an active voice session — get an npc_alert.
  // Wider than NPC_VOICE.radius (15m) on purpose: they don't need to be in
  // talking range to NOTICE someone using the maker.
  observationRadius: 18,
} as const;

// Pose system — voice-driven NPCs and player roleplay can occupy expressive
// body poses (sit, lay, lean against wall, dance) outside the combat loop.
// Transitions (sit_down, stand_up, lay_down) are one-shot clips with timed
// durations; once elapsed the server flips to the steady-state pose.
export const POSE = {
  sitDownMs: 1500,
  layDownMs: 1800,
  standUpMs: 1300,
  // Max poses persisted across a respawn? No — pose clears on death/respawn.
  // Combat overrides: any incoming attack clears pose so the NPC can react.
  // Number of dance variants supported (DanceHipHop, DanceSalsa, DanceSilly).
  danceVariants: 3,
} as const;
