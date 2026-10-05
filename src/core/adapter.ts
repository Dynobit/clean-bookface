import type { Core } from '../core.js';
import type { Archive } from '../archive.js';
import type { FederationAdapter } from '../federation/types.js';

/** HTTP signatures authenticate peers; Core remains the authority for each grant. */
export function federationAdapter(
  core: Core,
  archive: Archive,
  sharingAllowed: () => boolean = () => true,
): FederationAdapter {
  return {
    localActor: (username) => core.localActor(username),
    pendingEvents: (limit, afterId) => core.pendingEvents(limit, afterId),
    outboundEvent: (id) => core.outboundEvent(id),
    ackEvent: (id) => core.ackEvent(id),
    receiveActivity: (recipient, actor, activity) =>
      core.receiveActivity(recipient, actor, activity),
    federationObject: (url, actor) => (sharingAllowed() ? core.federationObject(url, actor) : null),
    federationMedia: (id, actor) => {
      if (!sharingAllowed() || !core.sharedMediaAllowed(id, actor)) return null;
      const owner = core.store.db
        .prepare(
          "SELECT owner_id FROM archive_media WHERE id=? AND purpose='shared' AND pending_job IS NULL",
        )
        .get(id) as { owner_id: string } | undefined;
      if (!owner) return null;
      const media = archive.media(owner.owner_id, id);
      return media?.purpose === 'shared' ? { path: media.path, mime: media.mime } : null;
    },
    sharingAllowed,
  };
}
