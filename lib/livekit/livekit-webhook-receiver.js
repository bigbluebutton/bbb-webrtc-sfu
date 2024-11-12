'use strict';

const express = require('express');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../common/logger.js');
const Messaging = require('../bbb/messages/Messaging.js');
const C = require('../bbb/messages/Constants.js');

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
      rtcClientOptions: {
        enabled = false,
        autoSubscribe = false,
      } = {},
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
    this._rtcClientOptions = {
      enabled,
      autoSubscribe,
    };

    this.receiver = new this._liveKitSDK.WebhookReceiver(key, secret);
    this.host = host;
    this.key = key;
    this.secret = secret;
    this.path = path;
    this.port = port;
  }

  _parseParticipantMetadata(participant) {
    if (!participant.metadata || Object.keys(participant.metadata).length === 0) {
      return {};
    }

    try {
      const metadata = JSON.parse(participant.metadata);
      return metadata;
    } catch (error) {
      Logger.warn('LiveKitWebhookReceiver: _parseParticipantMetadata: error parsing metadata', {
        participant,
        errorMessage: error.message,
        errorStack: error.stack,
      });

      return {};
    }
  }

  init() {
    if (this.app) return;

    this.app = express();
    this.app.use(express.raw({ type: 'application/webhook+json' }));

    this.app.post(this.path, async (req, res) => {
      const event = await this.receiver.receive(req.body, req.get('Authorization'));

      try {
        await this._handleEvent(event);
        res.status(200).send('OK');
      } catch (error) {
        Logger.error('LiveKitWebhookReceiver: error handling event', error);
        res.status(500).send(`Error: ${error.message}`);
      }
    });

    this._server = this.app.listen(this.port, () => {
      Logger.info(`LiveKitWebhookReceiver listening at http://localhost:${this.port}`, {
        key: this.key,
        secret: this.secret,
        path: this.path,
        port: this.port,
      });
    });
  }

  async _handleParticipantJoined(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleParticipantJoined', { event });
    const participantMetadata = this._parseParticipantMetadata(event.participant);

    if (participantMetadata.bbb_system) return;

    const tracks = event.participant?.tracks;
    const microphoneTrack = tracks.find((track) =>
      this._liveKitSDK.trackSourceToString(track.source) === 'microphone'
    );
    const micSidSource = microphoneTrack?.sid || event?.participant?.sid;
    const micSidInt = parseInt(micSidSource.slice(-3), 16);
    const callerIdNum = `${event.participant?.identity}_${micSidInt}-bbbID-${event.participant?.name}`;

    this._bbbGW.publish(Messaging.generateUserJoinedVoiceConfEvtMsg(
      participantMetadata.voiceConf, // voiceConf
      event.participant?.sid, // voiceUserId
      event.participant?.identity, // intId
      event.participant?.name, // callerIdName
      callerIdNum, // callerIdNum
      microphoneTrack ? microphoneTrack.muted : true, // muted
      false, // talking
      'liveKit', // callingWith
      false, // hold - not used
      event.participant?.sid, // uuid
    ), C.FROM_VOICE_CONF);
  }

  _handleParticipantLeft(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleParticipantLeft', { event });
    const participantMetadata = this._parseParticipantMetadata(event.participant);

    if (participantMetadata.bbb_system) return;

    const voiceConf = participantMetadata.voiceConf;

    this._bbbGW.publish(Messaging.generateUserLeftVoiceConfEvtMsg(
      voiceConf, // voiceConf
      event.participant?.sid, // voiceUserId
    ), C.FROM_VOICE_CONF);
  }

  _handleMicrophoneTrackPublished(event, participantMetadata) {
    const voiceConf = participantMetadata.voiceConf;

    this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
      voiceConf, // voiceConf
      event.participant?.sid, // voiceUserId
      false, // muted
    ), C.FROM_VOICE_CONF);

    Logger.debug('LiveKitWebhookReceiver: _handleMicrophoneTrackPublished', { event });
  }

  _handleCameraTrackPublished(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleCameraTrackPublished', { event });
  }

  _handleScreenShareTrackPublished(event, participantMetadata) {
    Logger.debug('LiveKitWebhookReceiver: _handleScreenShareTrackPublished', { event });

    try {
      const { track } = event;
      const { name, sid, width, height, source } = track;
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
          hasAudio: source === 'SCREEN_SHARE_AUDIO',
          contentType,
        }
      );
      this._bbbGW.publish(dsrbstam, C.TO_AKKA_APPS);
      Logger.debug("Sent startRtmpBroadcast", {
        event,
        participantMetadata,
      })

    } catch (error) {
      Logger.error("Screenshare won't be broadcasted", {
        errorMesssage: error.message,
        errorStack: error.stack,
        event,
        participantMetadata,
      });
    }
  }

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleTrackPublished', { event });

    try {
      const svcParticipant = await this._roomServiceClient.getParticipant(
        event.room?.name,
        event.participant?.identity,
      );
      const participantMetadata = this._parseParticipantMetadata(svcParticipant);
      const trackSource = this._liveKitSDK.trackSourceToString(event.track?.source);

      switch (trackSource) {
        case 'microphone':
          this._handleMicrophoneTrackPublished(event, participantMetadata);
          break;
        case 'camera':
          this._handleCameraTrackPublished(event, participantMetadata);
          break;
        case 'screen_share':
        case 'screen_share_audio':
          this._handleScreenShareTrackPublished(event, participantMetadata);
          break;
        default:
          Logger.warn('LiveKitWebhookReceiver: _handleTrackPublished: unknown track source', {
            trackSource,
            event,
          });
      }
    } catch (error) {
      Logger.error('LiveKitWebhookReceiver: _handleTrackPublished ERROR', error);
    }
  }

  _handleMicrophoneTrackUnpublished(event, participantMetadata) {
    const voiceConf = participantMetadata.voiceConf;

    Logger.debug('LiveKitWebhookReceiver: _handleMicrophoneTrackUnpublished', { event });
    this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
      voiceConf, // voiceConf
      event.participant?.sid, // voiceUserId
      true, // muted
    ), C.FROM_VOICE_CONF);
  }

  _handleCameraTrackUnpublished(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleCameraTrackUnpublished', { event });
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
      Logger.error('LiveKitWebhookReceiver: _handleScreenShareTrackUnpublished ERROR', error);
    }
  }

  async _handleTrackUnpublished(event) {
    Logger.debug('LiveKitWebhookReceiver: _handleTrackUnpublished', { event });

    try {
      const svcParticipant = await this._roomServiceClient.getParticipant(
        event.room?.name,
        event.participant?.identity,
      );
      const participantMetadata = this._parseParticipantMetadata(svcParticipant);
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

      const voiceConf = participantMetadata.voiceConf;

      this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
        voiceConf, // voiceConf
        event.participant?.sid, // voiceUserId
        true, // muted
      ), C.FROM_VOICE_CONF);
    } catch (error) {
      Logger.error('LiveKitWebhookReceiver: _handleTrackUnpublished ERROR', error);
    }
  }

  async _handleRoomStarted(event) {
    try {
      Logger.debug('LiveKitWebhookReceiver: _handleRoomStarted', { event });

      if (this._rtcClientOptions.enabled) {
        const { AccessToken } = this._liveKitSDK;
        const acct = new AccessToken(
          this.key,
          this.secret, {
            identity: `bbb-webrtc-sfu/${event.room?.name}`,
            ttl: 14400,
            metadata: SYS_METADATA,
          },
        );

        acct.addGrant({
          agent:  true,
          canPublish: true,
          canPublishData: true,
          canPublishSources: [],
          canSubscribe: true,
          canUpdateOwnMetadata: true,
          hidden: false,
          ingressAdmin: true,
          recorder: true,
          room: event.room?.name,
          roomAdmin: true,
          roomCreate: true,
          roomJoin: true,
          roomList: true,
          roomRecord: true,
        });

        const jwt = await acct.toJwt();
        const room = new this._liveKitRTC.Room();
        this._systemClientMap.set(event.room.name, room);
        await room.connect(this.host, jwt, {
          autoSubscribe: this._rtcClientOptions.autoSubscribe,
          dynacast: false,
        });

        // The ActiveSpeakersChanged event is only available for clients that
        // are subscribing to tracks.
        if (this._rtcClientOptions.autoSubscribe) {
          room.on(this._liveKitRTC.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            Logger.debug('LiveKitWebhookReceiver: ActiveSpeakersChanged', { speakers });
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
