import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (!process.env.VERCEL) return NextResponse.next();
  const currentIp = (request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const allowedIps = (process.env.ALLOWED_IPS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowedIps.includes(currentIp)) return NextResponse.next();
  return new NextResponse("Este estúdio é privado e este IP não está autorizado.", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export const config = {
  matcher: ["/((?!api/upload|_next/static|_next/image|favicon.ico).*)"],
};
