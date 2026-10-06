# Optional encrypted home

This is the next-release Matrix homeserver component. It does not change the live v0.1 service or turn its archive into end-to-end encrypted data.

Members join in a browser with an invitation. They do not need Docker, a provider account, or payment details. This folder is for the person hosting that home. Synapse stores encrypted conversation events and attachments; the browser handles encryption with the maintained Matrix SDK. Synapse also supports plaintext rooms for other Matrix clients; the encrypted browser must create and enforce encrypted rooms itself. Server operators can still see accounts, room membership, timing, IP addresses and other metadata. Password hashes and server-held metadata need protected backups. A malicious web host could also serve altered browser code.

The supplied home accepts single-use invitations that expire after one hour. Guests, public room publication, public federation, user-directory search, URL previews, identity-server lookup and usage reporting are disabled. Independent homes can opt into an exact reciprocal Matrix peer allowlist; see [the federation recipe](FEDERATION.md). The default remains closed. Protocol qualification and browser encryption qualification are separate; existing v0.1 federation is not reused.

Two hosts can improve recovery: one serves members, and the second keeps encrypted backups until it is needed. This implementation provides encrypted local or explicitly configured SFTP backups and a local standby drill, not automatic failover or zero downtime. Routine backups resume a previously running primary before uploading; keeping it stopped is an explicit restore-drill option. The SFTP interface requires qualification with the chosen second host. Both drill containers run on the same machine, so the drill does not prove protection from losing that machine. Keep the backup password somewhere separate from both hosts. Members must retain their own browser recovery material; a server backup cannot recreate missing client encryption keys.

Check [supported host architecture](ARCHITECTURE.md), then start with [the self-host installation guide](SELF_HOST.md) for automatic HTTPS, private invitation links, scheduled backup health and report review.

See [the operator guide](OPERATIONS.md) for installation, invitations and recovery, and [measured qualification](QUALIFICATION.md) for what has actually run. No public encrypted hosting service or hosted pilot is created by this component.
