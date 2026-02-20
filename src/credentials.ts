import fs from 'fs';
import path from 'path';
import os from 'os';
import { config, setAccessToken } from './config';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'gyazo');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

function loadStoredCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

export function getStoredConfig(key: string): string | undefined {
  const stored = loadStoredCredentials();
  if (key === 'token') return stored.GYAZO_ACCESS_TOKEN;
  return undefined;
}

export function setStoredConfig(key: string, value: string): void {
  const stored = loadStoredCredentials();
  if (key === 'token') {
    stored.GYAZO_ACCESS_TOKEN = value;
  } else {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(stored, null, 2));
  console.error(`Config set: ${key}=${value}`);
}

export async function ensureAccessToken(): Promise<string> {
  if (config.GYAZO_ACCESS_TOKEN) {
    return config.GYAZO_ACCESS_TOKEN;
  }

  const storedToken = getStoredConfig('token');
  if (storedToken) {
    setAccessToken(storedToken);
    return storedToken;
  }

  console.error('Error: Gyazo Access Token is not set.');
  console.error('Please run the following command to set your access token:');
  console.error('  gyazo config set token <your_access_token>');
  process.exit(1);
}
