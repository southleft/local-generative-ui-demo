import { describe, expect, it, vi } from 'vitest';
import { createHeapResidentEngine, type HeapFsNode, type HeapLoaderWasm } from './litert-heap-loader';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fakeWasm(heapSize = 1 << 20) {
  const heap = new Uint8Array(heapSize);
  const nodes = new Map<string, HeapFsNode>();
  const calls: string[] = [];
  const settings = { delete: vi.fn(() => calls.push('settings.delete')) };
  const engine = { delete: vi.fn(() => calls.push('engine.delete')) };
  const wasm: HeapLoaderWasm & { heap: Uint8Array; nodes: Map<string, HeapFsNode>; calls: string[]; engine: typeof engine; settings: typeof settings; backendSeen?: unknown; hintSeen?: string } = {
    heap,
    nodes,
    calls,
    engine,
    settings,
    _malloc: vi.fn((bytes: number) => {
      calls.push(`malloc ${bytes}`);
      return 100; // deliberately unaligned
    }),
    _free: vi.fn((pointer: number) => calls.push(`free ${pointer}`)),
    get HEAPU8() {
      return heap;
    },
    FS: {
      writeFile: vi.fn((path: string) => {
        nodes.set(path, { usedBytes: 0, contents: new Uint8Array(0), stream_ops: { existing: true } });
      }),
      lookupPath: (path: string) => ({ node: nodes.get(path)! }),
      unlink: vi.fn((path: string) => {
        calls.push(`unlink ${path}`);
        nodes.delete(path);
      }),
      ErrnoError: class extends Error {
        constructor(public errno: number) {
          super(`errno ${errno}`);
        }
      },
    },
    ModelAssets: { create: vi.fn(() => ({ delete: vi.fn(() => calls.push('assets.delete')) })) },
    EngineSettings: {
      createDefault: vi.fn((_assets: unknown, backend: { value: unknown }) => {
        wasm.backendSeen = backend.value;
        return settings;
      }),
    },
    Engine: {
      createEngine: vi.fn(async (_settings: unknown, hint: string) => {
        wasm.hintSeen = hint;
        calls.push('createEngine');
        return engine;
      }),
    },
  };
  return wasm;
}

describe('createHeapResidentEngine', () => {
  it('streams the file into a page-aligned heap block and maps the virtual file onto it', async () => {
    const wasm = fakeWasm();
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const progress: number[] = [];
    const configure = vi.fn();

    const result = await createHeapResidentEngine({
      wasm,
      backend: { value: 'GPU' },
      source: streamOf(bytes.slice(0, 400), bytes.slice(400)),
      totalBytes: 1000,
      configure,
      onProgress: (n) => progress.push(n),
      vfsPath: '/tuned.litertlm',
    });

    expect(wasm._malloc).toHaveBeenCalledWith(1000 + 65536);
    const base = 65536; // 100 rounded up to the next WASM page
    expect(Array.from(wasm.heap.subarray(base, base + 1000))).toEqual(Array.from(bytes));
    expect(progress).toEqual([400, 1000]);

    const node = wasm.nodes.get('/tuned.litertlm')!;
    expect(node.usedBytes).toBe(1000);
    expect(node.contents).toBeNull();
    expect(node.stream_ops.existing).toBe(true);
    const ops = node.stream_ops as { mmap: (s: unknown, length: number, position: number) => { ptr: number; allocated: boolean }; read: (s: unknown, b: Uint8Array, o: number, l: number, p: number) => number; write: () => void };
    expect(ops.mmap(null, 100, 400)).toEqual({ ptr: base + 400, allocated: false });
    expect(() => ops.mmap(null, 100_000, 400)).toThrow(/errno 28/);
    const out = new Uint8Array(8);
    expect(ops.read(null, out, 0, 8, 996)).toBe(4);
    expect(Array.from(out.subarray(0, 4))).toEqual(Array.from(bytes.subarray(996)));
    expect(ops.read(null, out, 0, 8, 1000)).toBe(0);
    expect(() => ops.write()).toThrow(/errno 63/);

    expect(wasm.backendSeen).toBe('GPU');
    expect(configure).toHaveBeenCalledWith(wasm.settings);
    expect(wasm.hintSeen).toBe('');
    expect(result.engine).toBe(wasm.engine);
    expect(result.heapBytes).toBe(wasm.heap.length);
    expect(wasm.calls).toEqual(['malloc 66536', 'assets.delete', 'createEngine', 'settings.delete']);

    result.release();
    result.release();
    expect(wasm.calls.slice(4)).toEqual(['engine.delete', 'unlink /tuned.litertlm', 'free 100']);
  });

  it('accepts a Blob source', async () => {
    const wasm = fakeWasm();
    const result = await createHeapResidentEngine({ wasm, backend: { value: 'GPU' }, source: new Blob([new Uint8Array([1, 2, 3])]), totalBytes: 3 });
    expect(Array.from(wasm.heap.subarray(65536, 65539))).toEqual([1, 2, 3]);
    result.release();
  });

  it('frees the block and refuses a stream that is shorter than declared', async () => {
    const wasm = fakeWasm();
    await expect(createHeapResidentEngine({ wasm, backend: { value: 'GPU' }, source: streamOf(new Uint8Array(10)), totalBytes: 20 })).rejects.toThrow(/ended after 10 of 20 bytes/);
    expect(wasm.calls).toEqual(['malloc 65556', 'free 100']);
    expect(wasm.Engine.createEngine).not.toHaveBeenCalled();
  });

  it('frees the block and the virtual file when the engine cannot be created', async () => {
    const wasm = fakeWasm();
    wasm.Engine.createEngine = vi.fn(async () => {
      throw new Error('Aborted()');
    });
    await expect(createHeapResidentEngine({ wasm, backend: { value: 'GPU' }, source: streamOf(new Uint8Array(4)), totalBytes: 4, vfsPath: '/x.litertlm' })).rejects.toThrow('Aborted()');
    expect(wasm.calls).toEqual(['malloc 65540', 'assets.delete', 'settings.delete', 'unlink /x.litertlm', 'free 100']);
  });

  it('requires a known size and a successful allocation', async () => {
    const wasm = fakeWasm();
    await expect(createHeapResidentEngine({ wasm, backend: { value: 'GPU' }, source: streamOf(), totalBytes: 0 })).rejects.toThrow(/size must be known/);
    wasm._malloc = vi.fn(() => 0);
    await expect(createHeapResidentEngine({ wasm, backend: { value: 'GPU' }, source: streamOf(), totalBytes: 5 })).rejects.toThrow(/reserve 5 bytes/);
  });
});
