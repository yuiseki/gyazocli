import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const configSchema = z.object({
  GYAZO_ACCESS_TOKEN: z.string().optional(),
  GYAZO_CLIENT_ID: z.string().optional(),
  GYAZO_CLIENT_SECRET: z.string().optional(),
  GYAZO_CACHE_DIR: z.string().optional(),
});

export let config = configSchema.parse({
  GYAZO_ACCESS_TOKEN: process.env.GYAZO_ACCESS_TOKEN,
  GYAZO_CLIENT_ID: process.env.GYAZO_CLIENT_ID,
  GYAZO_CLIENT_SECRET: process.env.GYAZO_CLIENT_SECRET,
  GYAZO_CACHE_DIR: process.env.GYAZO_CACHE_DIR,
});

export function setAccessToken(token: string) {
  config.GYAZO_ACCESS_TOKEN = token;
}
