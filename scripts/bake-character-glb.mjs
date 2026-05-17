#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANIMATIONS_DIR = path.join(ROOT, 'Animations');
const CATALOGUE = path.join(ANIMATIONS_DIR, 'catalogue.json');
const MAP_JSON = path.join(ROOT, 'scripts', 'canonical-clip-map.json');
const PY_SCRIPT = path.join(ROOT, 'scripts', '_blender_bake.py');
const BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
const PUBLIC_MODELS = path.join(ROOT, 'apps/client/public/models');

// Characters to bake. Eve and Medea deliberately excluded — known broken (CLAUDE.md).
// Source is the existing GLB so we get the right per-character skin/mesh.
const CHARACTERS = [
  { name: 'Soldier', source: path.join(PUBLIC_MODELS, 'Soldier.glb') },
  { name: 'Maria', source: path.join(PUBLIC_MODELS, 'Maria.glb') },
  { name: 'Ch15', source: path.join(PUBLIC_MODELS, 'Ch15.glb') },
  { name: 'Ch35', source: path.join(PUBLIC_MODELS, 'Ch35.glb') },
  // Source is the raw FBX — the bake script handles both glb and fbx via
  // _blender_bake.py:import_character. Output is Dreyar.baked.glb; rename
  // to Dreyar.glb after baking. Used by NPC `guts` per npc-roster.ts.
  { name: 'Dreyar', source: path.join(ROOT, '3D Assets/Characters/Guts - Dreyar By M.Aure.fbx') },
];

// Clips that need root-motion stripped at bake time (locomotion). Matches the
// stripRootMotion() set used at runtime in Character.tsx for the same clips.
const STRIP_ROOT_MOTION_FOR = [
  'WalkF', 'WalkFR', 'WalkR', 'WalkBR', 'WalkB', 'WalkBL', 'WalkL', 'WalkFL',
  'RunF', 'RunFR', 'RunR', 'RunBR', 'RunB', 'RunBL', 'RunL', 'RunFL',
  'FireWalk', 'ReloadWalk', 'ReloadRun',
  'CasualWalkF', 'CasualRunF',
];

function bakeOne(character) {
  const out = path.join(PUBLIC_MODELS, `${character.name}.baked.glb`);
  const cfg = {
    character: character.source,
    catalogue: CATALOGUE,
    map: MAP_JSON,
    animationsRoot: ANIMATIONS_DIR,
    output: out,
    stripRootMotionFor: STRIP_ROOT_MOTION_FOR,
  };
  const cfgPath = path.join(os.tmpdir(), `bake-${character.name}-${Date.now()}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  return new Promise((resolve, reject) => {
    const child = spawn(BLENDER, ['--background', '--python', PY_SCRIPT, '--', cfgPath], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      fs.unlinkSync(cfgPath);
      if (code !== 0) reject(new Error(`bake failed for ${character.name} (exit ${code})`));
      else resolve(out);
    });
  });
}

async function main() {
  if (!fs.existsSync(BLENDER)) {
    console.error(`Blender not found at ${BLENDER}`);
    process.exit(1);
  }
  if (!fs.existsSync(CATALOGUE)) {
    console.error(`Catalogue missing — run \`pnpm catalogue\` first.`);
    process.exit(1);
  }

  const filterArg = process.argv[2];
  const targets = filterArg
    ? CHARACTERS.filter((c) => c.name.toLowerCase() === filterArg.toLowerCase())
    : CHARACTERS;

  if (targets.length === 0) {
    console.error(`No character named ${filterArg}. Available: ${CHARACTERS.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }

  for (const c of targets) {
    if (!fs.existsSync(c.source)) {
      console.error(`Source missing for ${c.name}: ${c.source}`);
      continue;
    }
    console.log(`\n=== Baking ${c.name} ===`);
    const out = await bakeOne(c);
    const stat = fs.statSync(out);
    console.log(`✓ ${path.relative(ROOT, out)}  (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log(
    `\nBaked outputs use *.baked.glb suffix. To swap them in:\n  for c in ${targets.map((c) => c.name).join(' ')}; do mv apps/client/public/models/$c.baked.glb apps/client/public/models/$c.glb; done`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
