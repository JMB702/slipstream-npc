# Mixamo shopping list — social animation batch

Runbook for downloading social/expressive animations from Mixamo and placing them where the catalogue + bake pipeline expect them.

## Prerequisites

- Logged into Mixamo as `Jeff`.
- Chrome browser attached to the Claude Code session via the Claude in Chrome extension (or do it manually).
- Empty `Animations/Social/` directory.

## Modal settings cheat sheet

For every download, Mixamo opens a `Download Settings` modal. Use these settings per clip type:

| Clip type | Format | FPS | Keyframe Reduction | In Place | Skin |
| --- | --- | --- | --- | --- | --- |
| Walks (forward motion intended) | FBX Binary | 30 | none | **off** | Without Skin |
| Stand / lean / sit / lay / dance (no traversal) | FBX Binary | 30 | none | **on** | Without Skin |
| Dances that drift (e.g. Samba) | FBX Binary | 30 | none | **on** | Without Skin |

"Without Skin" keeps file size small. We don't need the X Bot mesh; the bake pipeline reuses each character's existing skin.

## Today's batch

Search Mixamo by clip name. If multiple match, pick the one that reads "civilian, relaxed" (no rifle, no combat stance). Save into `Animations/Social/` keeping Mixamo's filename.

| Mixamo clip name | Saved filename | Canonical name | In Place? |
| --- | --- | --- | --- |
| Standing Idle | `Standing Idle.fbx` | `CasualIdle` | on |
| Walking | `Walking.fbx` | `CasualWalkF` | off |
| Standing 2H Magic Area Attack 02 → no — search "Leaning" | `Leaning Against Wall.fbx` | `LeanWall` | on |
| Sitting Down | `Sitting Down.fbx` | `SitDown` | on |
| Sitting Idle | `Sitting Idle.fbx` | `SitIdle` | on |
| Standing Up | `Standing Up.fbx` | `StandUp` | on |
| Laying Down | `Laying Down.fbx` | `LayDown` | on |
| Idle (Laying) | `Laying Idle.fbx` | `LayIdle` | on |
| Hip Hop Dancing | `Hip Hop Dancing.fbx` | `DanceHipHop` | on |
| Salsa Dancing | `Salsa Dancing.fbx` | `DanceSalsa` | on |
| Silly Dancing | `Silly Dancing.fbx` | `DanceSilly` | on |

## After download

1. Move files from `~/Downloads/` into `Animations/Social/`.
2. Run `pnpm catalogue` to refresh `Animations/catalogue.json`.
3. Edit `scripts/canonical-clip-map.json` and add `"Social/<filename>": "<CanonicalName>"` entries for the new clips.
4. Re-run `pnpm catalogue` to populate `canonicalName` fields.
5. Run `pnpm bake:characters` to produce updated `*.baked.glb` for Soldier, Maria, Ch15, Ch35.
6. Inspect the baked files — if action lists look right, swap them in:
   ```sh
   for c in Soldier Maria Ch15 Ch35; do
     mv "apps/client/public/models/$c.baked.glb" "apps/client/public/models/$c.glb"
   done
   ```

## Where Mixamo descriptions live

The descriptive paragraphs on a clip's Mixamo page (e.g. "a tactical walk with rifle held at the ready") are server-side only. They are NOT in the downloaded FBX. The only way to catalogue descriptions would be to scrape each clip's page while logged in — defer until we actually need it.

## Adding future batches

This same flow extends to whatever batch comes next (cover system, melee, grenades, etc.). Drop new FBXs into a sub-folder of `Animations/`, add map entries, re-catalogue, re-bake.
