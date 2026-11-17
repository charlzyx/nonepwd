import { NONEPWD_CORE_WASM_B64 } from './wasm-embedded.js';
import {
  initNonePwdCore,
  invokeRust,
  invokeRustAsync,
  registerFallbackWasmBytesLoader,
  setNonePwdWasmModule,
} from './wasm-runtime.js';

function decodeBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

registerFallbackWasmBytesLoader(() => decodeBase64ToBytes(NONEPWD_CORE_WASM_B64));

export { initNonePwdCore, setNonePwdWasmModule, invokeRust, invokeRustAsync };
