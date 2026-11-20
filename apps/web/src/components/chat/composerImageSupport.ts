/**
 * Whether each thread's composer would take images right now, as the composer
 * itself works it out from the selected model. Published by the mounted
 * composer so code outside it (a device recording handing off screenshots)
 * makes the same call the composer would. Unknown threads count as taking
 * images, the composer's own default for a model with no listed modalities.
 */
const imagesByThreadKey = new Map<string, boolean>();

export function publishComposerImageSupport(threadKey: string, acceptsImages: boolean) {
  imagesByThreadKey.set(threadKey, acceptsImages);
}

export function composerAcceptsImages(threadKey: string): boolean {
  return imagesByThreadKey.get(threadKey) ?? true;
}
