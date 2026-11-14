import { getAuth } from "./auth";
import { getConfig } from "./config";
export async function handleAuthRequest(request: Request) {
  const path = new URL(request.url).pathname;
  const allowed =
    request.method === "GET"
      ? ["/api/auth/get-session"]
      : ["/api/auth/sign-in/username", "/api/auth/sign-out"];
  if (!allowed.includes(path))
    return Response.json({ error: "Not found." }, { status: 404 });
  // Enforce first-login CSRF protection for the username plugin as well.
  if (
    request.method === "POST" &&
    request.headers.get("origin") !==
      new URL(getConfig().BETTER_AUTH_URL).origin
  ) {
    return Response.json({ error: "Untrusted origin." }, { status: 403 });
  }
  const response = await getAuth().handler(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
