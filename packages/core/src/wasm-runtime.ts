export interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  np_alloc(len: number): number;
  np_dealloc(ptr: number, len: number): void;
  np_invoke(ptr: number, len: number): bigint;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let precompiledModule: WebAssembly.Module | null = null;
let fallbackBytesLoader: (() => Uint8Array<ArrayBuffer>) | null = null;
let cachedExports: WasmExports | null = null;
let initPromise: Promise<WasmExports> | null = null;

/**
 * Registers a pre-compiled `WebAssembly.Module` (e.g. imported `.wasm` asset in Cloudflare Workers).
 */
export function setNonePwdWasmModule(mod: WebAssembly.Module): void {
  precompiledModule = mod;
  cachedExports = null;
  initPromise = null;
}

/**
 * Registers a lazy loader returning raw WASM bytes for environments supporting runtime compilation.
 */
export function registerFallbackWasmBytesLoader(loader: () => Uint8Array<ArrayBuffer>): void {
  fallbackBytesLoader = loader;
}

function buildImports(getMemory: () => WebAssembly.Memory): WebAssembly.Imports {
  return {
    nonepwd_env: {
      host_fill_random(ptr: number, len: number) {
        const mem = getMemory();
        const slice = new Uint8Array(mem.buffer, ptr, len);
        globalThis.crypto.getRandomValues(slice);
      },
    },
  };
}

export async function initNonePwdCore(): Promise<void> {
  if (cachedExports) return;
  if (!initPromise) {
    initPromise = (async () => {
      let memRef: WebAssembly.Memory | null = null;
      const imports = buildImports(() => {
        if (!memRef) {
          throw new Error('WASM memory accessed before instantiation completed');
        }
        return memRef;
      });

      let instance: WebAssembly.Instance;
      if (precompiledModule) {
        instance = await WebAssembly.instantiate(precompiledModule, imports);
      } else if (fallbackBytesLoader) {
        const instantiated = await WebAssembly.instantiate(fallbackBytesLoader(), imports);
        instance = instantiated.instance;
      } else {
        throw new Error('NonePwd WASM module not initialized; call setNonePwdWasmModule() first');
      }

      const exports = instance.exports as WasmExports;
      memRef = exports.memory;
      cachedExports = exports;
      return exports;
    })();
  }
  await initPromise;
}

function getSyncWasmExports(): WasmExports {
  if (cachedExports) return cachedExports;
  const module =
    precompiledModule ?? (fallbackBytesLoader ? new WebAssembly.Module(fallbackBytesLoader()) : null);
  if (!module) {
    throw new Error('NonePwd WASM module not initialized; call setNonePwdWasmModule() first');
  }
  let memRef: WebAssembly.Memory | null = null;
  const instance = new WebAssembly.Instance(
    module,
    buildImports(() => {
      if (!memRef) {
        throw new Error('WASM memory accessed before instantiation completed');
      }
      return memRef;
    })
  );
  const exports = instance.exports as WasmExports;
  memRef = exports.memory;
  cachedExports = exports;
  return exports;
}

function invokeWithExports<T>(exports: WasmExports, op: string, args: unknown): T {
  const reqBytes = textEncoder.encode(JSON.stringify({ op, args }));
  const inPtr = exports.np_alloc(reqBytes.length);
  let outPtr = 0;
  let outLen = 0;
  try {
    new Uint8Array(exports.memory.buffer, inPtr, reqBytes.length).set(reqBytes);
    const packed = exports.np_invoke(inPtr, reqBytes.length);
    outPtr = Number(packed >> 32n);
    outLen = Number(packed & 0xffffffffn);
    const respBytes = new Uint8Array(exports.memory.buffer, outPtr, outLen);
    const respText = textDecoder.decode(respBytes);
    const parsed = JSON.parse(respText) as { ok: boolean; result?: T; error?: string };
    if (!parsed.ok) {
      throw new Error(parsed.error ?? `Rust WASM op "${op}" failed`);
    }
    return parsed.result as T;
  } finally {
    exports.np_dealloc(inPtr, reqBytes.length);
    if (outPtr !== 0 && outLen > 0) {
      exports.np_dealloc(outPtr, outLen);
    }
  }
}

export function invokeRust<T>(op: string, args: unknown = {}): T {
  const exports = getSyncWasmExports();
  return invokeWithExports<T>(exports, op, args);
}

export async function invokeRustAsync<T>(op: string, args: unknown = {}): Promise<T> {
  await initNonePwdCore();
  const exports = cachedExports!;
  return invokeWithExports<T>(exports, op, args);
}
