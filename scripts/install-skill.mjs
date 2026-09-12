#!/usr/bin/env node
/**
 * Copy the skill in `skills/` into a directory an agent reads.
 *
 * The skill is written once, under `skills/`, and installed wherever it needs
 * to be read from: `.claude/skills/` in this repository, the same path in
 * another project, or `~/.claude/skills` for every project at once. Copies
 * rather than symlinks, because an installed skill should survive the
 * repository moving or going away.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'skills');
const destination = path.resolve(process.argv[2] || path.join(repoRoot, '.claude/skills'));

const skills = await readdir(source);
await mkdir(destination, { recursive: true });
for (const skill of skills) {
  const target = path.join(destination, skill);
  await cp(path.join(source, skill), target, { recursive: true });
  console.log(`installed ${skill} -> ${target}`);
}
