import { handleCardRequest } from "@/lib/card-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (request: Request) => handleCardRequest(request);
export const POST = (request: Request) => handleCardRequest(request);
