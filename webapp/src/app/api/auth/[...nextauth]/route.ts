// Auth.js v5 exposes the route handlers on `handlers` rather than as top-level
// GET/POST exports.
import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth/config";
import { adoptSimulatedTime } from "@/lib/clock";

/**
 * Sign-in stamps last_login_at, issues a session and writes an audit row, and a
 * simulated run needs all three dated like everything else it produces. The
 * clock is adopted here, before Auth.js runs, because authorize() never sees the
 * request itself. Outside simulation mode this is a no-op and the header is
 * never read.
 */
export async function GET(request: NextRequest) {
  adoptSimulatedTime(request.headers);
  return handlers.GET(request);
}

export async function POST(request: NextRequest) {
  adoptSimulatedTime(request.headers);
  return handlers.POST(request);
}
