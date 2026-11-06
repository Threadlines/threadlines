/**
 * The browser APIs the backdrop runtime and the art worker's prelude use,
 * described by shape (types only). Both run in a browser, but their modules
 * are also compiled into programs without the DOM's types (the server builds
 * the frame document for the theme specimen, scripts render thumbnails), so
 * they name none of the DOM's own types and add no libraries to anyone's
 * program. Extend these when the runtime needs more of the platform.
 */

/** A WebGL object (shader, program, buffer, texture, framebuffer, vertex array, uniform location). */
export type GLHandle = object;

/** What texImage2D takes besides raw bytes: a canvas or a bitmap. */
export type TexImageSource = BackdropCanvasElement | BackdropBitmap;

/** The WebGL2 calls and constants the frame uses. */
export interface BackdropGL {
  readonly ARRAY_BUFFER: number;
  readonly BLEND: number;
  readonly CLAMP_TO_EDGE: number;
  readonly COLOR_ATTACHMENT0: number;
  readonly COMPILE_STATUS: number;
  readonly DYNAMIC_DRAW: number;
  readonly FLOAT: number;
  readonly FRAGMENT_SHADER: number;
  readonly FRAMEBUFFER: number;
  readonly LINEAR: number;
  readonly LINEAR_MIPMAP_LINEAR: number;
  readonly LINK_STATUS: number;
  readonly NEAREST: number;
  readonly ONE: number;
  readonly ONE_MINUS_SRC_ALPHA: number;
  readonly PACK_ALIGNMENT: number;
  readonly RGBA: number;
  readonly RGBA8: number;
  readonly SHORT: number;
  readonly STATIC_DRAW: number;
  readonly TEXTURE0: number;
  readonly TEXTURE1: number;
  readonly TEXTURE2: number;
  readonly TEXTURE_2D: number;
  readonly TEXTURE_MAG_FILTER: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_WRAP_S: number;
  readonly TEXTURE_WRAP_T: number;
  readonly TRIANGLES: number;
  readonly TRIANGLE_STRIP: number;
  readonly UNPACK_ALIGNMENT: number;
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL: number;
  readonly UNSIGNED_BYTE: number;
  readonly VERTEX_SHADER: number;
  activeTexture(unit: number): void;
  attachShader(program: GLHandle, shader: GLHandle): void;
  bindBuffer(target: number, buffer: GLHandle | null): void;
  bindFramebuffer(target: number, framebuffer: GLHandle | null): void;
  bindTexture(target: number, texture: GLHandle | null): void;
  bindVertexArray(vertexArray: GLHandle | null): void;
  blendFunc(source: number, destination: number): void;
  bufferData(target: number, data: ArrayBufferView, usage: number): void;
  bufferSubData(target: number, offset: number, data: ArrayBufferView): void;
  colorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void;
  compileShader(shader: GLHandle): void;
  createBuffer(): GLHandle | null;
  createFramebuffer(): GLHandle | null;
  createProgram(): GLHandle | null;
  createShader(type: number): GLHandle | null;
  createTexture(): GLHandle | null;
  createVertexArray(): GLHandle | null;
  deleteFramebuffer(framebuffer: GLHandle | null): void;
  deleteTexture(texture: GLHandle | null): void;
  disable(capability: number): void;
  drawArrays(mode: number, first: number, count: number): void;
  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void;
  enable(capability: number): void;
  enableVertexAttribArray(index: number): void;
  framebufferTexture2D(
    target: number,
    attachment: number,
    textureTarget: number,
    texture: GLHandle | null,
    level: number,
  ): void;
  generateMipmap(target: number): void;
  getExtension(name: "WEBGL_lose_context"): { loseContext(): void } | null;
  getProgramInfoLog(program: GLHandle): string | null;
  getProgramParameter(program: GLHandle, name: number): unknown;
  getShaderInfoLog(shader: GLHandle): string | null;
  getShaderParameter(shader: GLHandle, name: number): unknown;
  getUniformLocation(program: GLHandle, name: string): GLHandle | null;
  linkProgram(program: GLHandle): void;
  pixelStorei(name: number, value: number | boolean): void;
  readPixels(
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
  ): void;
  shaderSource(shader: GLHandle, source: string): void;
  texImage2D(
    target: number,
    level: number,
    internalFormat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: ArrayBufferView | null,
  ): void;
  texImage2D(
    target: number,
    level: number,
    internalFormat: number,
    format: number,
    type: number,
    source: TexImageSource,
  ): void;
  texParameteri(target: number, name: number, value: number): void;
  texStorage2D(
    target: number,
    levels: number,
    internalFormat: number,
    width: number,
    height: number,
  ): void;
  texSubImage2D(
    target: number,
    level: number,
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
  ): void;
  uniform1f(location: GLHandle | null, x: number): void;
  uniform1fv(location: GLHandle | null, data: Float32Array): void;
  uniform1i(location: GLHandle | null, x: number): void;
  uniform2f(location: GLHandle | null, x: number, y: number): void;
  uniform2i(location: GLHandle | null, x: number, y: number): void;
  uniform2fv(location: GLHandle | null, data: Float32Array): void;
  uniform3f(location: GLHandle | null, x: number, y: number, z: number): void;
  uniform3fv(location: GLHandle | null, data: Float32Array): void;
  uniform4f(location: GLHandle | null, x: number, y: number, z: number, w: number): void;
  uniform4fv(location: GLHandle | null, data: Float32Array): void;
  useProgram(program: GLHandle | null): void;
  vertexAttribDivisor(index: number, divisor: number): void;
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void;
  viewport(x: number, y: number, width: number, height: number): void;
}

/** A 2d canvas context: the glyph atlas and the still are drawn with it. */
export interface Backdrop2D {
  font: string;
  textAlign: string;
  textBaseline: string;
  fillStyle: string;
  fillText(text: string, x: number, y: number): void;
  createImageData(width: number, height: number): { readonly data: Uint8ClampedArray };
  putImageData(image: { readonly data: Uint8ClampedArray }, x: number, y: number): void;
}

/** Inline style the runtime sets (CSSOM properties: allowed under a policy without style-src). */
export interface BackdropStyle {
  position: string;
  left: string;
  top: string;
  width: string;
  height: string;
  display: string;
  margin: string;
  overflow: string;
  background: string;
  colorScheme: string;
}

export interface BackdropCanvasElement {
  width: number;
  height: number;
  readonly style: BackdropStyle;
  getContext(kind: "webgl2", options: Record<string, unknown>): BackdropGL | null;
  getContext(kind: "2d"): Backdrop2D | null;
  toDataURL(type: string): string;
  addEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
}

export interface BackdropBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** The art worker, as the frame drives it. */
export interface BackdropWorker {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
    options: { signal: AbortSignal },
  ): void;
  addEventListener(
    type: "error",
    listener: (event: { readonly message: string; preventDefault(): void }) => void,
    options: { signal: AbortSignal },
  ): void;
  addEventListener(
    type: "messageerror",
    listener: () => void,
    options: { signal: AbortSignal },
  ): void;
}

/** The frame's window. */
export interface BackdropWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  readonly document: {
    createElement(tag: "canvas"): BackdropCanvasElement;
    readonly documentElement: { readonly style: BackdropStyle };
    readonly body: {
      readonly style: BackdropStyle;
      appendChild(node: BackdropCanvasElement): unknown;
    };
  };
  readonly Worker: new (url: string) => BackdropWorker;
  readonly ImageBitmap: abstract new () => BackdropBitmap;
  createImageBitmap(image: Blob): Promise<BackdropBitmap>;
  addEventListener(
    type: "message",
    listener: (event: { readonly source: unknown; readonly data: unknown }) => void,
  ): void;
  setTimeout(handler: () => void, ms?: number): number;
  clearTimeout(id: number | undefined): void;
  setInterval(handler: () => void, ms?: number): number;
}

/** What the art worker's prelude uses of the worker's global scope. */
export interface BackdropWorkerScope {
  postMessage(message: unknown, transfer?: Array<ArrayBuffer | BackdropBitmap>): void;
  addEventListener(
    type: string,
    listener: (event: {
      readonly data?: unknown;
      readonly error?: unknown;
      readonly message?: string;
      readonly reason?: unknown;
      preventDefault(): void;
    }) => void,
  ): void;
  readonly OffscreenCanvas: new (width: number, height: number) => BackdropOffscreenCanvas;
}

export interface BackdropOffscreenCanvas {
  width: number;
  height: number;
  getContext(kind: "2d" | "webgl2", options: Record<string, unknown>): object | null;
  transferToImageBitmap(): BackdropBitmap;
}
