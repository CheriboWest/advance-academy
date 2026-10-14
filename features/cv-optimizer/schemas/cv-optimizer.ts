import { z } from 'zod'

export const analyzeCvSchema = z.object({
  targetRole: z.string().trim().min(1, 'Target role is required.'),
  currentCvText: z.string().trim().min(30, 'Paste enough CV text to analyze.'),
  jobDescription: z.string().trim().optional().or(z.literal('')),
  savedJobId: z.string().uuid().optional(),
})
