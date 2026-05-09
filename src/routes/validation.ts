import { z } from 'zod'

export const referralsQuerySchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  min_score: z.coerce.number().min(0).max(1).optional(),
  change_type: z.enum(['new', 'updated']).optional(),
  reward_type: z.enum(['per_referral', 'dual', 'capped', 'free_product', 'free_share', 'switching_bonus', 'percentage', 'signup_credit', 'image_text', 'unknown']).optional(),
  min_value: z.coerce.number().min(0).optional(),
  has_link: z.coerce.boolean().optional(),
  sort: z.enum(['score', 'newest', 'value']).default('score'),
})

export const submissionSchema = z.object({
  url: z.string().url().refine(
    (url) => url.startsWith('https://'),
    'URL must use HTTPS',
  ),
  submitted_by: z.string().min(1).max(100),
})

export const idParamSchema = z.object({
  id: z.string().uuid(),
})

export type ReferralsQuery = z.infer<typeof referralsQuerySchema>
export type SubmissionInput = z.infer<typeof submissionSchema>
