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
    Logger.debug('LiveKitWebhookReceiver: _parseLiveKitMetadata: error parsing metadata', {
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

const isVoiceUser = (identity) => {
  return identity?.startsWith("v_");
}

const isLkBBBSipUser = (identity) => {
  return identity?.startsWith("v_sip_");
}

const getParticipantMetadata = async (event, svcClient, options = {}) => {
  const { room } = options;
  const participantIdentity = event.participant?.identity;
  let participantMetadata = {};

  try {
    participantMetadata = parseLiveKitMetadata(event.participant);

    if (isMetadataEmpty(participantMetadata)) {
      const svcParticipant = await svcClient.getParticipant(
        event.room?.name,
        participantIdentity,
      );
      participantMetadata = parseLiveKitMetadata(svcParticipant);
    }
  } catch (error) {
    Logger.debug('LiveKitWebhookReceiver: _getParticipantMetadata: error getting participant metadata', {
      errorMessage: error.message,
      errorStack: error.stack,
    });
    participantMetadata = {};
  }

  if (!isWebUser(participantIdentity)) {
    // This is not a BBB user. External users have a "v_" prefix.
    let roomMetadata = parseLiveKitMetadata(event?.room);

    if (isMetadataEmpty(roomMetadata) && room) {
      roomMetadata = parseLiveKitMetadata(room);
    }

    return {
      ...roomMetadata,
      ...participantMetadata,
    };
  }

  return participantMetadata;
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

const isFrontendParticipant = (kind, hidden, metadata = {}) => {
  return (kind === ParticipantInfo_Kind.STANDARD || kind === ParticipantInfo_Kind.SIP)
    && !metadata?.bbb_system
    && !hidden;
};

const isEgressParticipant = (kind) => {
  return (kind === ParticipantInfo_Kind.EGRESS);
};

const isSipParticipant = (kind) => {
  return (kind === ParticipantInfo_Kind.SIP);
};

const getUserIdFromParticipant = (participant) => {
  const { identity, sid } = participant;
  // If the participant is a web user, use the identity as the user ID as BBB
  // already guarantees its uniqueness.
  // Otherwise, use the sid as the user ID.
  const rawUserId = isWebUser(identity) ? identity : sid;

  return lkIdToBbbId(rawUserId);
};

// Maps a LiveKit participant ID to a BBB-formatteduser ID
const lkIdToBbbId = (lkId) => {
  // If LK ID is prefixed with w_, it is a web user. Return the LK ID.
  // If LK ID is prefixed with v_, it is an already BBB-formatted ext user.
  if (lkId.startsWith('w_') || lkId.startsWith('v_')) return lkId;

  // Otherwise, add v_ to the LK ID.
  return `v_${lkId}`;
};

// Maps a BBB user ID to a LiveKit participant ID that can either be its
// identity (for web users) or a sid (for external users).
const bbbIdToLKId = (bbbId) => {
  // BBB web users are prefixed with w_. These are the same in LK.
  // BBB external users are prefixed with v_. These do not have the v_ prefix in LK.
  // If the BBB ID is prefixed with v_, remove the v_ prefix.
  if (bbbId.startsWith('w_') || bbbId.startsWith('PA_')) return bbbId;
  if (bbbId.startsWith('v_')) return bbbId.slice(2);

  return `PA_${bbbId}`;
};

const isLKParticipantSid = (sid) => {
  return sid.startsWith('PA_');
};

const isValidSourceString = (source) => {
  return ['camera', 'screen_share', 'screen_share_audio', 'microphone'].includes(source);
};

module.exports = {
  getParticipantMetadata,
  getUserIdFromParticipant,
  isEgressParticipant,
  isFrontendParticipant,
  isLKParticipantSid,
  isMetadataEmpty,
  isUsingAudioBridge,
  isWebUser,
  parseLiveKitMetadata,
  probeBBBRecordingStatus,
  writeAudioRecordingStartEvent,
  writeAudioRecordingStopEvent,
  writeVideoRecordingEvent,
  lkIdToBbbId,
  bbbIdToLKId,
  isSipParticipant,
  isVoiceUser,
  isLkBBBSipUser,
  isValidSourceString,
};
