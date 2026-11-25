/** The homepage's threads script, compiled to one string at build (astro.config.mjs). */
declare module "virtual:threads-boot" {
  const code: string;
  export default code;
}

/** An image imported with `?inline`: its data URL. */
declare module "*.png?inline" {
  const dataUrl: string;
  export default dataUrl;
}
