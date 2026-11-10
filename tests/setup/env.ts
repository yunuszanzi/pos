import "dotenv/config";

// A machine without these in .env still runs the tests: a fixed key (never a real one) and the fake FBR service.
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.FBR_ADAPTER ??= "mock";
process.env.CRON_SECRET ??= "test-cron-secret-0123456789abcdef";
