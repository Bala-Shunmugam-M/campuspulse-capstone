import { NextResponse, type NextRequest } from "next/server";

/**
 * The confirmation page must show the access secret exactly once, but a Server
 * Component cannot delete a cookie. The page reads the value from the request
 * and this middleware expires it on the response, so it renders once and is
 * gone before the next request, including a refresh.
 *
 * The header is appended directly rather than via response.cookies.set, because
 * that helper also rewrites the request cookies forwarded to the page -- which
 * deletes the value before the page has had a chance to render it.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  for (const name of ["cp_ref", "cp_secret"]) {
    if (request.cookies.has(name)) {
      response.headers.append(
        "Set-Cookie",
        `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      );
    }
  }
  return response;
}

export const config = { matcher: ["/report/submitted"] };
