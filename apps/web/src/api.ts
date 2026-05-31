import type { CityState, Player } from "./types";

type StateResponse = {
  players: Player[];
  currentPlayer: Player | null;
};

type PlayerResponse = {
  token: string;
  player: Player;
  players: Player[];
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "Сервер временно недоступен.");
  }
  return payload as T;
}

export function loadState(token: string) {
  return request<StateResponse>(`/api/state${token ? `?token=${encodeURIComponent(token)}` : ""}`);
}

export function savePlayer(input: { token: string; name: string; password: string; characterId: string; mode: string }) {
  return request<PlayerResponse>("/api/players", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function loginPlayer(input: { name: string; password: string }) {
  return request<PlayerResponse>("/api/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function saveCity(token: string, cityState: CityState) {
  return request<{ player: Player }>("/api/city", {
    method: "PUT",
    body: JSON.stringify({ token, cityState })
  });
}
