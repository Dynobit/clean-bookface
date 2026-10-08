import artwork from './sample-weekend.png?inline';
import type { MemoryRecord, ArchiveKind } from './archive.js';
export function sampleRecords(): MemoryRecord[] {
  const row = (
    id: string,
    kind: ArchiveKind,
    date: string,
    title: string,
    text: string,
  ): MemoryRecord => ({
    id,
    kind,
    timestamp: Date.parse(date),
    title,
    text,
    sourcePath: `sample/${id}`,
    attachments: [],
    privateOnly: true,
  });
  const records = [
    row(
      'weekend',
      'photo',
      '2025-06-22T15:00:00Z',
      'A little room to breathe',
      'Saturday by the water. A picnic, a long walk, and absolutely no plans. — Alex Rowan',
    ),
    row(
      'garden',
      'post',
      '2025-06-18T12:00:00Z',
      'Small things, growing',
      'The balcony tomatoes finally have flowers. Counting this as a very good Wednesday.',
    ),
    row(
      'summer',
      'album',
      '2025-06-15T12:00:00Z',
      'The summer notebook',
      'A place for slow afternoons, familiar faces, and the days we want to remember.',
    ),
    row(
      'hello',
      'message',
      '2025-06-12T12:00:00Z',
      'A note from Jamie',
      'Jamie: Same café on Sunday?\nAlex: I’ll bring the book you lent me. And probably keep talking about it.',
    ),
    row(
      'kitchen',
      'post',
      '2025-06-08T12:00:00Z',
      'Around the kitchen table',
      'Made too much pasta. Called two friends. A useful recipe for an evening.',
    ),
    row(
      'friend',
      'friend',
      '2025-05-25T12:00:00Z',
      'Jamie Ellis',
      'A fictional friend in this sample collection.',
    ),
  ];
  const bytes = Uint8Array.from(atob(artwork.split(',')[1]), (c) => c.charCodeAt(0));
  records[0].attachments.push({
    path: 'sample/weekend.png',
    mimeType: 'image/png',
    bytes: new Blob([bytes], { type: 'image/png' }),
  });
  return records;
}
