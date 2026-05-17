import type * as Party from 'partykit/server';
import type { TranscriptLine } from '@slipstream-npc/shared';

export interface ConsentRecord {
  version: string;
  agreedAt: number;
}

export interface FriendshipRecord {
  score: number;
  becameFriendAt?: number;
}

// A single durable change to an NPC's self-knowledge. These layer ON TOP of
// the baked persona (the agent's system prompt) — the agent reads them at
// every session start via buildMemoryBlob, treats them as authoritative when
// they conflict with the persona, and integrates them in-character. Used for
// in-fiction changes the persona can't anticipate ("your shoulder pain is
// gone now", "Halsey is alive and back", etc.).
export interface NpcStateEntry {
  at: number;
  summary: string;
  evidence?: string;
  source: string;
}

const TRANSCRIPT_CAP = 200;
const NPC_STATE_CAP = 50;

const consentKey = (playerName: string): string => `consent:${playerName}`;
const friendshipKey = (npcId: string, playerName: string): string => `friend:${npcId}:${playerName}`;
const transcriptKey = (npcId: string, playerName: string): string => `tx:${npcId}:${playerName}`;
const lastSessionKey = (npcId: string, playerName: string): string => `last:${npcId}:${playerName}`;
const npcStateKey = (npcId: string): string => `state:${npcId}`;
const COFFEE_DISCOVERED_KEY = 'coffee:discovered';
// Game-change seeding: `seeded:<changeId>` records whether a static GameChange
// from packages/shared/src/game-changes.ts has been written into this room's
// NPC state. One-shot per room. The seeder runs on onStart and is idempotent.
const gameChangeSeededKey = (id: string): string => `seeded:${id}`;

// Write-back cache over PartyKit room.storage (Cloudflare Durable Object).
// Hot-path reads stay in-memory; writes update the cache and queue an async
// put. Storage misses fall through to a single read which then populates the
// cache. Maps survive across re-entry of onMessage handlers since the class
// instance lives for the room's lifetime.
export class GameStorage {
  private consents = new Map<string, ConsentRecord>();
  private friendships = new Map<string, FriendshipRecord>();
  private transcripts = new Map<string, TranscriptLine[]>();
  private lastSessionEnds = new Map<string, number>();
  private npcStates = new Map<string, NpcStateEntry[]>();
  private consentLoaded = new Set<string>();
  private friendshipLoaded = new Set<string>();
  private transcriptLoaded = new Set<string>();
  private lastSessionLoaded = new Set<string>();
  private npcStateLoaded = new Set<string>();
  private coffeeDiscovered: boolean | null = null;

  constructor(private storage: Party.Storage) {}

  async getConsent(playerName: string): Promise<ConsentRecord | null> {
    if (this.consentLoaded.has(playerName)) {
      return this.consents.get(playerName) ?? null;
    }
    const stored = (await this.storage.get<ConsentRecord>(consentKey(playerName))) ?? null;
    this.consentLoaded.add(playerName);
    if (stored) this.consents.set(playerName, stored);
    return stored;
  }

  async setConsent(playerName: string, record: ConsentRecord): Promise<void> {
    this.consents.set(playerName, record);
    this.consentLoaded.add(playerName);
    await this.storage.put(consentKey(playerName), record);
  }

  async getFriendship(npcId: string, playerName: string): Promise<FriendshipRecord> {
    const k = friendshipKey(npcId, playerName);
    if (this.friendshipLoaded.has(k)) {
      return this.friendships.get(k) ?? { score: 0 };
    }
    const stored = (await this.storage.get<FriendshipRecord>(k)) ?? { score: 0 };
    this.friendshipLoaded.add(k);
    this.friendships.set(k, stored);
    return stored;
  }

  async setFriendship(npcId: string, playerName: string, record: FriendshipRecord): Promise<void> {
    const k = friendshipKey(npcId, playerName);
    this.friendships.set(k, record);
    this.friendshipLoaded.add(k);
    await this.storage.put(k, record);
  }

  async addFriendshipScore(
    npcId: string,
    playerName: string,
    delta: number,
    threshold: number,
  ): Promise<{ score: number; becameFriend: boolean }> {
    const current = await this.getFriendship(npcId, playerName);
    const wasFriend = current.score >= threshold;
    const nextScore = Math.max(0, Math.min(100, current.score + delta));
    const isFriend = nextScore >= threshold;
    const next: FriendshipRecord = {
      score: nextScore,
      ...(isFriend && !current.becameFriendAt ? { becameFriendAt: Date.now() } : {}),
    };
    if (current.becameFriendAt && !next.becameFriendAt) next.becameFriendAt = current.becameFriendAt;
    await this.setFriendship(npcId, playerName, next);
    return { score: nextScore, becameFriend: !wasFriend && isFriend };
  }

  async getTranscript(npcId: string, playerName: string): Promise<TranscriptLine[]> {
    const k = transcriptKey(npcId, playerName);
    if (this.transcriptLoaded.has(k)) {
      return this.transcripts.get(k) ?? [];
    }
    const stored = (await this.storage.get<TranscriptLine[]>(k)) ?? [];
    this.transcriptLoaded.add(k);
    this.transcripts.set(k, stored);
    return stored;
  }

  async appendTranscript(
    npcId: string,
    playerName: string,
    line: TranscriptLine,
  ): Promise<void> {
    const k = transcriptKey(npcId, playerName);
    const list = await this.getTranscript(npcId, playerName);
    list.push(line);
    while (list.length > TRANSCRIPT_CAP) list.shift();
    this.transcripts.set(k, list);
    await this.storage.put(k, list);
  }

  // Wall-clock ms at which the most recent voice session between this NPC
  // and this player ended. Used to compute elapsed-since-last for the
  // greeting-recency bucket (B2 sense-of-time).
  async getLastSessionEnd(npcId: string, playerName: string): Promise<number | null> {
    const k = lastSessionKey(npcId, playerName);
    if (this.lastSessionLoaded.has(k)) return this.lastSessionEnds.get(k) ?? null;
    const stored = (await this.storage.get<number>(k)) ?? null;
    this.lastSessionLoaded.add(k);
    if (stored !== null) this.lastSessionEnds.set(k, stored);
    return stored;
  }

  async setLastSessionEnd(npcId: string, playerName: string, at: number): Promise<void> {
    const k = lastSessionKey(npcId, playerName);
    this.lastSessionEnds.set(k, at);
    this.lastSessionLoaded.add(k);
    await this.storage.put(k, at);
  }

  // Persona-delta entries that override/supplement the baked persona. The
  // agent reads these at every session start; they're authoritative when
  // they conflict with the persona text. Capped at NPC_STATE_CAP entries
  // (oldest discarded) to keep memoryBlob size bounded.
  async getNpcState(npcId: string): Promise<NpcStateEntry[]> {
    const k = npcStateKey(npcId);
    if (this.npcStateLoaded.has(k)) return this.npcStates.get(k) ?? [];
    const stored = (await this.storage.get<NpcStateEntry[]>(k)) ?? [];
    this.npcStateLoaded.add(k);
    this.npcStates.set(k, stored);
    return stored;
  }

  async appendNpcState(npcId: string, entry: NpcStateEntry): Promise<void> {
    const k = npcStateKey(npcId);
    const list = await this.getNpcState(npcId);
    list.push(entry);
    while (list.length > NPC_STATE_CAP) list.shift();
    this.npcStates.set(k, list);
    await this.storage.put(k, list);
  }

  async clearNpcState(npcId: string): Promise<void> {
    const k = npcStateKey(npcId);
    this.npcStates.set(k, []);
    this.npcStateLoaded.add(k);
    await this.storage.put(k, []);
  }

  // Has this static GameChange already been seeded into this room? Dedup
  // for the onStart seeder so each change applies exactly once per room.
  async isGameChangeSeeded(id: string): Promise<boolean> {
    return (await this.storage.get<boolean>(gameChangeSeededKey(id))) === true;
  }

  async markGameChangeSeeded(id: string): Promise<void> {
    await this.storage.put(gameChangeSeededKey(id), true);
  }

  // Has any player ever successfully drunk from the coffee maker in this
  // room? Once true, the first-drink persona-delta cascade is suppressed —
  // the discovery has already been written into every NPC's state. Cached
  // in-memory since the check fires on every drink press (cheap but worth
  // skipping the storage round-trip).
  async getCoffeeDiscovered(): Promise<boolean> {
    if (this.coffeeDiscovered !== null) return this.coffeeDiscovered;
    const stored = (await this.storage.get<boolean>(COFFEE_DISCOVERED_KEY)) ?? false;
    this.coffeeDiscovered = stored;
    return stored;
  }

  async setCoffeeDiscovered(): Promise<void> {
    this.coffeeDiscovered = true;
    await this.storage.put(COFFEE_DISCOVERED_KEY, true);
  }

  async listRecentForNpc(
    npcId: string,
    excludePlayer: string,
    sinceMs: number,
  ): Promise<{ playerName: string; line: TranscriptLine }[]> {
    const prefix = `tx:${npcId}:`;
    // Hot path: prefer cached entries since we may already have them in memory
    // from prior session starts. listRecent is called once per session start
    // and isn't latency-critical, but avoiding a storage scan when the answer
    // is already in cache keeps it cheap.
    const cachedKeys = new Set<string>();
    const out: { playerName: string; line: TranscriptLine }[] = [];
    const fold = (key: string, lines: TranscriptLine[]) => {
      const playerName = key.slice(prefix.length);
      if (playerName === excludePlayer) return;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!;
        if (l.at < sinceMs) break;
        out.push({ playerName, line: l });
      }
    };
    for (const [k, v] of this.transcripts) {
      if (!k.startsWith(prefix)) continue;
      cachedKeys.add(k);
      fold(k, v);
    }
    // Fall through to storage scan to catch transcripts we haven't loaded yet
    // this session. Cheap when there are few transcripts; only runs at session
    // start so the per-tick budget is unaffected.
    const stored = await this.storage.list<TranscriptLine[]>({ prefix });
    for (const [k, v] of stored) {
      if (cachedKeys.has(k)) continue;
      this.transcripts.set(k, v);
      this.transcriptLoaded.add(k);
      fold(k, v);
    }
    return out;
  }
}
