/**
 * The `import` command, which adopts a cache built elsewhere.
 */
import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import {
  getCacheDir,
  saveHourlyCache,
} from '../storage';

export function registerImportCommand(program: Command): void {
  program
    .command('import <type> <dir>')
    .description('Import legacy data (type: json|hourly)')
    .action(async (type, dir) => {
      const sourceDir = path.resolve(dir);
      if (!fs.existsSync(sourceDir)) {
        console.error(`Error: Source directory ${sourceDir} does not exist.`);
        process.exit(1);
      }

      if (type === 'json') {
        const targetDir = path.join(getCacheDir(), 'images');
        console.log(`Importing legacy Gyazo JSON from ${sourceDir}...`);
        let total = 0;
        const walk = (d: string) => {
          fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.json')) {
              const id = e.name.replace('.json', '');
              const p1 = id[0] || '_', p2 = id[1] || '_';
              const dest = path.join(targetDir, p1, p2);
              if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
              fs.copyFileSync(p, path.join(dest, e.name));
              total++;
              if (total % 100 === 0) process.stdout.write('.');
            }
          });
        };
        walk(sourceDir);
        console.log(`\nImport complete. Copied ${total} files.`);
      } else if (type === 'hourly') {
        console.log(`Importing legacy Gyazo hourly data from ${sourceDir}...`);
        let total = 0;
        const years = fs.readdirSync(sourceDir).filter(f => /^[0-9]{4}$/.test(f));
        for (const y of years) {
          const months = fs.readdirSync(path.join(sourceDir, y)).filter(f => /^[0-9]{2}$/.test(f));
          for (const m of months) {
            const days = fs.readdirSync(path.join(sourceDir, y, m)).filter(f => /^[0-9]{2}$/.test(f));
            for (const d of days) {
              const hours = fs.readdirSync(path.join(sourceDir, y, m, d)).filter(f => /^[0-9]{2}$/.test(f));
              for (const h of hours) {
                const txt = path.join(sourceDir, y, m, d, h, 'image_ids.txt');
                if (fs.existsSync(txt)) {
                  const ids = fs.readFileSync(txt, 'utf-8').split('\n').map(id => id.trim()).filter(id => id.length > 0);
                  saveHourlyCache(y, m, d, h, ids);
                  total++;
                }
              }
            }
          }
          process.stdout.write('.');
        }
        console.log(`\nImport complete. Copied ${total} hourly index files.`);
      } else {
        console.error('Error: type must be "json" or "hourly"');
        process.exit(1);
      }
    });
}
