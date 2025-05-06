'use strict';

const express = require('express');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../common/logger.js');
const Messaging = require('../bbb/messages/Messaging.js');
const C = require('../bbb/messages/Constants.js');
const {
  getParticipantMetadata,
  getUserIdFromParticipant,
  isFrontendParticipant,
  isUsingAudioBridge,
  isWebUser,
} = require('./utils.js');

const SYS_METADATA = JSON.stringify({
  bbb_system: true,
});

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
      rtcAgent,
      unpublishOnMute,
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
    this._systemClientMap = new Map();
    this._rtcAgent = rtcAgent;
    this._unpublishOnMute = unpublishOnMute;

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
    let metadata = await getParticipantMetadata(event, this._roomServiceClient, {
      systemClientMap: this._systemClientMap,
    });

    if (!isFrontendParticipant(kind, hidden, metadata)
      || (webUser && !isUsingAudioBridge(metadata))) {
      Logger.debug('LiveKitWebhookReceiver: _handleParticipantJoined ignored', {
        userId,
        kind,
        metadata,
      });
      return;
    }

    if (!webUser) {
      // Update participant metadata with room metadata
      await this._roomServiceClient.updateParticipant(
        event?.room?.name,
        identity,
        userId,
        JSON.stringify({
          ...metadata,
      }));
    }

    const tracks = event.participant?.tracks;
    const microphoneTrack = tracks.find((track) =>
      this._liveKitSDK.trackSourceToString(track.source) === 'microphone'
    );
    const micSidSource = microphoneTrack?.sid || event?.participant?.sid;
    const micSidInt = micSidSource.slice(-6);
    const participantName = event.participant?.name || identity;
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
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, {
        systemClientMap: this._systemClientMap,
      });
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
    const voiceConf = participantMetadata?.voiceConf || participantMetadata?.bbb_voiceConf;

    this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
      voiceConf,
      event.participant?.sid, // voiceUserId
      event.track?.muted,
    ), C.FROM_VOICE_CONF);
  }

  async _handleCameraTrackPublished(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleCameraTrackPublished', { event });
    const participantIdentity = event.participant?.identity;

    if (isWebUser(participantIdentity)) return;

    const userId = getUserIdFromParticipant(event.participant);
    const streamId = `${userId}_${event.track?.sid}`;

    this._bbbGW.publish(Messaging.generateUserBroadcastCamStartMsg(
      event.room?.name,
      userId,
      streamId,
      'camera', // contentType
      false, // hasAudio
    ), C.FROM_SFU);
  }

  _handleScreenShareTrackPublished(event, participantMetadata) {
    Logger.debug('LiveKitWebhookReceiver: _handleScreenShareTrackPublished', { event });

    try {
      const { track } = event;
      const { name, sid, width, height } = track;
      const { voiceConf } = participantMetadata;
      const streamId = sid;
      const timestamp = Math.floor(new Date());
      const contentType = name.includes('camera') ? 'camera' : 'screenshare';
      const dsrbstam = Messaging.generateScreenshareRTMPBroadcastStartedEvent2x(
        voiceConf,
        voiceConf,
        streamId,
        width,
        height,
        timestamp, {
          hasAudio: true,
          contentType,
        }
      );
      this._bbbGW.publish(dsrbstam, C.TO_AKKA_APPS);
      Logger.debug("LiveKitWebhookReceiver: Sent startRtmpBroadcast", {
        event,
        participantMetadata,
      })

    } catch (error) {
      Logger.error("LiveKitWebhookReceiver: Screenshare won't be broadcasted", {
        errorMesssage: error.message,
        errorStack: error.stack,
        event,
        participantMetadata,
      });
    }
  }

  async _handleTrackPublished(event) {
    Logger.trace('LiveKitWebhookReceiver: _handleTrackPublished', { event });

    try {
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, {
        systemClientMap: this._systemClientMap,
      });
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
      Logger.error('LiveKitWebhookReceiver: _handleTrackPublished ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
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
      const timestamp = Math.floor(new Date());
      const dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(
        voiceConf,
        voiceConf,
        sid,
        width,
        height,
        timestamp,
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
      const participantMetadata = await getParticipantMetadata(event, this._roomServiceClient, {
        systemClientMap: this._systemClientMap,
      });
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
    try {
      Logger.debug('LiveKitWebhookReceiver: _handleRoomStarted', { event });

      if (this._rtcAgent?.enabled) {
        const { AccessToken } = this._liveKitSDK;
        const identity = `bbb-webrtc-sfu/${event.room?.name}`;
        const acct = new AccessToken(
          this.key,
          this.secret, {
            identity,
            ttl: 14400,
            metadata: SYS_METADATA,
          },
        );

        acct.addGrant({
          agent:  true,
          canPublish: false,
          canPublishData: false,
          canPublishSources: [],
          canSubscribe: true,
          canUpdateOwnMetadata: true,
          hidden: true,
          ingressAdmin: false,
          recorder: false,
          room: event.room?.name,
          roomAdmin: false,
          roomCreate: false,
          roomJoin: true,
          roomList: true,
          roomRecord: false,
        });

        const jwt = await acct.toJwt();
        const room = new this._liveKitRTC.Room();
        this._systemClientMap.set(event.room.name, room);
        await room.connect(this.host, jwt, {
          autoSubscribe: this._rtcAgent?.autoSubscribe,
          dynacast: false,
        });

        // The ActiveSpeakersChanged event is only available for clients that
        // are subscribing to tracks.
        if (this._rtcAgent?.autoSubscribe) {
          room
            .on(this._liveKitRTC.RoomEvent.ActiveSpeakersChanged, (speakers) => {
              Logger.debug('LiveKitRtcAgent: ActiveSpeakersChanged', { agent: identity, speakers });
            })
            .on(this._liveKitRTC.RoomEvent.TrackSubscribed, (track) => {
              Logger.debug('LiveKitRtcAgent: TrackSubscribed', { agent: identity, track });
            })
            .on(this._liveKitRTC.RoomEvent.TrackUnsubscribed, (track) => {
              Logger.debug('LiveKitRtcAgent: TrackUnsubscribed', { agent: identity, track });
            })
            .on(this._liveKitRTC.RoomEvent.LocalTrackPublished, (track) => {
              Logger.debug('LiveKitRtcAgent: LocalTrackPublished', { agent: identity, track });
            })
            .on(this._liveKitRTC.RoomEvent.LocalTrackUnpublished, (track) => {
              Logger.debug('LiveKitRtcAgent: LocalTrackUnpublished', { agent: identity, track });
            })
            .on(this._liveKitRTC.RoomEvent.Disconnected, (reason) => {
              Logger.debug('LiveKitRtcAgent: Disconnected', { agent: identity, reason });
            });
        }
      }
    } catch (error) {
      Logger.warn('LiveKitWebhookReceiver: _handleRoomStarted error', error);
    }
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
