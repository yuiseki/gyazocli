/**
 * The `config` commands: the stored access token, and `config get me`.
 */
import type { Command } from 'commander';
import { getCurrentUser } from '../api';
import { ensureAccessToken, getStoredConfig, setStoredConfig } from '../credentials';

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Manage configuration');

  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action((key, value) => {
      setStoredConfig(key, value);
    });

  configCmd
    .command('get <key>')
    .description('Get a configuration value')
    .option('-j, --json', 'output as JSON')
    .action(async (key, options) => {
      if (key === 'me') {
        await ensureAccessToken();
        try {
          const me = await getCurrentUser();
          if (options.json) {
            console.log(JSON.stringify(me, null, 2));
            return;
          }

          const user = me?.user || {};
          if (user.uid) console.log(`UID: ${user.uid}`);
          if (user.name) console.log(`Name: ${user.name}`);
          if (user.email) console.log(`Email: ${user.email}`);
          if (typeof user.is_pro === 'boolean') console.log(`Plan: ${user.is_pro ? 'Pro' : 'Free'}`);
          if (typeof user.is_team === 'boolean') console.log(`Team: ${user.is_team ? 'Yes' : 'No'}`);
          if (user.profile_image) console.log(`Profile image: ${user.profile_image}`);
        } catch (error: any) {
          console.error('Error getting current user:', error.message);
          process.exit(1);
        }
        return;
      }

      const value = getStoredConfig(key);
      if (value) {
        if (key === 'token') {
          const masked = value.length > 8 
            ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}`
            : '********';
          console.log(masked);
        } else {
          console.log(value);
        }
      } else {
        console.error(`Config key '${key}' not found.`);
        process.exit(1);
      }
    });
}
