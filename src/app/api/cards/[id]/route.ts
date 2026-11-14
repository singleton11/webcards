import { handleCardRequest } from "@/lib/card-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleCardRequest(request, (await context.params).id);
}
export const GET = handle;
export const POST = handle;
