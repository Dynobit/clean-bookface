# A new home for your memories

This guide is for the encrypted browser version. It is a preview: use made-up memories while independent security and usability reviews are still open. The older v0.1 app has different privacy limits and its own [getting-started guide](GETTING_STARTED.md).

## Join someone you know

1. **Ask a friend for an invitation.** They need to run a Clean Bookface storage home. There is no public directory or official free hosting service.
2. **Open the invitation in the trusted browser app.** Check its address before entering anything. Your storage home and the app that handles your keys should have different operators. The invitation fills in your home and single-use code.
3. **Choose your account and password.** You do not need GitHub, a terminal or a hosting account.
4. **Save your recovery kit somewhere private.** Keep a second copy away from this browser. Your password gets you into your account; the kit unlocks your memories if you lose your device. Your host cannot replace a lost kit. If you lose every kit and every browser holding your keys, your encrypted memories cannot be recovered.
5. **Open your book.** Write a post, or bring some old memories. Nothing from Facebook is required.

Only accept invitations from people you trust. Confirm the app address through a separate conversation with your friend before opening a sign-up link. An invitation is not proof that a host or an app publisher is trustworthy. Two domains on the same operator’s hosting account do not provide independent control.

## Bring your Facebook download

Facebook lets you request a copy of your information. Follow [the download instructions](GETTING_STARTED.md#1-ask-facebook-for-your-download), choose **JSON**, and keep **every ZIP part**. You can do this without leaving Facebook. Clean Bookface never needs your Facebook password.

Keep the original download and an independent backup. Then open **My memories** in the encrypted app and select all the ZIP parts together. Leave their names and contents as Facebook supplied them. The browser reads the files, encrypts small groups of memories, and saves them to your home.

Keep this tab open while it works. Progress says which parts have been saved and checked for recovery. You can stop after the current part. If the connection fails, select the same files again: already accepted parts are recognized. Do not throw away the originals after an incomplete import.

Read the warnings and check a few dates, photos and stories yourself. The app cannot know whether Facebook included everything you expected. Missing files and unsupported categories are reported; an HTML-only export is not supported. Videos and encrypted Messenger exports are not a promise of full Facebook compatibility.

The importer has safety limits: at most 64 files, 10 GiB of input and expanded ZIP data, 50,000 records per input, and 64 MiB per original attachment. These are refusal limits, not a promise that every phone can handle a download that large. Use a current desktop browser for large imports. [Measured tests and remaining limits](../encrypted-client/QUALIFICATION.md).

A large collection opens in manageable parts. Use **Search every saved import** to find a memory across them. Search happens in your browser. You can also open or download any saved part separately. A downloaded ZIP is readable, so keep it private.

## Share one thing with one friend

Exchange complete account names with your friend and accept the invitation in **Friends**. Use **Check identity** and compare the pictures over a call or in person. Matching pictures help you check that you have the right person; do not compare them through the host you are checking.

Choose a memory and select the friend who should receive a separate copy. Imported messages and friend-list records stay private. You can also write a new post and add up to four photos. Shared copies are resized and have original filenames, location and camera details removed. Your private originals are unchanged. Friends whose identities have not been checked cannot be selected. Each friend gets a separate conversation: a reply to one friend is not sent to everyone else who received the post.

You can comment, react, remove your comment or remove your shared copy. **Block** ends the friendship and prevents further sharing through the app. A friend may already have saved a copy; no software can make them forget it.

If a send fails, keep that browser and use its retry button. It shows who received the post and who is still waiting; retry sends only to those still waiting. Its waiting changes do not automatically move to another device. Signing out asks you to finish or stop them first.

## Move, recover or leave

- **New browser:** sign in and use your recovery kit. Check that your old memories open before removing the old browser.
- **Another home:** download every saved import and each conversation part from **My account**, join the new home and import them privately. This creates a new account identity; check your friends again. Friends, moderation history and unfinished sends are not transferred by an archive ZIP.
- **Moving from v0.1:** download your account export from the old app, then select that ZIP here. Records and original media are imported privately. Account settings and old friendships are not silently recreated. Verify the recovered copy before retiring the old one.
- **Interrupted setup:** reopen the same browser and enter the recovery kit you already saved. The app resumes using the same identity; it does not quietly replace it.
- **Memories that will not open:** available memories remain accessible. Use **My account → Use my recovery kit again** or retry the affected saved part. Never replace a recovery kit merely because one part failed.
- **Sign out:** the app checks key backup, ends the session and removes this device's local keys. An already-ended session can still be cleared after the key-loss warning. Keys that never reached your backup cannot be recovered with the kit, so keep the browser until you understand what is being removed. A connection failure keeps your keys so you can retry. If your book cannot open, the separate local-removal option explains what will be lost; it cannot end a session on an unreachable home. If another tab is using the account, close that tab first.
- **Close an account:** download every saved import and conversation part first, then use **My account → Close my account**. Enter your complete account name and password. Access ends and the home receives a profile-erasure request. Encrypted events, media and backups can remain until the host's retention policy removes them; ask the host about that policy. Shared copies may remain with friends.

You can keep Facebook, deactivate it or request deletion there. [Those are separate choices](GETTING_STARTED.md#6-decide-what-you-want-to-do-with-facebook). Importing here does not delete anything at Meta, and deleting Facebook does not delete this copy.

## If something goes wrong

Conversation downloads include earlier copies of posts and replies marked removed. Removing something from the feed does not erase that history. Keep these readable downloads private.

Do not post your archive, invitation, password or recovery kit on GitHub. Tell the host what action failed and the short message you saw. For a public bug report, use a made-up example.

If your home disappears, your own downloaded originals remain useful. A recovery kit alone cannot replace missing server data. That is why hosts need tested backups and members should keep their own exports.
