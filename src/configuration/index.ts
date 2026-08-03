export type AppEnv = "local" | "development" | "staging" | "production";

export const APP_ENV = (process.env.APP_ENV as AppEnv) || "local";
export const APP_PORT = process.env.PORT || 3002;
export const DATABASE_URL = process.env.DATABASE_URL;
export const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
export const AI_KEY_ENCRYPTION_KEY = process.env.AI_KEY_ENCRYPTION_KEY;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
