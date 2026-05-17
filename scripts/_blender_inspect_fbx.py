"""Run inside Blender headless. Walks an Animations/ root and dumps per-FBX metadata as JSON.

Invoked by scripts/animation-catalogue.mjs:
  blender --background --python _blender_inspect_fbx.py -- <animations_root> <output_json>
"""
import json
import os
import sys

import bpy

ROOT_MOTION_TOLERANCE_M = 0.05


def find_fbx_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".fbx"):
                out.append(os.path.join(dirpath, name))
    out.sort()
    return out


def inspect_one(fbx_path: str, animations_root: str) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.import_scene.fbx(filepath=fbx_path)
    except Exception as exc:  # noqa: BLE001
        return {
            "path": os.path.relpath(fbx_path, animations_root),
            "filename": os.path.basename(fbx_path),
            "error": f"import failed: {exc}",
        }

    action = bpy.data.actions[0] if bpy.data.actions else None
    frames = 0
    if action is not None:
        fr = action.frame_range
        frames = int(round(fr[1] - fr[0]))

    armatures = list(bpy.data.armatures)
    bones = len(armatures[0].bones) if armatures else 0

    has_mesh = any(o.type == "MESH" for o in bpy.data.objects)

    has_root_motion = False
    if action is not None:
        arm_obj = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
        hips = None
        if arm_obj is not None:
            for name in ("mixamorig:Hips", "Hips", "mixamorig9:Hips"):
                if name in arm_obj.pose.bones:
                    hips = arm_obj.pose.bones[name]
                    break
        if hips is not None:
            scene = bpy.context.scene
            f0 = int(action.frame_range[0])
            f1 = int(action.frame_range[1])
            samples = []
            step = max(1, (f1 - f0) // 8)
            for f in range(f0, f1 + 1, step):
                scene.frame_set(f)
                samples.append((hips.location.x, hips.location.y, hips.location.z))
            if samples:
                xs = [s[0] for s in samples]
                ys = [s[1] for s in samples]
                zs = [s[2] for s in samples]
                span = max(
                    max(xs) - min(xs),
                    max(ys) - min(ys),
                    max(zs) - min(zs),
                )
                has_root_motion = span > ROOT_MOTION_TOLERANCE_M

    rel_path = os.path.relpath(fbx_path, animations_root)
    pack = os.path.dirname(rel_path)

    return {
        "path": rel_path,
        "filename": os.path.basename(fbx_path),
        "pack": pack,
        "frames": frames,
        "fps": int(bpy.context.scene.render.fps),
        "bones": bones,
        "hasRootMotion": has_root_motion,
        "characterSkin": has_mesh,
    }


def main() -> None:
    argv = sys.argv
    if "--" not in argv:
        print("usage: blender --background --python _blender_inspect_fbx.py -- <animations_root> <output_json>")
        sys.exit(2)
    args = argv[argv.index("--") + 1 :]
    if len(args) != 2:
        print("expected 2 args: <animations_root> <output_json>")
        sys.exit(2)
    animations_root, output_json = args
    animations_root = os.path.abspath(animations_root)

    fbx_files = find_fbx_files(animations_root)
    print(f"[catalogue] {len(fbx_files)} FBX files under {animations_root}")

    results = []
    for i, path in enumerate(fbx_files, start=1):
        rel = os.path.relpath(path, animations_root)
        print(f"[catalogue] ({i}/{len(fbx_files)}) {rel}")
        results.append(inspect_one(path, animations_root))

    os.makedirs(os.path.dirname(output_json), exist_ok=True)
    with open(output_json, "w") as f:
        json.dump({"entries": results}, f, indent=2)
    print(f"[catalogue] wrote {output_json}")


main()
