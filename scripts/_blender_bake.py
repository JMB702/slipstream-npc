"""Bake a character GLB by merging a base character skin/skeleton with named animation actions.

Invoked by scripts/bake-character-glb.mjs:
  blender --background --python _blender_bake.py -- <config_json>

Config JSON shape:
  {
    "character": "/abs/path/to/character.glb|fbx",
    "catalogue": "/abs/path/to/Animations/catalogue.json",
    "map": "/abs/path/to/canonical-clip-map.json",
    "animationsRoot": "/abs/path/to/Animations",
    "output": "/abs/path/to/output.glb",
    "stripRootMotionFor": ["WalkF", "RunF", ...]  // canonical names to pre-strip
  }
"""
import json
import os
import sys

import bpy


def log(msg: str) -> None:
    print(f"[bake] {msg}", flush=True)


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_character(path: str) -> None:
    ext = path.lower().rsplit(".", 1)[-1]
    if ext == "glb" or ext == "gltf":
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == "fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise SystemExit(f"unsupported character format: {path}")


def find_character_armature():
    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not armatures:
        raise SystemExit("no armature found in character source")
    # Pick the armature with the most bones — drops any stray empties
    armatures.sort(key=lambda a: len(a.data.bones), reverse=True)
    return armatures[0]


def strip_root_motion(action) -> int:
    """Remove Hips location fcurves so the action plays in place. Returns count removed."""
    removed = 0
    for layer in action.layers:
        for strip in layer.strips:
            for slot in action.slots:
                bag = strip.channelbag(slot, ensure=False)
                if bag is None:
                    continue
                to_remove = []
                for fc in bag.fcurves:
                    dp = fc.data_path
                    if dp.endswith(".location") and "Hips" in dp:
                        to_remove.append(fc)
                for fc in to_remove:
                    bag.fcurves.remove(fc)
                    removed += 1
    return removed


def remove_objects(objects) -> None:
    for obj in list(objects):
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def import_action(fbx_path: str, canonical_name: str, strip_motion: bool) -> bool:
    pre_objects = set(bpy.data.objects)
    pre_actions = set(bpy.data.actions)
    try:
        bpy.ops.import_scene.fbx(filepath=fbx_path)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! import failed for {fbx_path}: {exc}")
        return False

    new_objects = [o for o in bpy.data.objects if o not in pre_objects]
    new_actions = [a for a in bpy.data.actions if a not in pre_actions]

    if not new_actions:
        log(f"  ! no action found in {os.path.basename(fbx_path)}")
        remove_objects(new_objects)
        return False

    action = new_actions[0]

    # Replace any existing action with the canonical name (idempotent re-bake)
    existing = bpy.data.actions.get(canonical_name)
    if existing is not None and existing != action:
        bpy.data.actions.remove(existing)

    action.name = canonical_name
    action.use_fake_user = True  # prevent purge when we drop the imported armature

    if strip_motion:
        removed = strip_root_motion(action)
        if removed:
            log(f"  - stripped {removed} root-motion fcurves")

    remove_objects(new_objects)
    return True


def push_actions_to_armature(armature_obj) -> None:
    """Push every floating action onto the character armature via NLA tracks so the GLB exporter sees them."""
    if armature_obj.animation_data is None:
        armature_obj.animation_data_create()
    ad = armature_obj.animation_data

    # Clear existing NLA tracks to avoid stale references
    while ad.nla_tracks:
        ad.nla_tracks.remove(ad.nla_tracks[0])

    for action in bpy.data.actions:
        if not action.use_fake_user:
            continue
        track = ad.nla_tracks.new()
        track.name = action.name
        # Strip start frame = 1
        start = int(action.frame_range[0])
        track.strips.new(name=action.name, start=1, action=action)


def export_glb(output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_nla_strips=True,
        export_apply=False,
        export_yup=True,
    )


def main() -> None:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: blender --background --python _blender_bake.py -- <config_json>")
    args = argv[argv.index("--") + 1 :]
    if len(args) != 1:
        raise SystemExit("expected 1 arg: <config_json>")

    cfg_path = args[0]
    with open(cfg_path) as f:
        cfg = json.load(f)

    character = cfg["character"]
    catalogue_path = cfg["catalogue"]
    map_path = cfg["map"]
    animations_root = cfg["animationsRoot"]
    output = cfg["output"]
    strip_set = set(cfg.get("stripRootMotionFor", []))

    log(f"character: {character}")
    log(f"output:    {output}")

    reset()
    import_character(character)
    char_armature = find_character_armature()
    log(f"character armature: {char_armature.name} bones={len(char_armature.data.bones)}")

    # Drop the character's bind-pose action(s) — they'll be replaced by mapped actions
    # but keep them for now to allow same-name replacement
    starting_actions = {a.name for a in bpy.data.actions}
    log(f"starting actions in character: {sorted(starting_actions)}")

    with open(catalogue_path) as f:
        catalogue = json.load(f)
    with open(map_path) as f:
        clip_map = json.load(f)

    imported_count = 0
    skipped_skin = 0
    for entry in catalogue["entries"]:
        if entry.get("error"):
            continue
        rel_path = entry["path"]
        canonical = clip_map.get(rel_path)
        if canonical is None:
            continue
        if entry.get("characterSkin") and "X Bot.fbx" in entry["filename"]:
            skipped_skin += 1
            continue

        abs_path = os.path.join(animations_root, rel_path)
        strip = canonical in strip_set
        log(f"  + {canonical} <- {rel_path}{' (strip)' if strip else ''}")
        if import_action(abs_path, canonical, strip):
            imported_count += 1

    log(f"imported {imported_count} actions, skipped {skipped_skin} X Bot skins")

    # Drop any actions that aren't fake-user (e.g. the character's stray bind-pose)
    for a in list(bpy.data.actions):
        if not a.use_fake_user:
            log(f"  - dropping stray action {a.name}")
            bpy.data.actions.remove(a)

    push_actions_to_armature(char_armature)

    export_glb(output)
    log(f"exported {output}")


main()
