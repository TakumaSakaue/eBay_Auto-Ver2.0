import { z } from "zod";

const EnvSchema = z.object({
  EBAY_CLIENT_ID: z.string().optional().transform((v) => v ?? ""),
  EBAY_CLIENT_SECRET: z.string().optional().transform((v) => v ?? ""),
  EBAY_ENV: z
    .enum(["production", "sandbox"]) 
    .default("production"),
  EBAY_MARKETPLACE_ID: z.string().min(1).default("EBAY_US"),
  EBAY_MARKETPLACE: z.string().optional(),
  EBAY_ITEM_LOCATION_COUNTRY: z.string().optional(),
  MAX_RESULTS_PER_SELLER: z.coerce.number().int().positive().default(50),
  CONCURRENCY: z.coerce.number().int().positive().default(3),
  CACHE_TTL_MS: z.coerce.number().int().positive().default(900000),
});

export const env = EnvSchema.parse({
  EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
  EBAY_ENV: process.env.EBAY_ENV ?? "production",
  EBAY_MARKETPLACE_ID: process.env.EBAY_MARKETPLACE_ID ?? "EBAY_US",
  MAX_RESULTS_PER_SELLER: process.env.MAX_RESULTS_PER_SELLER ?? "50",
  CONCURRENCY: process.env.CONCURRENCY ?? "3",
  CACHE_TTL_MS: process.env.CACHE_TTL_MS ?? "900000",
  EBAY_ITEM_LOCATION_COUNTRY: process.env.EBAY_ITEM_LOCATION_COUNTRY,
});

export type Env = typeof env;


