/**
 * Loads a standard (non "-web") .litertlm file into LiteRT-LM.js without the
 * package's streaming path, which only accepts Google's artisan web artifacts.
 *
 * The runtime's non-streaming path wants the file in its Emscripten virtual
 * filesystem, but a multi-gigabyte file cannot be one JavaScript buffer in
 * Chrome (a single ArrayBuffer of 2 GB is refused). So the bytes are streamed
 * straight into the WASM heap, and an empty MEMFS node is given stream ops
 * whose mmap answers with a pointer into that block. The runtime's MAP_PRIVATE
 * section maps then alias the block instead of copying it, and the whole file
 * costs its own size in heap plus the runtime's working memory (about 0.7 GB
 * for Gemma 4 E2B), inside the 4 GB wasm32 ceiling.
 *
 * Verified on 2026-09-11 with @litert-lm/core 0.14.0: Google's standard
 * gemma-4-E2B-it.litertlm and a vocabulary-pruned int8 fine-tune both load on
 * backend GPU and generate. The stream_ops shape is Emscripten's MEMFS
 * contract (read/write/mmap/msync), so this is coupled to the runtime's
 * Emscripten build; the version is pinned in package.json.
 */

export interface HeapFsNode {
  usedBytes: number;
  contents: Uint8Array | null;
  stream_ops: Record<string, unknown>;
}

export interface HeapEngineSettings {
  delete(): void;
}

/** The slice of the Emscripten module and the LiteRT-LM bindings this loader touches. */
export interface HeapLoaderWasm {
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  /** Re-read on every access: memory growth replaces the underlying buffer. */
  readonly HEAPU8: Uint8Array;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    lookupPath(path: string): { node: HeapFsNode };
    unlink(path: string): void;
    ErrnoError: new (errno: number) => Error;
  };
  ModelAssets: { create(path: string): { delete(): void } };
  EngineSettings: { createDefault(assets: unknown, backend: { value: unknown }): HeapEngineSettings };
  Engine: { createEngine(settings: HeapEngineSettings, inputPromptAsHint: string): Promise<{ delete(): void }> };
}

export interface HeapResidentEngineOptions<Settings extends HeapEngineSettings = HeapEngineSettings> {
  wasm: HeapLoaderWasm;
  /** The runtime's Backend enum value, wrapped the way embind expects (`{ value }`). */
  backend: { value: unknown };
  source: ReadableStream<Uint8Array> | Blob;
  /** Exact byte length of the file; the block is allocated before the first byte arrives. */
  totalBytes: number;
  /** Applies executor settings (token budget, threading) before the engine is created. */
  configure?: (settings: Settings) => void;
  onProgress?: (loadedBytes: number) => void;
  /** Path of the virtual file; unique per load so two models never collide. */
  vfsPath?: string;
}

export interface HeapResidentEngine {
  engine: { delete(): void };
  /** Bytes the WASM heap had grown to once the engine existed. */
  heapBytes: number;
  /** Deletes the engine, unlinks the virtual file and frees the heap block. */
  release(): void;
}

const ALIGN = 65536; // WASM page size; MEMFS mmap pointers must be page-aligned
const EPERM = 63;
const EINVAL = 28;

let loadCounter = 0;

function sourceStream(source: ReadableStream<Uint8Array> | Blob): ReadableStream<Uint8Array> {
  // instanceof Blob is unreliable across realms; feature-detect instead.
  if (typeof (source as Blob).size === 'number' && typeof (source as Blob).arrayBuffer === 'function') {
    const blob = source as Blob;
    const stream = typeof blob.stream === 'function' ? blob.stream() : undefined;
    if (stream && typeof stream.getReader === 'function') return stream;
    // Test environments (jsdom) have no streaming Blob; browsers always take the branch above,
    // which never materialises the whole file in JavaScript memory.
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        for (let offset = 0; offset < bytes.length; offset += 1 << 20) controller.enqueue(bytes.subarray(offset, offset + (1 << 20)));
        controller.close();
      },
    });
  }
  return source as ReadableStream<Uint8Array>;
}

export async function createHeapResidentEngine<Settings extends HeapEngineSettings = HeapEngineSettings>(options: HeapResidentEngineOptions<Settings>): Promise<HeapResidentEngine> {
  const { wasm, totalBytes } = options;
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) throw new Error(`The model size must be known before it can be placed in the WASM heap (got ${totalBytes}).`);
  const vfsPath = options.vfsPath ?? `/heap-model-${(loadCounter += 1)}.litertlm`;

  const raw = wasm._malloc(totalBytes + ALIGN) >>> 0;
  if (!raw) throw new Error(`Could not reserve ${totalBytes.toLocaleString()} bytes inside the WASM heap for the model.`);
  const base = (raw + ALIGN - 1) & ~(ALIGN - 1);
  let unlinkNeeded = false;
  const cleanup = () => {
    if (unlinkNeeded) {
      try {
        wasm.FS.unlink(vfsPath);
      } catch {
        /* already gone */
      }
    }
    wasm._free(raw);
  };

  try {
    const reader = sourceStream(options.source).getReader();
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (offset + value.byteLength > totalBytes) throw new Error(`The model stream delivered more than the declared ${totalBytes.toLocaleString()} bytes.`);
      wasm.HEAPU8.set(value, base + offset);
      offset += value.byteLength;
      options.onProgress?.(offset);
    }
    if (offset !== totalBytes) throw new Error(`The model stream ended after ${offset.toLocaleString()} of ${totalBytes.toLocaleString()} bytes.`);

    wasm.FS.writeFile(vfsPath, new Uint8Array(0));
    unlinkNeeded = true;
    const node = wasm.FS.lookupPath(vfsPath).node;
    node.usedBytes = totalBytes;
    node.contents = null;
    node.stream_ops = {
      ...node.stream_ops,
      read(_stream: unknown, buffer: Uint8Array, bufferOffset: number, length: number, position: number) {
        if (position >= totalBytes) return 0;
        const size = Math.min(totalBytes - position, length);
        buffer.set(wasm.HEAPU8.subarray(base + position, base + position + size), bufferOffset);
        return size;
      },
      write() {
        throw new wasm.FS.ErrnoError(EPERM);
      },
      mmap(_stream: unknown, length: number, position: number) {
        if (position < 0 || position + length > totalBytes + ALIGN) throw new wasm.FS.ErrnoError(EINVAL);
        return { ptr: base + position, allocated: false };
      },
      msync() {
        return 0;
      },
    };

    const assets = wasm.ModelAssets.create(vfsPath);
    const settings = wasm.EngineSettings.createDefault(assets, options.backend) as Settings;
    assets.delete();
    try {
      options.configure?.(settings);
      const engine = await wasm.Engine.createEngine(settings, '');
      const heapBytes = wasm.HEAPU8.length;
      let released = false;
      return {
        engine,
        heapBytes,
        release() {
          if (released) return;
          released = true;
          engine.delete();
          cleanup();
        },
      };
    } finally {
      settings.delete();
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}
