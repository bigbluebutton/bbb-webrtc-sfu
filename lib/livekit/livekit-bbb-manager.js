'use strict';

const C = require('../bbb/messages/Constants.js');
const Messaging = require('../bbb/messages/Messaging.js');
const Logger = require('../common/logger.js');
const {
  isUsingAudioBridge,
  getUserIdFromParticipant,
  getParticipantMetadata,
  getParticipantNameFromEvent,
  isFrontendParticipant,
  isWebUser,
  validBBBMetadata,
  trackSourceToString,
} = require('./utils.js');
const { getCamBroadcastPermission } = require('../video/video-perm-utils.js');
const { getScreenBroadcastPermission } = require('../screenshare/screen-perm-utils.js');

/**
 * Manages the business logic for synchronizing LiveKit state with BigBlueButton.
 * It consumes normalized events from the LiveKitEventGateway and translates them
 * into specific BigBlueButton Redis messages.
 */
class LiveKitBbbManager {
  /**
   * @param {import('livekit-server-sdk')} liveKitSDK - The LiveKit Server SDK.
   * @param {import('livekit-server-sdk').RoomServiceClient} roomServiceClient - The LiveKit RoomServiceClient.
   * @param {import('../bbb/messages/Messaging')} bbbGW - The BigBlueButton message gateway.
   * @param {Map<string, object>} roomMap - A map of active LiveKit rooms.
   * @param {object} [options]
   * @param {boolean} [options.publishMicrophonePermCheck=false] - Whether to perform permission checks for microphone publishing.
   * @param {boolean} [options.publishCameraPermCheck=false] - Whether to perform permission checks for camera publishing.
   * @param {boolean} [options.publishScreenPermCheck=false] - Whether to perform permission checks for screen sharing.
   */
  constructor(
    liveKitSDK,
    roomServiceClient,
    bbbGW,
    roomMap, {
      publishMicrophonePermCheck,
      publishCameraPermCheck,
      publishScreenPermCheck,
    } = {},
  ) {
    this._liveKitSDK = liveKitSDK;
    this._roomServiceClient = roomServiceClient;
    this._bbbGW = bbbGW;
    this._roomMap = roomMap;
    this._permissionChecks = {
      publishMicrophone: publishMicrophonePermCheck,
      publishCamera: publishCameraPermCheck,
      publishScreen: publishScreenPermCheck,
    };
  }

  /**
   * Retrieves a room from the internal map.
   * @param {string} meetingId - The meeting ID (room name).
   * @returns {object|undefined} The room object or undefined if not found.
   * @private
   */
  _getRoom(meetingId) {
    return this._roomMap.get(meetingId);
  }

  /**
   * Handles the 'participant_joined' event from LiveKit.
   * The side-effect in BBB is notifying that a new participant has joined
   * the voice conference.
   * If the participant is not a web user, it also updates the participant's
   * metadata in LiveKit so that it matches the BBB's participant metadata.
   * @param {object} event - The normalized participant_joined event.
   * @returns {Promise<void>}
   */
  async handleParticipantJoined(event) {
    try {
      Logger.debug('LiveKitBbbManager: handleParticipantJoined', { event });
      const { identity, kind } = event.participant;
      const webUser = isWebUser(identity);
      const userId = getUserIdFromParticipant(event.participant);
      const hidden = event.participant?.permission?.hidden;
      const roomName = event?.room?.name;
      const room = this._getRoom(roomName);
      let metadata = await getParticipantMetadata(event, this._roomServiceClient, { room });

      if (!isFrontendParticipant(kind, hidden, metadata)
        || (webUser && !isUsingAudioBridge(metadata))) {
        Logger.debug('LiveKitBbbManager: handleParticipantJoined ignored', {
          userId,
          kind,
          metadata,
        });
        return;
      }

      if (!webUser && !validBBBMetadata(metadata)) {
        Logger.debug('LiveKitBbbManager: updating participant metadata', {
          identity,
          userId,
          roomName,
          metadata,
        });
        await this._roomServiceClient.updateParticipant(
          event?.room?.name,
          identity, {
            metadata: JSON.stringify({
              ...metadata,
            }),
          },
        );
      }

      const tracks = event.participant?.tracks;
      const microphoneTrack = tracks.find((track) =>
        trackSourceToString(this._liveKitSDK, track.source) === 'microphone'
      );
      const micSidSource = microphoneTrack?.sid || event?.participant?.sid;
      const micSidInt = micSidSource.slice(-6);
      const participantName = getParticipantNameFromEvent(event);
      const callerIdNum = `${userId}_${micSidInt}`;

      this._bbbGW.publish(Messaging.generateUserJoinedVoiceConfEvtMsg(
        metadata?.voiceConf || metadata?.bbb_voiceConf,
        event.participant?.sid, // voiceUserId
        userId, // intId
        participantName, // callerIdName
        callerIdNum, // callerIdNum
        microphoneTrack ? microphoneTrack.muted : true, // muted
        false, // talking
        'livekit', // callingWith
        false, // hold - not used, FreeSWITCH/mediasoup only thing
        event.participant?.sid, // uuid
      ), C.FROM_VOICE_CONF);
    } catch (error) {
      Logger.error('LiveKitBbbManager: error handling participant joined event', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles the 'participant_left' event from LiveKit.
   * The side-effect in BBB is removing the participant from voice conference
   * and notifying the frontend that the participant has left.
   * @param {object} event - The normalized participant_left event.
   * @returns {Promise<void>}
   */
  async handleParticipantLeft(event) {
    try {
      Logger.debug('LiveKitBbbManager: handleParticipantLeft', { event });
      const { identity, kind } = event.participant;
      const webUser = isWebUser(identity);
      const userId = getUserIdFromParticipant(event.participant);
      const hidden = event.participant?.permission?.hidden;
      const roomName = event?.room?.name;
      const room = this._getRoom(roomName);
      const participantMetadata = await getParticipantMetadata(
        event,
        this._roomServiceClient,
        { room },
      );
      const usingAudioBridge = isUsingAudioBridge(participantMetadata);

      if (!isFrontendParticipant(kind, hidden, participantMetadata)) {
        Logger.debug('LiveKitBbbManager: handleParticipantLeft ignored', {
          identity,
          userId,
          kind,
          participantMetadata,
          usingAudioBridge,
          webUser,
        });
        return;
      }

      if (usingAudioBridge || !webUser) {
        const voiceConf = participantMetadata?.voiceConf || participantMetadata?.bbb_voiceConf;
        this._bbbGW.publish(Messaging.generateUserLeftVoiceConfEvtMsg(
          voiceConf, // voiceConf
          event.participant?.sid, // voiceUserId
        ), C.FROM_VOICE_CONF);
      }

      this._bbbGW.publish(Messaging.generateLiveKitParticipantLeftEvtMsg(
        event.room?.name, // meetingId
        userId, // userId
        roomName, // roomName
      ), C.TO_AKKA_APPS);
    } catch (error) {
      Logger.error('LiveKitBbbManager: handleParticipantLeft ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles microphone track publication events.
   * The side-effect in BBB is updating the participant's mute state.
   * @param {object} event - The normalized track_published event.
   * @param {object} participantMetadata - The parsed metadata of the participant.
   * @private
   */
  _handleMicrophoneTrackPublished(event, participantMetadata) {
    try {
      const voiceConf = participantMetadata?.voiceConf || participantMetadata?.bbb_voiceConf;

      this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
        voiceConf,
        event.participant?.sid, // voiceUserId
        event.track?.muted,
      ), C.FROM_VOICE_CONF);
    } catch (error) {
      Logger.error('LiveKitBbbManager: _handleMicrophoneTrackPublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles camera track publication events.
   * The side-effect in BBB is notifying that a new camera has been published.
   * @param {object} event - The normalized track_published event.
   * @returns {Promise<void>}
   * @private
   */
  async _handleCameraTrackPublished(event) {
    Logger.debug('LiveKitBbbManager: _handleCameraTrackPublished', { event });

    try {
      const participantIdentity = event.participant?.identity;

      if (isWebUser(participantIdentity)) return;

      const userId = getUserIdFromParticipant(event.participant);
      const streamId = `${userId}_${event.track?.sid}`;

      if (this._permissionChecks.publishCamera) {
        const roomName = event.room.name;
        const participantSid = event.participant.sid;

        await getCamBroadcastPermission(
          this._bbbGW,
          roomName,
          userId,
          streamId,
          participantSid,
        );
      }

      this._bbbGW.publish(Messaging.generateUserBroadcastCamStartMsg(
        event.room?.name,
        userId,
        streamId,
        'camera', // contentType
        false, // hasAudio
      ), C.FROM_SFU);
    } catch (error) {
      Logger.error('LiveKitBbbManager: _handleCameraTrackPublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles screen share track publication events.
   * The side-effect in BBB is notifying that a new screen share has been published.
   * @param {object} event - The normalized track_published event.
   * @param {object} participantMetadata - The parsed metadata of the participant.
   * @returns {Promise<void>}
   * @private
   */
  async _handleScreenShareTrackPublished(event, participantMetadata) {
    Logger.debug('LiveKitBbbManager: _handleScreenShareTrackPublished', { event });

    try {
      const { track } = event;
      const { name, sid } = track;
      const { voiceConf } = participantMetadata;
      const userId = getUserIdFromParticipant(event.participant);
      const streamId = sid;
      const timestamp = Math.floor(new Date());
      const contentType = name.includes('camera') ? 'camera' : 'screenshare';

      if (this._permissionChecks.publishScreen) {
        const roomName = event.room.name;
        const participantSid = event.participant.sid;

        await getScreenBroadcastPermission(
          this._bbbGW,
          roomName,
          voiceConf,
          userId,
          participantSid
        );
      }

      const dsrbstam = Messaging.generateScreenshareRTMPBroadcastStartedEvent2x(
        voiceConf,
        voiceConf,
        streamId,
        0, // width
        0, // height
        timestamp, {
          hasAudio: true,
          contentType,
          userId,
        }
      );
      this._bbbGW.publish(dsrbstam, C.TO_AKKA_APPS);
    } catch (error) {
      Logger.error("LiveKitBbbManager: Screenshare won't be broadcasted", {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
        participantMetadata,
      });
    }
  }

  /**
   * Handles the 'track_published' event from LiveKit.
   * Delegates to specific handlers based on the track source (microphone, camera, etc.).
   * @param {object} event - The normalized track_published event.
   * @returns {Promise<void>}
   */
  async handleTrackPublished(event) {
    Logger.trace('LiveKitBbbManager: handleTrackPublished', { event });

    try {
      const roomName = event?.room?.name;
      const room = this._getRoom(roomName);
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, { room });
      const trackSource = trackSourceToString(this._liveKitSDK, event.track?.source);

      switch (trackSource) {
        case 'microphone':
          this._handleMicrophoneTrackPublished(event, participantMetadata);
          break;
        case 'camera':
          this._handleCameraTrackPublished(event, participantMetadata);
          break;
        case 'screen_share':
          this._handleScreenShareTrackPublished(event, participantMetadata);
          break;
        default:
          Logger.warn('LiveKitBbbManager: handleTrackPublished: unknown track source', {
            trackSource,
            event,
          });
      }
    } catch (error) {
      Logger.error('LiveKitBbbManager: handleTrackPublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles microphone track unpublication events.
   * The side-effect in BBB is notifying that a microphone has been muted.
   * @param {object} event - The normalized track_unpublished event.
   * @param {object} participantMetadata - The parsed metadata of the participant.
   * @private
   */
  _handleMicrophoneTrackUnpublished(event, participantMetadata) {
    const voiceConf = participantMetadata?.voiceConf || participantMetadata?.bbb_voiceConf;
    this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
      voiceConf,
      event.participant?.sid,
      true,
    ), C.FROM_VOICE_CONF);
  }

  /**
   * Notifies BBB that a camera broadcast has stopped.
   * @param {string} meetingId - The meeting ID.
   * @param {string} userId - The user ID.
   * @param {string} streamId - The stream ID.
   * @private
   */
  _sendCamBroadcastStoppedInSfuEvtMsg (meetingId, userId, streamId) {
    const msg = Messaging.generateCamBroadcastStoppedInSfuEvtMsg(
      meetingId, userId, streamId,
    );
    this._bbbGW.publish(msg, C.FROM_SFU);
  }

  /**
   * Handles camera track unpublication events.
   * The side-effect in BBB is notifying that a camera broadcast has stopped.
   * @param {object} event - The normalized track_unpublished event.
   * @private
   */
  _handleCameraTrackUnpublished(event) {
    try {
      let streamId = null;
      const userId = getUserIdFromParticipant(event.participant);
      const { name } = event.track;

      if (!name || !name.includes(userId)) {
        streamId = event.track?.sid;
      } else {
        streamId = name;
      }

      this._sendCamBroadcastStoppedInSfuEvtMsg(event.room?.name, userId, streamId);
    } catch (error) {
      Logger.error('LiveKitBbbManager: _handleCameraTrackUnpublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles screen share track unpublication events.
   * The side-effect in BBB is notifying that a screen share has been stopped.
   * @param {object} event - The normalized track_unpublished event.
   * @param {object} participantMetadata - The parsed metadata of the participant.
   * @private
   */
  _handleScreenShareTrackUnpublished(event, participantMetadata) {
    try {
      const { voiceConf } = participantMetadata;
      const { sid } = event.track;
      const userId = getUserIdFromParticipant(event.participant);
      const timestamp = Math.floor(new Date());
      const dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(
        voiceConf,
        voiceConf,
        sid,
        0, // width
        0, // height
        timestamp, {
          userId,
        },
      );
      this._bbbGW.publish(dsrstom, C.TO_AKKA_APPS);
    } catch (error) {
      Logger.error('LiveKitBbbManager: _handleScreenShareTrackUnpublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles the 'track_unpublished' event from LiveKit.
   * Delegates to specific handlers based on the track source.
   * @param {object} event - The normalized track_unpublished event.
   * @returns {Promise<void>}
   */
  async handleTrackUnpublished(event) {
    try {
      const roomName = event?.room?.name;
      const room = this._getRoom(roomName);
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, { room });
      const trackSource = trackSourceToString(this._liveKitSDK, event.track?.source);

      switch (trackSource) {
        case 'microphone':
          this._handleMicrophoneTrackUnpublished(event, participantMetadata);
          break;
        case 'camera':
          this._handleCameraTrackUnpublished(event, participantMetadata);
          break;
        case 'screen_share':
        case 'screen_share_audio':
          this._handleScreenShareTrackUnpublished(event, participantMetadata);
          break;
        default:
          Logger.warn('LiveKitBbbManager: handleTrackUnpublished: unknown track source', {
            trackSource,
            event,
          });
      }
    } catch (error) {
      Logger.error('LiveKitBbbManager: handleTrackUnpublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }
}

module.exports = LiveKitBbbManager;
