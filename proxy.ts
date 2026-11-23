import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Temporary sign-in until Microsoft 365 login is added: the browser asks for a
// username and password (APP_USER / APP_PASSWORD in Vercel). Without this, anyone
// who found the site could upload images to your AWS storage.

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) {
    return new NextResponse("PaunchPost is locked: set APP_USER and APP_PASSWORD in Vercel.", { status: 503 });
  }
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const [u, ...rest] = atob(header.slice(6)).split(":");
      if (safeEqual(u, user) && safeEqual(rest.join(":"), pass)) return NextResponse.next();
    } catch {
      /* fall through */
    }
  }
  return new NextResponse("Sign in required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="PaunchPost", charset="UTF-8"' },
  });
}

export const config = {
  // Everything except Next.js build files and the logo images.
  matcher: ["/((?!_next/static|_next/image|paunchpost-cat.jpg|paunchpost-logo.jpg|favicon.ico).*)"],
};
