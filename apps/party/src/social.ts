import { SOCIAL } from '@slipstream-npc/shared';
import type { ServerPlayer } from './state.js';

const setHostility = (player: ServerPlayer, towardsName: string, until: number): void => {
  if (!towardsName || towardsName === player.name) return;
  const existing = player.hostility.find((h) => h.towardsName === towardsName);
  if (existing) {
    if (until > existing.until) existing.until = until;
    return;
  }
  player.hostility.push({ towardsName, until });
};

export const markAttack = (
  attackerName: string,
  victim: ServerPlayer,
  allPlayers: Iterable<ServerPlayer>,
  now: number,
  onFriendCascade?: (friend: ServerPlayer) => void,
): void => {
  const until = now + SOCIAL.hostilityMs;
  setHostility(victim, attackerName, until);
  if (victim.friendsWith.length === 0) return;
  for (const p of allPlayers) {
    if (p.id === victim.id) continue;
    if (victim.friendsWith.includes(p.name)) {
      setHostility(p, attackerName, until);
      onFriendCascade?.(p);
    }
  }
};

// Clear hostility entries this player holds toward a named target. Used by
// the de-escalate path (stop_attacking webhook tool) — the agent decides
// it's been convinced to spare someone.
export const clearHostility = (player: ServerPlayer, towardsName: string): boolean => {
  const before = player.hostility.length;
  player.hostility = player.hostility.filter((h) => h.towardsName !== towardsName);
  return player.hostility.length < before;
};

// Conversationally-induced hostility — the agent has been convinced to
// attack someone the player named. No friend cascade (unlike markAttack):
// defensive cascading is instinctual, but aggression is a personal choice
// each NPC has to be convinced of separately.
export const adoptHostility = (player: ServerPlayer, towardsName: string, now: number): void => {
  setHostility(player, towardsName, now + SOCIAL.hostilityMs);
};

export const isHostileTo = (player: ServerPlayer, otherName: string, now: number): boolean =>
  player.hostility.some((h) => h.towardsName === otherName && h.until > now);

// Returns the names of hostility entries that just expired. The server uses
// this to push `hostility_ended` alerts to any NPC mid-session — so the
// agent stops acting angry the moment its 30-second timer runs out instead
// of waiting for some other event to remind it.
export const pruneHostility = (player: ServerPlayer, now: number): string[] => {
  if (player.hostility.length === 0) return [];
  const expired: string[] = [];
  const kept: typeof player.hostility = [];
  for (const h of player.hostility) {
    if (h.until > now) kept.push(h);
    else expired.push(h.towardsName);
  }
  if (expired.length === 0) return [];
  player.hostility = kept;
  return expired;
};
