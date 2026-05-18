export type PlayerId = string;

export type Vec3 = readonly [number, number, number];

export type CharacterId = 'soldier' | 'ch15' | 'ch35' | 'eve' | 'maria' | 'medea' | 'dreyar' | 'rob';

// Steady-state pose. null = default combat-ready stance (the existing locomotion +
// rifle aim state machine runs unaffected). Anything else makes the client play
// that pose's looping clip instead of locomotion.
//   fight_idle — Rob-only stance (characterId === 'rob' gate enforced server-side
//   on both the /tools/set_pose webhook and the human-player debug key path).
//   Auto-clears back to casual_idle after POSE.fightIdleMs so it doesn't lock
//   the patrol bot in place.
export type Pose = 'casual_idle' | 'lean_wall' | 'sit' | 'lay' | 'dance' | 'fight_idle' | null;

// One-shot transition between poses. While non-null the client plays the
// matching transition clip; the server flips it back to null after the
// matching POSE.*Ms duration and updates `pose` to the destination.
export type PoseTransition = 'sit_down' | 'lay_down' | 'stand_up' | null;

export interface PlayerState {
  id: PlayerId;
  name: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnAt: number | null;
  ammo: number;
  reloading: boolean;
  reloadDoneAt: number | null;
  vaulting: boolean;
  // Casual-mode smoking emote. True while the Smoke clip should play on the
  // client. Server only sets it for players with pose === 'casual_idle';
  // movement / fire / reload / jump / pose-change cancel it.
  smoking: boolean;
  kills: number;
  deaths: number;
  lastSeenSeq: number;
  isBot: boolean;
  characterId: CharacterId;
  npcId?: string;
  friendsWith: string[];
  pose: Pose;
  poseTransition: PoseTransition;
  // Index into the Dance* clip variants when pose === 'dance'. Modulo'd by
  // POSE.danceVariants on the client so a renamed pack still resolves.
  danceVariant: number;
  // Wall-clock (Date.now) at which the coffee buff expires. While set in the
  // future, the player sprints faster and any NPC voice session they start
  // is told to talk faster. Stored on the wire so client prediction agrees
  // with server-authoritative speed.
  coffeeBuffUntil?: number;
  // Wall-clock (Date.now) at which the coffee-drink movement lock expires.
  // While set in the future, applyMovement zeroes the player's velocity
  // and applyInput ignores forward/right/jump/sprint — locks the body in
  // place so the pickup→drink animation plays cleanly without sliding.
  // Stored on the wire so client prediction matches authoritative state.
  drinkingUntil?: number;
  // Voice state — mirrored on the wire so every client knows who's speaking
  // for the HUD speaker panel, nameplate badges, and (server-side) the
  // turn-taking state machine that picks which NPC responds. Bots: always
  // false. Filled from each client's VAD + manual mute key; PartyKit just
  // relays the latest value into snapshots.
  voiceSpeaking?: boolean;
  voiceMutedByVad?: boolean;
  voiceMutedManual?: boolean;
}

export interface HostilityEntry {
  towardsName: string;
  until: number;
}

export interface GameSnapshot {
  serverTime: number;
  tick: number;
  players: PlayerState[];
  killTarget: number;
  // When set, the room is in the post-victory freeze before auto-reset.
  // Client uses this to render the victory overlay.
  winnerId: PlayerId | null;
}

export interface KillEvent {
  type: 'kill';
  killerId: PlayerId | null;
  victimId: PlayerId;
  at: number;
}

export interface ShotEvent {
  type: 'shot';
  shooterId: PlayerId;
  origin: Vec3;
  direction: Vec3;
  hit: PlayerId | null;
  at: number;
}

export interface ChatEvent {
  type: 'chat';
  fromId: PlayerId;
  fromName: string;
  text: string;
  at: number;
}

export interface GameOverEvent {
  type: 'gameover';
  winnerId: PlayerId;
  winnerName: string;
  killTarget: number;
  at: number;
}

export interface DrinkEvent {
  type: 'drink';
  playerId: PlayerId;
  at: number;
}

export type GameEvent = KillEvent | ShotEvent | ChatEvent | GameOverEvent | DrinkEvent;
