const { ParticipantInfo_Kind } = require('@livekit/protocol');
const Logger = require('../common/logger.js');
const C = require('../bbb/messages/Constants.js');
const Messaging = require('../bbb/messages/Messaging.js');

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

const isUsingAudioBridge = (metadata) => {
  return metadata?.bbb_audioBridge === 'livekit';
}

const isMetadataEmpty = (metadata) => {
  return !metadata || Object.keys(metadata).length === 0;
}

const isWebUser = (identity) => {
  return identity?.startsWith("w_");
}

const getParticipantMetadata = async (event, svcClient, options = {}) => {
  const { systemClientMap } = options;
  const participantIdentity = event.participant?.identity;
  let metadata = {};

  if (!isWebUser(participantIdentity)) {
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

const probeBBBRecordingStatus = (gateway, meetingId, userId) => {
  return new Promise((resolve) => {
    const onRecordingStatusReply = (payload) => {
      if (payload.requestedBy === userId) {
        Logger.info(`LiveKit: RecordingStatusReply for ${payload.requestedBy}`, payload);
        gateway.removeListener(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, onRecordingStatusReply)
        resolve(payload);
      }
    };

    gateway.on(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, onRecordingStatusReply)

    gateway.publish(
      Messaging.generateRecordingStatusRequestMessage(meetingId, userId),
      C.TO_AKKA_APPS,
    );
  });
};

const writeVideoRecordingEvent = (
  eventName,
  gateway,
  meetingId,
  filename,
  timestampHR,
  timestampUTC,
  userId,
) => {
  const event = Messaging.generateWebRTCShareEvent(
    eventName,
    meetingId,
    filename,
    timestampHR,
    timestampUTC,
    userId,
  );

  gateway.writeMeetingKey(meetingId, event, () => {
    Logger.info(`LiveKit: ${eventName} written`, { event });
  });
};

const writeAudioRecordingStartEvent = (
  gateway,
  meetingId,
  userId,
  filename,
  source,
  timestampHR,
  timestampUTC,
) => {
  const event = Messaging.generateAudioTrackPublishedEvent(
    meetingId,
    userId,
    filename,
    source,
    timestampHR,
    timestampUTC,
  );

  gateway.writeMeetingKey(meetingId, event, () => {
    Logger.info(`LiveKit: AudioTrackPublishedEvent written`, { event });
  });
}

const writeAudioRecordingStopEvent = (
  gateway,
  meetingId,
  userId,
  filename,
  source,
  timestampHR,
  timestampUTC,
) => {
  const event = Messaging.generateAudioTrackUnpublishedEvent(
    meetingId,
    userId,
    filename,
    source,
    timestampHR,
    timestampUTC,
  );

  gateway.writeMeetingKey(meetingId, event, () => {
    Logger.info(`LiveKit: AudioTrackUnpublishedEvent written`, { event });
  });
}

const isFrontendParticipant = (kind, metadata = {}) => {
  return (kind === ParticipantInfo_Kind.STANDARD || kind === ParticipantInfo_Kind.SIP)
    && !metadata?.bbb_system;
};

const isEgressParticipant = (kind) => {
  return (kind === ParticipantInfo_Kind.EGRESS);
};

module.exports = {
  getParticipantMetadata,
  isEgressParticipant,
  isFrontendParticipant,
  isMetadataEmpty,
  isUsingAudioBridge,
  isWebUser,
  parseLiveKitMetadata,
  probeBBBRecordingStatus,
  writeAudioRecordingStartEvent,
  writeAudioRecordingStopEvent,
  writeVideoRecordingEvent,
};
