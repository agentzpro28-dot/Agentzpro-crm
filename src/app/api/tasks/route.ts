import { z } from "zod";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { AppError } from "@/lib/server/app-error";
import { DONE_RANGES, TASK_BUCKETS, getTaskOverview } from "@/lib/server/task-tracking-service";

const querySchema = z.object({
  bucket: z.enum(TASK_BUCKETS).default("today"),
  member: z.string().uuid().optional(),
  range: z.enum(DONE_RANGES).optional(),
  page: z.coerce.number().int().positive().max(1000).optional(),
  // "0": a refresh of a list already shown; the owner's member list is not read again.
  members: z.literal("0").optional(),
});

export async function GET(request: Request) {
  try {
    const params = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!params.success) throw new AppError("Request data is invalid.", { status: 400, code: "INVALID_REQUEST" });
    const { members, ...overviewRequest } = params.data;
    return createSuccessResponse(await getTaskOverview(await requireCrmAccess(), { ...overviewRequest, withMembers: members !== "0" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
