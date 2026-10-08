import { importArchives, type MemoryRecord } from './archive.js';
export type BookState = {
  records: MemoryRecord[];
  warnings: string[];
  mode: 'sample' | 'archive' | 'empty';
  busy: boolean;
  progress: string;
  error: string;
};
export class LocalBook {
  state: BookState;
  private generation = 0;
  private abort?: AbortController;
  constructor(
    private sample: () => MemoryRecord[],
    private changed: (update?: 'progress') => void,
    private importer = importArchives,
  ) {
    this.state = {
      records: sample(),
      warnings: [],
      mode: 'sample',
      busy: false,
      progress: '',
      error: '',
    };
  }
  cancel() {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    this.state.busy = false;
    this.state.progress = '';
    this.changed();
  }
  clear() {
    this.cancel();
    this.state = { records: [], warnings: [], mode: 'empty', busy: false, progress: '', error: '' };
    this.changed();
  }
  reset() {
    this.clear();
    this.state.records = this.sample();
    this.state.mode = 'sample';
    this.changed();
  }
  async open(files: File[]) {
    this.cancel();
    const generation = this.generation;
    const abort = (this.abort = new AbortController());
    this.state.busy = true;
    this.state.error = '';
    this.state.progress = 'Reading selected files…';
    this.changed();
    try {
      const result = await this.importer(files, {
        signal: abort.signal,
        onProgress: (done, total) => {
          if (generation === this.generation) {
            this.state.progress = `Reading ${done} of ${total} entries`;
            this.changed('progress');
          }
        },
      });
      if (generation !== this.generation) return;
      this.state.records = result.records;
      this.state.warnings = result.warnings;
      this.state.mode = 'archive';
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.error = error instanceof Error ? error.message : 'Could not open these files.';
    } finally {
      if (generation === this.generation) {
        this.state.busy = false;
        this.state.progress = '';
        this.abort = undefined;
        this.changed();
      }
    }
  }
}
export function selectRecords(
  records: MemoryRecord[],
  query: string,
  kind: string,
  oldest: boolean,
) {
  const term = query.trim().toLocaleLowerCase();
  return records
    .filter(
      (r) =>
        (!kind || r.kind === kind) &&
        (!term || `${r.title}\n${r.text}`.toLocaleLowerCase().includes(term)),
    )
    .sort((a, b) => (oldest ? 1 : -1) * ((a.timestamp ?? 0) - (b.timestamp ?? 0)));
}

/** Invalidating an export suppresses both late downloads and late errors. */
export class LocalExport {
  private generation = 0;
  constructor(private exporter: (records: MemoryRecord[]) => Promise<Blob>) {}
  cancel() {
    this.generation++;
  }
  async run(
    records: MemoryRecord[],
    deliver: (blob: Blob) => void,
  ): Promise<'ready' | 'cancelled' | 'failed'> {
    const generation = ++this.generation;
    try {
      const blob = await this.exporter(records);
      if (generation !== this.generation) return 'cancelled';
      deliver(blob);
      return 'ready';
    } catch {
      return generation === this.generation ? 'failed' : 'cancelled';
    }
  }
}
