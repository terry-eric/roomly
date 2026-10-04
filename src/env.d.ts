interface Env {
  CALENDAR_SYNC_QUEUE?: Queue<{week:string;manual?:true}>;
  GOOGLE_LOGIN_REDIRECT?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CALENDAR_TOKEN_KEY?: string;
}
