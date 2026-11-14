import { handleReviewRequest } from "@/lib/review-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleReviewRequest;
export const POST = handleReviewRequest;
