/** Own one playback generation. Late fetch/decode/play resolutions cannot revive stale audio. */
export class SpeechPlayback {
  private generation = 0;
  private controller?: AbortController;
  private stopAudio?: () => void;

  begin() {
    this.interrupt();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => generation === this.generation && !controller.signal.aborted,
      /** Register a synchronous pause/stop BEFORE awaiting play(), resume(), or decode. */
      attach: (stop: () => void) => {
        if (generation !== this.generation || controller.signal.aborted) { stop(); return false; }
        this.stopAudio?.(); this.stopAudio = stop; return true;
      },
      complete: () => {
        if (generation === this.generation) { this.stopAudio = undefined; this.controller = undefined; }
      },
    };
  }

  /** Call on barge-in, stop, mode switch, permission/capture loss, navigation and unmount. */
  interrupt() {
    this.generation += 1;
    this.controller?.abort(); this.controller = undefined;
    const stop = this.stopAudio; this.stopAudio = undefined;
    stop?.();
  }
}
