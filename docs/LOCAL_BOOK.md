# Open a book on this device

[Open the fictional sample](https://app.cleanbookface.org/book.html), or use the [local preview instructions](../encrypted-client/README.md#try-the-standalone-local-book) to run a copy on your own device. The sample needs no account, invitation, storage home or contacts. Search for a memory, browse a type of record and open a photograph.

The sample is an archive reader. It does not contact friends, create a circle or demonstrate a real encrypted conversation. [Joining a circle](ENCRYPTED_GETTING_STARTED.md) is a separate choice.

## Open files

The same reader can open supported Facebook downloads requested in **JSON format and supplied as ZIP files**, portable Clean Bookface ZIP archives and older v0.1 account-export ZIPs. Loose JSON files and HTML-format downloads are not supported.

1. Choose **Open my archive** and select the ZIP parts together. Keep their contents and filenames intact.
2. Read the import report and check dates, photographs and any skipped items. Unsupported categories are reported.
3. Use search and the record categories to look around. **Export book** downloads a separate portable ZIP; **Clear book** clears this page.

This remains preview software. Use only the fictional sample and synthetic fixtures while independent human security, accessibility and usability review is unfinished. Real-export compatibility is not yet qualified. Opening a file here does not delete anything at Facebook.

- **Nothing is uploaded by the reader.** It reads your selected files on this device and keeps the opened collection in this page's memory. It does not use browser storage to save a collection or ask for a password. Memory-only reading is not encrypted persistence or encryption at rest.
- **Closing or reloading starts again.** Keep the original files somewhere private so you can reopen them. Clearing the book removes the page's collection; it does not delete files from your computer.
- **A download is a readable copy.** A portable export contains the records and attachments the reader understood. It is not encrypted and does not replace the original download, including unsupported items.
- **The software publisher still matters.** Your browser downloads this app from its publisher. Someone who replaces that code could change its behavior. This mode is not a guarantee against compromised browsers, extensions or devices.

## Practical limits

The local reader accepts up to eight selected files, 256 MiB of combined compressed input, 512 MiB expanded data and 50,000 records. Each attachment must fit the 64 MiB entry limit, and a JSON file must fit the 16 MiB limit. These are refusal limits, not a promise that every phone can comfortably open the largest allowed book. Use a desktop browser for larger collections. The hosted encrypted importer has different limits and behavior.

Search, filters and chronological sorting work within the opened collection. Only a bounded page of records is displayed at once. PNG, JPEG and WebP previews must pass header validation and stay within 16 MiB of encoded bytes and 8 million pixels per photo, with a 24 million pixel budget per displayed page. These checks happen before decoding. Supported raster photographs open from the selected archive; imported URLs, scripts and HTML are not executed. Large or unsupported image previews are skipped while their original attachments remain in the portable export if successfully imported. Preview refusal does not resize or strip those originals; archive import limits still apply. Imported conversations and friend records have no sharing action.

If an import fails, the previous book stays available. Cancel a pending import or clear the book when you want to stop. Keep the page open until a requested export finishes.

## Help improve it

Use the sample or a tiny made-up archive when [reporting a problem](https://github.com/Dynobit/clean-bookface/issues). Tell us the browser, what you tried and what happened. Never attach a personal archive or private screenshot. Questions and first-visit feedback belong in [Discussions](https://github.com/Dynobit/clean-bookface/discussions); suspected security failures use the [private reporting route](../SECURITY.md).

[Five small contributor tasks](CONTRIBUTOR_TASKS.md) include browser compatibility, accessibility and a first-visit walkthrough. Automated tests do not complete those human reviews.
