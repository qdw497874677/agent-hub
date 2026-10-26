import { z } from 'zod';

export const id = z.string().min(1);
export const epochMs = z.number().int().nonnegative();
