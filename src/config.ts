import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().min(1).default('postgresql://localhost:5432/referral_discovery'),
  EASYEARNS_API_KEY: z.string().min(16).default('dev-key-16chars-minimum'),
  ADMIN_API_KEY: z.string().min(16).default('admin-key-16chars-minimum'),
  GOOGLE_CSE_KEY: z.string().min(1).default('dev-cse-key'),
  GOOGLE_CSE_ID: z.string().min(1).default('dev-cse-id'),
  SERPER_API_KEY: z.string().min(1).default('dev-serper-key'),
  BRAVE_API_KEY: z.string().min(1).default('dev-brave-key'),
  CORS_ORIGINS: z.string().default('https://easyearns.com'),
})

export type Config = z.infer<typeof envSchema>

function loadConfig(): Config {
  return envSchema.parse(process.env)
}

export const config = loadConfig()

