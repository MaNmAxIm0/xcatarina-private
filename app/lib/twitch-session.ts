export type CapturedSession = {
  manifestUrl: string;
  vodId: string;
  capturedAt: number;
  vodStartedAt?: string;
  vodDurationSeconds?: number;
};

const state = globalThis as typeof globalThis & { xcatarinaTwitchSession?: CapturedSession };

export function setCapturedTwitchSession(session: CapturedSession | null) {
  if (session) state.xcatarinaTwitchSession = session;
  else delete state.xcatarinaTwitchSession;
}

export function getCapturedTwitchSession() {
  const session = state.xcatarinaTwitchSession;
  if (!session || Date.now() - session.capturedAt >= 6 * 60 * 60 * 1000) return null;
  return session;
}
