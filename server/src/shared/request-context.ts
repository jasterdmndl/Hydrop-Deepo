import type { ActiveSession } from "../modules/auth/service.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The single server clock reading for this request. */
      now: Date;
      /** Present after the authenticate guard succeeds. */
      auth?: ActiveSession;
    }
  }
}

export {};
