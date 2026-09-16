import { z } from "zod";

export const reportInputSchema = z.object({
  title: z.string().trim().min(8, "Give the report a short, specific title.").max(200),
  description: z
    .string()
    .trim()
    .min(40, "Describe what happened in at least a couple of sentences.")
    .max(10_000),
  severitySelfReported: z.enum(["low", "moderate", "high", "severe"]),
  categoryId: z.string().uuid().nullable(),
  locationId: z.string().uuid().nullable(),
  occurredAt: z.coerce.date().nullable(),
});

export type ReportInput = z.infer<typeof reportInputSchema>;
