#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANIMATIONS_DIR = path.join(ROOT, 'Animations');
const OUTPUT_JSON = path.join(ANIMATIONS_DIR, 'catalogue.json');
const PY_SCRIPT = path.join(ROOT, 'scripts', '_blender_inspect_fbx.py');
const MAP_JSON = path.join(ROOT, 'scripts', 'canonical-clip-map.json');
const BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';

if (!fs.existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}`);
  process.exit(1);
}
if (!fs.existsSync(ANIMATIONS_DIR)) {
  console.error(`Animations/ not found at ${ANIMATIONS_DIR}`);
  process.exit(1);
}

const child = spawn(
  BLENDER,
  ['--background', '--python', PY_SCRIPT, '--', ANIMATIONS_DIR, OUTPUT_JSON],
  { stdio: 'inherit' },
);

child.on('exit', (code) => {
  if (code !== 0) {
    console.error(`Blender exited with code ${code}`);
    process.exit(code ?? 1);
  }

  if (!fs.existsSync(OUTPUT_JSON)) {
    console.error(`Blender finished but ${OUTPUT_JSON} is missing`);
    process.exit(1);
  }

  const map = fs.existsSync(MAP_JSON)
    ? JSON.parse(fs.readFileSync(MAP_JSON, 'utf8'))
    : {};

  const data = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf8'));
  data.entries = data.entries.map((e) => ({
    ...e,
    canonicalName: map[e.path] ?? null,
  }));
  data.generatedAt = new Date().toISOString();

  data.entries.sort((a, b) => a.path.localeCompare(b.path));

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(data, null, 2));

  const total = data.entries.length;
  const errored = data.entries.filter((e) => e.error).length;
  const skins = data.entries.filter((e) => e.characterSkin).length;
  const mapped = data.entries.filter((e) => e.canonicalName).length;
  console.log(
    `\n[catalogue] ${total} entries · ${skins} character skins · ${mapped} mapped · ${errored} errors`,
  );
  console.log(`[catalogue] wrote ${path.relative(ROOT, OUTPUT_JSON)}`);
});
