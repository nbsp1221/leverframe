'use client';

import { type Dispatch, type SetStateAction, createContext, use, useState } from 'react';

type Draft = { model: string; reasoningEffort: string };

type DraftState = [Draft | null, Dispatch<SetStateAction<Draft | null>>];

const DraftContext = createContext<DraftState | null>(null);

// The app layout survives browser history transitions even when the settings page unmounts.
export function ReviewSettingsDraftProvider({ children }: { children: React.ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  return <DraftContext value={[draft, setDraft]}>{children}</DraftContext>;
}

export function useReviewSettingsDraft() {
  const state = use(DraftContext);
  if (!state) {
    throw new Error('ReviewSettingsDraftProvider is missing');
  }
  return state;
}
