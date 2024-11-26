const Logger = require('../common/logger.js');

const parseLiveKitMetadata = (metadataContainer = { metadata: {} }) => {
  if (isMetadataEmpty(metadataContainer?.metadata)) return {};

  try {
    const metadata = JSON.parse(metadataContainer.metadata);

    return metadata;
  } catch (error) {
    Logger.warn('LiveKitWebhookReceiver: _parseLiveKitMetadata: error parsing metadata', {
      metadataContainer,
      errorMessage: error.message,
      errorStack: error.stack,
    });

    return {};
  }
};

const isMetadataEmpty = (metadata) => {
  return !metadata || Object.keys(metadata).length === 0;
}

const getParticipantMetadata = async (event, svcClient, options = {}) => {
  const { systemClientMap } = options;
  const participantIdentity = event.participant?.identity;
  let metadata = {};

  if (!participantIdentity.startsWith("w_")) {
    // This is not a BBB user. External users have a "v_" prefix.
    metadata = parseLiveKitMetadata(event?.room);

    if (systemClientMap && isMetadataEmpty(metadata)) {
      const room = systemClientMap.get(event.room?.name);
      metadata = parseLiveKitMetadata(room);
    }
  } else {
    metadata = parseLiveKitMetadata(event.participant);

    if (isMetadataEmpty(metadata)) {
      const svcParticipant = await svcClient.getParticipant(
        event.room?.name,
        participantIdentity,
      );
      metadata = parseLiveKitMetadata(svcParticipant);
    }
  }

  return metadata;
};

module.exports = {
  getParticipantMetadata,
  isMetadataEmpty,
  parseLiveKitMetadata,
};
