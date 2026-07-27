import { defineConfig } from "drizzle-kit";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!(accountId && databaseId && token)) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN are required"
  );
}

export default defineConfig({
  dbCredentials: {
    accountId,
    databaseId,
    token,
  },
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
});
