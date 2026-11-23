/** A synchronous, borrowed frame. The producer releases its source after `present` returns. */
export interface DeviceFrameSink {
  readonly present: (source: CanvasImageSource, width: number, height: number) => boolean;
}

/** Draws each frame onto `canvas`, resizing it to the frame. */
export function createCanvasFrameSink(
  canvas: HTMLCanvasElement,
  onFrame?: (width: number, height: number) => void,
): DeviceFrameSink {
  let cachedContext: CanvasRenderingContext2D | null = null;
  return {
    present(source, width, height) {
      if (width <= 0 || height <= 0) return false;
      const context = (cachedContext ??= canvas.getContext("2d", { alpha: false }));
      if (!context) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      onFrame?.(width, height);
      return true;
    },
  };
}
