'use strict';

const express = require('express');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../common/logger.js');
const Messaging = require('../bbb/messages/Messaging.js');
const C = require('../bbb/messages/Constants.js');
const {
  getParticipantMetadata,
  getParticipantNameFromEvent,
  getUserIdFromParticipant,
  isFrontendParticipant,
  isUsingAudioBridge,
  isWebUser,
  validBBBMetadata,
} = require('./utils.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');
const { getCamBroadcastPermission } = require('../video/video-perm-utils.js');
const { getScreenBroadcastPermission } = require('../screenshare/screen-perm-utils.js');

class LiveKitWebhookReceiver extends EventEmitter {
  constructor(
    liveKitSDK,
    liveKitRTC,
    roomServiceClient,
    host,
    key,
    secret,
    port,
    path,
    bbbGW, {
      unpublishOnMute,
      roomMap = null,
      permissionChecks: {
        publishMicrophone = false,
        publishCamera = false,
        publishScreen = false,
      },
    } = {},
  ) {
    super();

    if (!liveKitSDK || !roomServiceClient || !key || !secret || !path || !port) {
      throw new Error('LiveKitWebhookReceiver: liveKitSDK, RSC, key, secret, port, and path are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._liveKitRTC = liveKitRTC;
    this._roomServiceClient = roomServiceClient;
    this._bbbGW = bbbGW;
    this._unpublishOnMute = unpublishOnMute;
    this._roomMap = roomMap;
    this._permissionChecks = {
      publishMicrophone,
      publishCamera,
      publishScreen,
    };

    this.receiver = new this._liveKitSDK.WebhookReceiver(key, secret);
    this.host = host;
    this.key = key;
    this.secret = secret;
    this.path = path;
    this.port = port;
  }

  init() {
    if (this.app) return;

    this.app = express();
    this.app.use(express.raw({ type: 'application/webhook+json' }));

    this.app.post(this.path, async (req, res) => {

      try {
        const event = await this.receiver.receive(req.body, req.get('Authorization'));
        await this._handleEvent(event);
        res.status(200).send('OK');
      } catch (error) {
        Logger.error('LiveKitWebhookReceiver: error handling event', error);
        if (error?.message === "authorization header is empty"
          || error?.message === "sha256 checksum of body does not match"
          || error?.type === "JWSSignatureVerificationFailed") {
          res.status(401).send('Unauthorized');
          return;
        }

        res.status(500).send(`Error: ${error.message}`);
      }
    });

    this._server = this.app.listen(this.port, () => {
      Logger.info(`LiveKitWebhookReceiver listening at http://localhost:${this.port}`, {
        path: this.path,
        port: this.port,
      });
    });
  }

  async _handleParticipantJoined(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleParticipantJoined', { event });
    const { identity, kind } = event.participant;
    const webUser = isWebUser(identity);
    const userId = getUserIdFromParticipant(event.participant);
    const hidden = event.participant?.permission?.hidden;
    const roomName = event?.room?.name;
    const room = (this._roomMap && roomName) ? this._roomMap.get(roomName) : null;
    let metadata = await getParticipantMetadata(event, this._roomServiceClient, { room });

    if (!isFrontendParticipant(kind, hidden, metadata)
      || (webUser && !isUsingAudioBridge(metadata))) {
      Logger.debug('LiveKitWebhookReceiver: _handleParticipantJoined ignored', {
        userId,
        kind,
        metadata,
      });
      return;
    }

    if (!webUser && !validBBBMetadata(metadata)) {
      Logger.debug('LiveKitWebhookReceiver: updating participant metadata', {
        identity,
        userId,
        roomName,
        metadata,
      });
      // Update participant metadata with room metadata
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
      this._liveKitSDK.trackSourceToString(track.source) === 'microphone'
    );
    const micSidSource = microphoneTrack?.sid || event?.participant?.sid;
    const micSidInt = micSidSource.slice(-6);
    const participantName = getParticipantNameFromEvent(event);
    const callerIdNum = `${userId}_${micSidInt}-bbbID-${participantName}`;

    this._bbbGW.publish(Messaging.generateUserJoinedVoiceConfEvtMsg(
      metadata?.voiceConf || metadata?.bbb_voiceConf,
      event.participant?.sid, // voiceUserId
      userId, // intId
      participantName, // callerIdName
      callerIdNum, // callerIdNum
      microphoneTrack ? microphoneTrack.muted : true, // muted
      false, // talking
      'livekit', // callingWith
      false, // hold - not used
      event.participant?.sid, // uuid
    ), C.FROM_VOICE_CONF);
  }

  async _handleParticipantLeft(event) {
    try {
      Logger.debug('LiveKitWebhookReceiver: _handleParticipantLeft', { event });
      const { identity, kind } = event.participant;
      const webUser = isWebUser(identity);
      const userId = getUserIdFromParticipant(event.participant);
      const hidden = event.participant?.permission?.hidden;
      const roomName = event?.room?.name;
      const room = (this._roomMap && roomName) ? this._roomMap.get(roomName) : null;
      const participantMetadata = await getParticipantMetadata(
        event,
        this._roomServiceClient,
        { room },
      );
      const usingAudioBridge = isUsingAudioBridge(participantMetadata);

      if (!isFrontendParticipant(kind, hidden, participantMetadata)) {
        Logger.debug('LiveKitWebhookReceiver: _handleParticipantLeft ignored', {
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
      ), C.TO_AKKA_APPS);
    } catch (error) {
      Logger.error('LiveKitWebhookReceiver: _handleParticipantLeft ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  _handleMicrophoneTrackPublished(event, participantMetadata) {
    try {
      const voiceConf = participantMetadata?.voiceConf || participantMetadata?.bbb_voiceConf;

      this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
        voiceConf,
        event.participant?.sid, // voiceUserId
        event.track?.muted,
      ), C.FROM_VOICE_CONF);
    } catch (error) {
      const parsedError = !(error instanceof Error)
        ? new Error(error?.reason || error?.code || 'Unknown error')
        : error;

      Logger.error('LiveKitWebhookReceiver: _handleMicrophoneTrackPublished ERROR', {
        errorMessage: parsedError.message,
        errorStack: parsedError.stack,
        event,
      });
      PrometheusAgent.increment(SFULK_NAMES.TRACK_PUBLISH_FAILURES, {
        error: parsedError.message,
        source: 'microphone',
      });
    }
  }

  async _handleCameraTrackPublished(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleCameraTrackPublished', { event });

    try {
      const participantIdentity = event.participant?.identity;

      if (isWebUser(participantIdentity)) return;

      const userId = getUserIdFromParticipant(event.participant);
      const streamId = `${userId}_${event.track?.sid}`;

      if (this._permissionChecks.publishCamera) {
        const roomName = event.room.name;
        const participantSid = event.participant.sid;

        // Throws SFU_UNAUTHORIZED if not allowed
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
      const parsedError = !(error instanceof Error)
        ? new Error(error?.reason || error?.code || 'Unknown error')
        : error;

      Logger.error('LiveKitWebhookReceiver: _handleCameraTrackPublished ERROR', {
        errorMessage: parsedError.message,
        errorStack: parsedError.stack,
        event,
      });
      PrometheusAgent.increment(SFULK_NAMES.TRACK_PUBLISH_FAILURES, {
        error: parsedError.message,
        source: 'camera',
      });
    }
  }

  async _handleScreenShareTrackPublished(event, participantMetadata) {
    Logger.debug('LiveKitWebhookReceiver: _handleScreenShareTrackPublished', { event });

    try {
      const { track } = event;
      const { name, sid, width, height } = track;
      const { voiceConf } = participantMetadata;
      const userId = getUserIdFromParticipant(event.participant);
      const streamId = sid;
      const timestamp = Math.floor(new Date());
      const contentType = name.includes('camera') ? 'camera' : 'screenshare';

      if (this._permissionChecks.publishScreen) {
        const roomName = event.room.name;
        const participantSid = event.participant.sid;

        // Throws SFU_UNAUTHORIZED if not allowed
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
        width,
        height,
        timestamp, {
          hasAudio: true,
          contentType,
          userId,
        }
      );
      this._bbbGW.publish(dsrbstam, C.TO_AKKA_APPS);
      Logger.debug("LiveKitWebhookReceiver: Sent startRtmpBroadcast", {
        event,
        participantMetadata,
      })
    } catch (error) {
      const parsedError = !(error instanceof Error)
        ? new Error(error?.reason || error?.code || 'Unknown error')
        : error;

      Logger.error("LiveKitWebhookReceiver: Screenshare won't be broadcasted", {
        errorMessage: parsedError.message,
        errorStack: parsedError.stack,
        event,
        participantMetadata,
      });
      PrometheusAgent.increment(SFULK_NAMES.TRACK_PUBLISH_FAILURES, {
        error: parsedError.message,
        source: 'screen_share',
      });
    }
  }

  async _handleTrackPublished(event) {
    Logger.trace('LiveKitWebhookReceiver: _handleTrackPublished', { event });

    try {
      const roomName = event?.room?.name;
      const room = (this._roomMap && roomName) ? this._roomMap.get(roomName) : null;
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, { room });
      const trackSource = this._liveKitSDK.trackSourceToString(event.track?.source);

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
          Logger.warn('LiveKitWebhookReceiver: _handleTrackPublished: unknown track source', {
            trackSource,
            event,
          });
      }
    } catch (error) {
      const parsedError = !(error instanceof Error) ?
        new Error(error?.reason || error?.code || 'Unknown error')
        : error;

      Logger.error('LiveKitWebhookReceiver: _handleTrackPublished ERROR', {
        errorMessage: parsedError.message,
        errorStack: parsedError.stack,
        event,
      });
      PrometheusAgent.increment(SFULK_NAMES.TRACK_PUBLISH_FAILURES, {
        error: parsedError.message,
        // Label source raw as trackSourceToString might fail as well
        source: event?.track?.source || 'unknown',
      });
    }
  }

  _handleMicrophoneTrackUnpublished(event, participantMetadata) {
    const voiceConf = participantMetadata?.voiceConf || participantMetadata?.bbb_voiceConf;

    Logger.debug('LiveKitWebhookReceiver: _handleMicrophoneTrackUnpublished', { event });
    this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
      voiceConf, // voiceConf
      event.participant?.sid, // voiceUserId
      true, // muted
    ), C.FROM_VOICE_CONF);
  }

  sendCamBroadcastStoppedInSfuEvtMsg (meetingId, userId, streamId) {
    const msg = Messaging.generateCamBroadcastStoppedInSfuEvtMsg(
      meetingId, userId, streamId,
    );

    this._bbbGW.publish(msg, C.FROM_SFU);
  }

  _handleCameraTrackUnpublished(event, participantMetadata) {
    Logger.debug('LiveKitWebhookReceiver: _handleCameraTrackUnpublished', { event, participantMetadata});

    try {
      let streamId = null;
      const userId = getUserIdFromParticipant(event.participant);
      const { name } = event.track;

      // If the track name does not contain the user's identity,
      // then it's tentatively an external source track. Stream IDs in that
      // case should be the track's SID.
      if (!name || !name.includes(userId)) {
        streamId = event.track?.sid;
      } else {
        streamId = name;
      }

      this.sendCamBroadcastStoppedInSfuEvtMsg(event.room?.name, userId, streamId);
    } catch (error) {
      Logger.error('LiveKitWebhookReceiver: _handleCameraTrackUnpublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  _handleScreenShareTrackUnpublished(event, participantMetadata) {
    Logger.debug('LiveKitWebhookReceiver: _handleScreenShareTrackUnpublished', {
      event,
      participantMetadata,
    });

    try {
      const { voiceConf } = participantMetadata;
      const { sid, width, height } = event.track;
      const userId = getUserIdFromParticipant(event.participant);
      const timestamp = Math.floor(new Date());
      const dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(
        voiceConf,
        voiceConf,
        sid,
        width,
        height,
        timestamp, {
          userId,
        },
      );

      this._bbbGW.publish(dsrstom, C.TO_AKKA_APPS);
    } catch (error) {
      Logger.error('LiveKitWebhookReceiver: _handleScreenShareTrackUnpublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  async _handleTrackUnpublished(event) {
    Logger.trace('LiveKitWebhookReceiver: _handleTrackUnpublished', { event });

    try {
      const roomName = event?.room?.name;
      const room = (this._roomMap && roomName) ? this._roomMap.get(roomName) : null;
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, { room });
      const trackSource = this._liveKitSDK.trackSourceToString(event.track?.source);

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
          Logger.warn('LiveKitWebhookReceiver: _handleTrackUnpublished: unknown track source', {
            trackSource,
            event,
          });
      }
    } catch (error) {
      Logger.error('LiveKitWebhookReceiver: _handleTrackUnpublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }
  }

  async _handleRoomStarted(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleRoomStarted', { event });
  }

  _handleEvent(webhookEvent) {
    // See: https://docs.liveKit.io/realtime/server/webhooks/#Events
    // one of:
    //   room_started,
    //   room_finished,
    //   participant_joined,
    //   participant_left,
    //   track_published,
    //   track_unpublished,
    //   egress_started,
    //   egress_updated,
    //   egress_ended,
    //   ingress_started,
    //   ingress_ended
    this.emit('webhookEvent', webhookEvent);
    this.emit(webhookEvent?.event, webhookEvent);

    switch (webhookEvent?.event) {
      case 'room_started':
        this._handleRoomStarted(webhookEvent);
        break;
      case 'participant_joined':
        this._handleParticipantJoined(webhookEvent);
        break;
      case 'participant_left':
        this._handleParticipantLeft(webhookEvent);
        break;
      case 'track_published':
        this._handleTrackPublished(webhookEvent);
        break;
      case 'track_unpublished':
        this._handleTrackUnpublished(webhookEvent);
        break;
      default:
        Logger.debug(`LiveKitWebhookReceiver: unhandled event ${webhookEvent?.event}`, { webhookEvent});
    }

    return;
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
      this.app = null;
    }

    Logger.info('LiveKitWebhookReceiver stopped');
  }
}

module.exports = LiveKitWebhookReceiver;
