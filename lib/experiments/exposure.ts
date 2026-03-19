export interface ExposureState {
  posthogExposureSentAt?: number;
  posthogExposureLastErrorAt?: number;
  posthogExposureLastError?: string;
}

export function shouldSendExposure(state: ExposureState): boolean {
  return typeof state.posthogExposureSentAt !== "number";
}

export function markExposureSent(now: number): ExposureState {
  return {
    posthogExposureSentAt: now,
    posthogExposureLastErrorAt: undefined,
    posthogExposureLastError: undefined,
  };
}

export function markExposureFailure(now: number, message: string): ExposureState {
  return {
    posthogExposureLastErrorAt: now,
    posthogExposureLastError: message.slice(0, 400),
  };
}

