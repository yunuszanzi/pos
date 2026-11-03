import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../server/app";

type VercelRequest = IncomingMessage & { body?: unknown };
type VercelResponse = ServerResponse & { status: (code: number) => VercelResponse };

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = request.method ?? "GET";
  const protocol = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"]
    : "https";
  const host = request.headers.host ?? "localhost";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Buffer.isBuffer(request.body)
      ? request.body
      : typeof request.body === "string"
        ? request.body
        : request.body === undefined
          ? undefined
          : JSON.stringify(request.body);
  const apiRequest = new Request(`${protocol}://${host}${request.url ?? "/"}`, { method, headers, body });
  const apiResponse = await app.fetch(apiRequest);
  response.status(apiResponse.status);
  apiResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await apiResponse.arrayBuffer()));
}
