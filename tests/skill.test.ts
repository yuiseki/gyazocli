import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers';

const SOURCE = path.join(REPO_ROOT, 'skills');
const INSTALLED = path.join(REPO_ROOT, '.claude/skills');

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      found.push(path.relative(root, path.join(entry.parentPath ?? root, entry.name)));
    }
  }
  return found.sort();
}

/**
 * The skill lives once under skills/ and is installed into .claude/skills/ so
 * that an agent working in this repository reads it. Two copies drift, so the
 * build says when they have.
 */
test('the installed skill matches the one in skills/', () => {
  const source = filesUnder(SOURCE);
  expect(source.length).toBeGreaterThan(0);
  expect(filesUnder(INSTALLED)).toEqual(source);

  for (const file of source) {
    expect(
      fs.readFileSync(path.join(INSTALLED, file), 'utf8'),
      `${file} differs; run \`npm run skill:install\``,
    ).toBe(fs.readFileSync(path.join(SOURCE, file), 'utf8'));
  }
});

test('every skill declares a name and a description', () => {
  for (const skill of fs.readdirSync(SOURCE)) {
    const text = fs.readFileSync(path.join(SOURCE, skill, 'SKILL.md'), 'utf8');
    const frontmatter = text.split('---')[1] ?? '';
    expect(frontmatter, `${skill} has no frontmatter`).toMatch(/\nname: /);
    expect(frontmatter, `${skill} has no description`).toMatch(/\ndescription: /);
    // The description is the whole trigger: it is all an agent sees until the
    // skill fires.
    const description = frontmatter.match(/\ndescription: (.*)/)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(80);
  }
});
