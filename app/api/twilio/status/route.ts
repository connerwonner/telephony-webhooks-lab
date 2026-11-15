import { handleWebhook } from "../../../../lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One handler for every verb so unexpected methods get a clean 405.
const h = (req: Request) => handleWebhook(req, "status");
export const POST = h, GET = h, PUT = h, PATCH = h, DELETE = h;
