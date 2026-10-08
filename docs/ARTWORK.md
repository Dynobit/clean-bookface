# Artwork

`public/assets/our-memories.png` is the original generated banner. It illustrates fictional memories, not a member's archive. It was made with the built-in image-generation tool for this project; no private photographs were supplied.

The same artwork appears on the welcome page and in the README. Keep accessibility text short and descriptive. It is decoration, never a substitute for a screenshot of working software.

## Generation prompt

Use case: illustration-story

Asset type: wide banner for the README and welcome page of Clean Bookface, an independent private social network with a familiar 2010–2015 blue-and-white spirit.

Primary request: an original, quietly charming editorial illustration about keeping your own memories and staying close to real friends.

Subject and scene: an open, well-loved blue photo album on a simple cream-colored table, with a few candid illustrated snapshots of friends sharing a picnic, a neighborhood walk, and a family celebration. The moments feel ordinary, specific and human. No identifiable real people.

Style/medium: tasteful hand-drawn ink and colored-pencil illustration on subtly textured warm paper, restrained detail, elegant editorial composition, slight print imperfections.

Composition/framing: wide landscape roughly 2:1, balanced spacious composition that reads clearly at 1200 pixels wide; artwork only, no UI mockup.

Color palette: ink navy, faded cornflower blue, ivory paper, a little leaf green and warm terracotta.

Lighting/mood: daylight, calm, welcoming, nostalgia without sentimentality.

Constraints: no text, no logos, no Facebook branding, no watermark, no robots, no ads, no technology clichés, no glossy 3D, no neon gradients, no corporate stock illustration.

## Album mark

The Album direction began as an original concept generated with the built-in image-generation tool: an open photo album with two facing profiles formed by its inner page edges. The final mark is a manually constructed, single-color SVG, not a raster crop or automated trace. Its simplified geometry uses a 64 × 64 viewBox and no fonts, filters, gradients, or external resources.

The source assets are `public/assets/album-mark.svg` and `public/favicon.svg`; the same geometry is inline in `src/views.ts` for the application header. The header uses the surrounding text color and keeps the linked name “clean bookface”; the decorative mark is hidden from assistive technology.

## Weekend cover photograph

`site/assets/cover-weekend.png` is a generated, fictional lakeside snapshot for the project website. It is not a member photograph or evidence of a real gathering. No private photographs were supplied. It was made with the built-in image-generation tool; the website retains the real application screenshots separately.

The same unmodified image is bundled as `encrypted-client/src/sample-weekend.png` for the fictional sample book. It is embedded in the sample so opening or exporting that book does not fetch a photograph from another server.

Generation prompt:

> Use case: photorealistic-natural. Asset type: a fictional personal cover photograph for an independent retro social-network homepage, wide 3:1 landscape composition. An ordinary lakeside park on a summer weekend, photographed casually on a small 2009 digital compact camera: weathered wooden picnic table low in the foreground with a small plain thermos and a casually left jacket, two ordinary bicycles leaned nearby, reeds at a quiet lake and a soft distant tree line. Natural muted greens and warm blues, gentle daylight, slightly imperfect casual framing and modest compact-camera texture. Warm familiar everyday life, like a snapshot kept among friends' weekend memories, not a grand travel destination. Keep the important scene within the middle horizontal band so it crops naturally to about 800 by 210 pixels. No people or faces, no text, no logos, no branding, no watermarks, no UI, no illustrated album, no commercial stock-photo perfection, no dramatic cinematic lighting.

## Encrypted application screenshots

`images/encrypted-feed-desktop.png` and `images/encrypted-feed-mobile.png` were captured from the built encrypted app on 6 October 2026. Fictional accounts imported and deliberately shared the existing album illustration, then exchanged a post, comment and reaction through actual encrypted rooms. The mobile capture uses a 390-pixel viewport. No real member content, credentials or recovery material appears. The older `feed-desktop.png` and `feed-mobile.png` remain v0.1 screenshots.

## Standalone sample screenshot

`images/local-book-desktop.png` was captured from the built local reader on 8 October 2026 at 1440 pixels wide. It shows only the bundled fictional Alex Rowan collection and the generated lakeside image described above. No archive, member account, browser profile or private information was supplied.
