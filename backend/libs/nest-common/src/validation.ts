import type { z } from 'zod';

/** Parse and validate a request body/query with zod; ZodError becomes a 400 problem via ProblemFilter. */
export const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => schema.parse(value);
