// Project bindings. Runtime types come from @cloudflare/workers-types.
interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  ADMIN_EMAIL: string;
  MAIL_FROM: string;
}
