// Auth.js v5 exposes the route handlers on `handlers` rather than as top-level
// GET/POST exports.
//
// Sign-in needs no simulated clock: sessions are kept on the real clock even
// under simulation, because a session is infrastructure rather than part of the
// record a run produces. See the note in src/lib/auth/session.ts.
import { handlers } from "@/lib/auth/config";

export const { GET, POST } = handlers;
