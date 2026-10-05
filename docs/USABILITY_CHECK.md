# Try it with five people

This is a short session for someone who has never used Clean Bookface. It is a test plan, not a claim that a study has happened. Invite people who do not run servers; include someone who uses a phone and someone who relies on keyboard or assistive navigation.

Use a disposable installation and fictional accounts. Follow the [development guide](DEVELOPMENT.md) to start the local demo. The facilitator handles setup and provides a test invitation and the synthetic archive from `tests/fixtures/synthetic/facebook`. Keep the demo on your own machine; its published password is not suitable for internet hosting.

Tell each participant: “We are testing the software, not you. Please say what you expect to happen. You can stop whenever you want.” Do not ask for a Facebook password, their own download, their real contacts, or a recording of personal accounts.

## Give these tasks one at a time

1. **Join.** Open the test invitation, create a fictional account and save the recovery codes. What do you think your host can see?
2. **Bring a memory home.** Find the getting-started instructions and import the provided fictional archive. Find its photo and private conversation. Who can see them now?
3. **Share with one friend.** Connect to the facilitator's fictional account, review a photo, and share it with that person. Check that importing alone did not publish it. Explain whether a new friend would automatically see an old post.
4. **Change your mind.** Stop sharing the photo, find the block/report controls, and explain what they can and cannot remove from somebody else's saved copies.
5. **Leave with your history.** Find export and account deletion. Download the test account, then explain the difference between deleting this account and deleting a Facebook account. Check that the instructions say to keep and verify a separate copy first.

Let people try before explaining. When help is needed, record the point of confusion and the exact assistance. Do not count a guided completion as an unassisted one. Stop any step that risks using real personal data.

## Keep the notes small and private

Use labels A–E instead of names. For each task, note completed, completed with help, or not completed; record the confusing words, control or screen. Check mobile overflow, visible keyboard focus, useful control labels and whether an error explains how to recover. Ask what the person expected, rather than whether they liked the design.

A privacy misunderstanding is a release issue even when the person eventually finds the right button. Fix the cause and retest the affected task. A five-person exercise cannot establish universal accessibility or archive compatibility; record its scope and obtain a separate accessibility review.

Publish only a consented, anonymous summary: date, build, task completion counts, fixes and remaining problems. Keep raw notes out of GitHub and do not invent participant results. Record actual evidence in the [release ledger](RELEASE.md).
