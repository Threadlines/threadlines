/**
 * Which boxes a dragged rectangle has caught.
 *
 * Lives out here rather than inside the injected overlay so it can be checked
 * against known numbers: it is the rule that decides what the user gets, it is
 * the thing most likely to be retuned, and buried in a five-hundred-line
 * template string it would be neither readable nor testable. The overlay
 * inlines this function's own source, so there is still only one copy of it.
 *
 * Written in plain ES so it survives being stringified and evaluated inside the
 * page: no imports, no closure over anything, nothing the bundler has to
 * rewrite into a helper that would not exist on the other side.
 */

export interface RegionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The indices of the boxes at least `coverage` of the way inside `region`.
 *
 * Not full containment: clipping two pixels off a card during a hurried drag
 * would drop it, which reads as the selection being broken rather than precise.
 * Not mere intersection either, or a rectangle drawn inside a page would catch
 * every wrapper it sits within, up to and including the body.
 */
export function coveredBoxIndices(
  boxes: ReadonlyArray<RegionBox>,
  region: RegionBox,
  coverage: number,
): number[] {
  const indices: number[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (box === undefined) {
      continue;
    }
    const area = (box.right - box.left) * (box.bottom - box.top);
    if (area <= 0) {
      continue;
    }
    const width = Math.min(box.right, region.right) - Math.max(box.left, region.left);
    const height = Math.min(box.bottom, region.bottom) - Math.max(box.top, region.top);
    if (width <= 0 || height <= 0) {
      continue;
    }
    if ((width * height) / area < coverage) {
      continue;
    }
    indices.push(index);
  }
  return indices;
}

/**
 * The source of `coveredBoxIndices`, for inlining into the injected overlay.
 *
 * Asserted rather than trusted: if a bundler ever rewrites the function into
 * something that closes over a helper, the overlay would fail silently in the
 * page -- and a silent overlay failure is the one bug in this feature that has
 * already happened once.
 */
export function coveredBoxIndicesSource(): string {
  const source = coveredBoxIndices.toString();
  if (!source.startsWith("function coveredBoxIndices(")) {
    throw new Error(`coveredBoxIndices is not inlinable: ${source.slice(0, 60)}`);
  }
  return source;
}
