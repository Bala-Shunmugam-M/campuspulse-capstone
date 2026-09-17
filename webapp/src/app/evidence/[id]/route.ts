import { NextResponse } from "next/server";
import { currentActor } from "@/lib/auth/actor";
import { readEvidence } from "@/server/evidence";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

/**
 * Evidence is streamed through an authorised handler, never served from a
 * static path. Content-Disposition is attachment and the type is the sniffed
 * one, so a browser is not invited to render someone's upload inline.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await currentActor();
  if (!actor) return new NextResponse("Not found", { status: 404 });

  const { id } = await params;

  try {
    const file = await readEvidence(actor, id);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.filename.replace(/["\r\n]/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (thrown) {
    // A refusal and a miss look identical from outside: distinguishing them
    // tells a caller which evidence ids exist.
    if (thrown instanceof ForbiddenError || thrown instanceof NotFoundError) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw thrown;
  }
}
