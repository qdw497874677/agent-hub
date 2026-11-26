import { createContext, useContext } from 'react';
import type { SessionDto } from './api.ts';

export type NewSessionWithModel = (session: SessionDto, model: string) => void;

export const NewSessionWithModelContext = createContext<NewSessionWithModel | null>(null);

export function useNewSessionWithModel(): NewSessionWithModel | null {
  return useContext(NewSessionWithModelContext);
}
