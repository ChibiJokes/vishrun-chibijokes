import type { RawRegexScript } from '../lumiverse/fetch-character';

export interface ActiveCard {
  characterId: string;
  characterName: string | null;
  scripts: RawRegexScript[];
}

let current: ActiveCard | null = null;

export function getActiveCard(): ActiveCard | null {
  return current;
}

export function setActiveCard(card: ActiveCard): void {
  current = card;
}

export function clearActiveCard(): void {
  current = null;
}
