export type ResourceKey = "food" | "wood" | "stone" | "iron" | "people";

export type Character = {
  id: string;
  name: string;
  squad: string;
  role: string;
  stats: { speed: number; tactic: number; will: number };
  colors: [string, string];
};

export type CityCell = {
  id: string;
  buildingId: string | null;
};

export type CityState = {
  resources: Record<ResourceKey, number>;
  cells: CityCell[];
  unlockedWalls: string[];
  lastTickAt: string;
};

export type Player = {
  id: string;
  name: string;
  characterId: string;
  mode: string;
  cityState: CityState;
  updatedAt: string;
};

export type MissionState = {
  active: boolean;
  finished: boolean;
  actions: number;
  risk: number;
  resources: Record<ResourceKey, number>;
  log: string[];
  report: string;
};
