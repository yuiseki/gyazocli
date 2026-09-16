/**
 * The `config` commands: the stored access token, and `config get me`.
 */
import type { Command } from 'commander';
import { getCurrentUser } from '../api';
import { setAccessToken } from '../config';
import { ensureAccessToken, getStoredConfig, setStoredConfig } from '../credentials';

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Manage configuration');

  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .option('--no-verify', 'save a token without checking it against the API first')
    .action(async (key, value, options) => {
      // A token that Gyazo will not accept is worth catching here rather than
      // at the next command: the page it comes from shows several strings of
      // the same shape, and a saved bad token replaces a good one.
      if (key === 'token' && options.verify !== false) {
        setAccessToken(value);
        try {
          await getCurrentUser();
        } catch (error: any) {
          console.error(`Error: this token was not accepted. ${error.message}`);
          console.error('Nothing was saved. Check that the value is the access token');
          console.error('from https://gyazo.com/oauth/applications, not the client ID or secret.');
          console.error('Save it anyway with --no-verify.');
          process.exit(1);
        }
      }
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
