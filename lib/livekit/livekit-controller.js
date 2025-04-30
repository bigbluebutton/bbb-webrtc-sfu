'use strict';

const config = require('config');
const BaseManager = require('../base/base-manager.js');
const Logger = require('../common/logger.js');
const C = require('../bbb/messages/Constants.js');
const Messaging = require('../bbb/messages/Messaging.js');
const LiveKitWebhookReceiver = require('./livekit-webhook-receiver.js');
const LiveKitSipTrunkManager = require('./livekit-sip-trunk-manager.js');
const LiveKitEgressManager = require('./livekit-egress-manager.js');
const LiveKitWebRTCRecorderManager = require('./livekit-recorder-manager.js');
const {
  isUsingAudioBridge,
  parseLiveKitMetadata,
  bbbIdToLKId,
  isLKParticipantSid,
} = require('./utils.js');

const {
  enabled: LIVEKIT_ENABLED = false,
  host: LIVEKIT_HOST,
  bbbDomain: BBB_DOMAIN,
  tokenTTL: TOKEN_TTL = 3600,
  key: LIVEKIT_KEY,
  secret: LIVEKIT_SECRET,
  systemParticipantsLimit: SYS_PARTICIPANTS_LIMIT = 10,
  rtcAgent: RTC_AGENT_OPTS = { enabled: false, autoSubscribe: false },
  unpublishOnMute: UNPUBLISH_ON_MUTE = false,
  sip: {
    enabled: SIP_ENABLED = false,
    trunk: SIP_TRUNK_CFG = {},
    dispatch: SIP_DISPATCH_CFG = {},
    requirePin: SIP_REQUIRE_PIN = false,
  } = {},
  webhook: {
    port: WEBHOOK_PORT = 3040,
    path: WEBHOOK_PATH = '/livekit-webhook',
  } = {},
  egress: {
    enabled: EGRESS_ENABLED = false,
    startTimeout,
    retryInterval,
  },
  recordingAdapter: RECORDING_ADAPTER = 'egress',
} = config.has('livekit') ? config.get('livekit') : {};

class LiveKitController extends BaseManager {
  static async LiveKitSDK () {
    return import('livekit-server-sdk');
  }

  static async LiveKitRTC () {
    return import('@livekit/rtc-node');
  }

  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix, {
      connectToMCS: false,
    });

    this.liveKitSDK = null;
    this.liveKitRTC = null;
    this.roomServiceClient = null;
    this.webhookReceiver = null;
    this.sipTrunkManager = null;
    this.egressManager = null;
    this.webrtcRecorderManager = null;
    this._roomMap = new Map();
    this._participantIdMap = new Map();
    this.roomRecordingStatusMap = new Map();
  }

  _getRoom (meetingId) {
    return this._roomMap.get(meetingId);
  }

  _setRoom (meetingId, room) {
    if (!room.bbbParsedMetadata) room.bbbParsedMetadata = parseLiveKitMetadata(room);
    this._roomMap.set(meetingId, room);
  }

  _deleteRoom (meetingId) {
    this._roomMap.delete(meetingId);
  }

  setParticipantAlias (participantEvent) {
    // Aliasing identity and sids so that we can use both of them interchangeably
    const { identity, sid } = participantEvent.participant;
    this._participantIdMap.set(identity, sid);
    this._participantIdMap.set(sid, identity);
  }

  getParticipantAlias (participantId) {
    return this._participantIdMap.get(participantId);
  }

  deleteParticipantAlias (identityOrSid) {
    const counterPart = this._participantIdMap.get(identityOrSid);
    this._participantIdMap.delete(identityOrSid);
    this._participantIdMap.delete(counterPart);
  }

  async _syncRooms () {
    try {
      const rooms = await this.roomServiceClient.listRooms();

      rooms.forEach(room => {
        this._setRoom(room.name, room);
      });

      Logger.info('LiveKitController: Rooms synced', { rooms: rooms.map(room => room.name) });
    } catch (error) {
      Logger.error('LiveKitController: Error syncing rooms', error);
    }
  }

  _initRecordingAdapter () {
    if (RECORDING_ADAPTER === 'bbb-webrtc-recorder') {
      this.webrtcRecorderManager = new LiveKitWebRTCRecorderManager(
        this.liveKitSDK,
        this.webhookReceiver,
        this.roomRecordingStatusMap,
        this._bbbGW,
      );
      this.webrtcRecorderManager.init();
    } else if (RECORDING_ADAPTER === 'egress' && EGRESS_ENABLED) {
      this.egressManager = new LiveKitEgressManager(
        this.liveKitSDK,
        LIVEKIT_HOST,
        LIVEKIT_KEY,
        LIVEKIT_SECRET,
        this.webhookReceiver,
        this.roomRecordingStatusMap,
        this._bbbGW, {
        startTimeout,
        retryInterval,
      },
      );
      this.egressManager.init();
    } else {
      Logger.warn('LiveKitController: Recording adapter not supported', { RECORDING_ADAPTER });
    }
  }

  async start () {
    // The module's baseplate (see parent class) has to start, even if the
    // inner workings of this module are disabled.
    await super.start();

    if (!LIVEKIT_ENABLED) {
      Logger.warn('LiveKitController: LiveKit module is disabled');
      return;
    }

    if (!LIVEKIT_KEY || !LIVEKIT_SECRET) {
      throw new Error('LiveKitController: LIVEKIT_KEY and LIVEKIT_SECRET must be set');
    }

    this.liveKitSDK = await LiveKitController.LiveKitSDK();
    this.liveKitRTC = await LiveKitController.LiveKitRTC();
    this.roomServiceClient = new this.liveKitSDK.RoomServiceClient(
      LIVEKIT_HOST,
      LIVEKIT_KEY,
      LIVEKIT_SECRET
    );
    this._observe();

    if (SIP_ENABLED) {
      this.sipTrunkManager = new LiveKitSipTrunkManager(
        this.liveKitSDK,
        LIVEKIT_HOST,
        LIVEKIT_KEY,
        LIVEKIT_SECRET, {
          trunkOptions: SIP_TRUNK_CFG,
          dispatchOptions: SIP_DISPATCH_CFG,
        }
      );
      this.sipTrunkManager.init();
    }

    this._initRecordingAdapter();

    await this._syncRooms();
    Logger.info('LiveKitController started', {
      host: LIVEKIT_HOST,
      tokenTTL: TOKEN_TTL,
    });
  }

  async stop () {
    if (this.sipTrunkManager) await this.sipTrunkManager.stop();
    if (this.egressManager) this.egressManager.stop();
    if (this.webrtcRecorderManager) await this.webrtcRecorderManager.stop();
    if (this.webhookReceiver) this.webhookReceiver.stop();
    this._participantIdMap.clear();
    await super.stop();

    Logger.info('LiveKitController stopped');
  }

  async _handleMeetingCreated (event) {
    try {
      const { props } = event;
      const { meetingId } = event;
      const { cameraBridge, audioBridge, screenShareBridge } = props?.meetingProp || {};

      if (cameraBridge !== 'livekit'
        && audioBridge !== 'livekit'
        && screenShareBridge !== 'livekit') {
        Logger.debug('LiveKitController: Meeting not using LiveKit', { meetingId });
        return;
      }

      const metadata = {
        bbb_meetingId: props?.meetingProp?.intId,
        bbb_meetingName: props?.meetingProp?.name,
        bbb_voiceConf: props?.voiceProp?.voiceConf,
        bbb_muteOnStart: props?.voiceProp?.muteOnStart,
        bbb_domain: BBB_DOMAIN,
        bbb_cameraBridge: cameraBridge,
        bbb_audioBridge: audioBridge,
        bbb_screenShareBridge: screenShareBridge,
      };
      const { meetingExpireWhenLastUserLeftInMinutes  = 0 } = props?.durationProps || {};
      const { meetingExpireIfNoUserJoinedInMinutes = 0 } = props?.durationProps || {};
      const departureTimeout = meetingExpireWhenLastUserLeftInMinutes * 60;
      // See https://docs.livekit.io/server-sdk-js/interfaces/CreateOptions.html
      const options = {
        name: meetingId,
        metadata: JSON.stringify(metadata),
      };

      // Temporarily disable maxParticipants limit until we figure out system
      // participants limits (egress)
      //const { maxUsers: maxParticipants = 0 } = props?.usersProp?.maxUsers || {};
      //if (maxParticipants && maxParticipants >= 0) options.maxParticipants = maxParticipants + SYS_PARTICIPANTS_LIMIT;
      options.maxParticipants = 0;
      if (departureTimeout && departureTimeout >= 0) options.departureTimeout = departureTimeout;
      if (meetingExpireIfNoUserJoinedInMinutes && meetingExpireIfNoUserJoinedInMinutes >= 0) options.emptyTimeout = meetingExpireIfNoUserJoinedInMinutes * 60;

      const room = await this.roomServiceClient.createRoom(options);
      this._setRoom(meetingId, room);

      if (this.sipTrunkManager) {
        try {
          if (!this.sipTrunkManager.hasTrunk(props.voiceProp.voiceConf)) {
            await this.sipTrunkManager.createInboundTrunk(props.voiceProp.voiceConf, [
              props.voiceProp.voiceConf,
            ], {
              metadata: options.metadata,
            });
          }

          if (!this.sipTrunkManager.hasDispatchRule(meetingId)) {
            await this.sipTrunkManager.createDispatchRule(
              meetingId,
              props.voiceProp.voiceConf, {
                requirePin: SIP_REQUIRE_PIN,
                metadata: options.metadata,
              }
            );
          }

          Logger.debug('LiveKitController: SIP trunk created', {
            voiceConf: props.voiceProp.voiceConf,
            meetingId,
          });
        } catch (error) {
          Logger.error('LiveKitController: Error creating SIP trunk', error);
        }
      }
      Logger.info('LiveKitController: Room created', { roomOptions: options });
    } catch (error) {
      Logger.error('LiveKitController: Error creating room', error);
    }
  }

  async _handleMuteUserInVoiceConf (payload) {
    const { meetingId, intId: userId, mute, voiceConf } = payload;
    const room = this._getRoom(meetingId);

    if (!isUsingAudioBridge(room?.bbbParsedMetadata)) return;

    let identity = bbbIdToLKId(userId);
    // RoomServiceClient's getParticipant() expects a LK participant identity,
    // not sid.
    if (isLKParticipantSid(identity)) {
      const alias = this.getParticipantAlias(identity);
      if (alias) identity = alias;
    }

    try {
      Logger.trace('LiveKitController: MuteUserInVoiceConfSysMsg', {
        meetingId,
        userId,
        identity,
        mute,
      });
      const participant = await this.roomServiceClient.getParticipant(meetingId, identity);
      const targetTracks = participant.tracks.filter(track => {
        return this.liveKitSDK.trackSourceToString(track.source) === 'microphone'
          && track.muted !== mute;
      });

      await Promise.all(targetTracks.map((track) => {
        return this.roomServiceClient.mutePublishedTrack(meetingId, identity, track.sid, mute);
      }));
      Logger.debug('LiveKitController: User toggled mute', {
        meetingId,
        voiceConf,
        userId,
        identity,
        voiceUserId: participant?.sid,
        mute,
        microphoneTrackIds: targetTracks.map(track => track.sid),
      });
      this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
        voiceConf,
        participant?.sid, // voiceUserId
        mute,
      ), C.FROM_VOICE_CONF);
    } catch (error) {
      Logger.error('LiveKitController: error handling MuteUserInVoiceConfSysMsg', {
        meetingId,
        userId,
        identity,
        mute,
        errorMessage: error.message,
        errorStack: error.stack,
      });
    }
  }

  async _handleMeetingEnded (payload) {
    const meetingId = payload?.meetingId || payload?.header?.meetingId;
    let voiceConf = payload?.voiceConf || payload?.body?.voiceConf;

    try {
      const room = this._getRoom(meetingId);

      if (room) {
        voiceConf = room.bbbParsedMetadata?.bbb_voiceConf || room.bbbParsedMetadata?.voiceConf;
        if (this.webrtcRecorderManager) await this.webrtcRecorderManager.stopAllFromMeeting(meetingId);
        await this.roomServiceClient.deleteRoom(room?.name || meetingId);
      }

      Logger.info('LiveKitController: Room deleted', { meetingId });
    } catch (error) {
      Logger.warn('LiveKitController: Error deleting room', error);
    } finally {
      if (this.sipTrunkManager) {
        this.sipTrunkManager.deleteDispatchRule({ id: meetingId });
        if (voiceConf) this.sipTrunkManager.deleteInboundTrunk({ name: voiceConf });
      }

      this._deleteRoom(meetingId);
    }
  }

  _handleBBBRecordingStatusChanged ({ meetingId, recording }) {
    this.roomRecordingStatusMap.set(meetingId, recording);

    if (this.egressManager) this.egressManager.handleRecordingStatusChanged(meetingId, recording);
    if (this.webrtcRecorderManager) this.webrtcRecorderManager.handleRecordingStatusChanged(meetingId, recording);
  }

  async _handleCamBroadcastStop ({ meetingId, userId, streamId }) {
    let identity = bbbIdToLKId(userId);
    // RoomServiceClient's getParticipant() expects a LK participant identity,
    // not sid.
    if (isLKParticipantSid(identity)) {
      const alias = this.getParticipantAlias(identity);
      if (alias) identity = alias;
    }

    try {
      const participant = await this.roomServiceClient.getParticipant(meetingId, identity);
      const targetTrack = participant.tracks.find(track => track.name === streamId);

      if (!targetTrack) return;

      await this.roomServiceClient.mutePublishedTrack(meetingId, identity, targetTrack.sid, true);
      Logger.info('LiveKitController: unpublished cam due to CamBroadcastStopSysMsg', {
        meetingId,
        userId,
        identity,
        streamId,
      });
    } catch (error) {
      Logger.warn('LiveKitController: Error handling CamBroadcastStopSysMsg', error);
    } finally {
      this._bbbGW.publish(Messaging.generateCamBroadcastStoppedInSfuEvtMsg(
        meetingId, identity, streamId,
      ), C.FROM_SFU);
    }
  }

  _observe() {
    this._bbbGW.on(
      C.MEETING_CREATED_EVT_MSG,
      this._handleMeetingCreated.bind(this)
    );
    this._bbbGW.on(
      C.EJECT_ALL_FROM_VOICE_CONF,
      this._handleMeetingEnded.bind(this)
    );
    this._bbbGW.on(
      C.GENERATE_LIVEKIT_TOKEN_REQ_MSG,
      this._handleGenerateLiveKitTokenReq.bind(this)
    );
    this._bbbGW.on(
      C.MUTE_USER_IN_VOICE_CONF_SYS_MSG,
      this._handleMuteUserInVoiceConf.bind(this)
    );
    this._bbbGW.on(
      C.RECORDING_STATUS_CHANGED_EVT_MSG,
      this._handleBBBRecordingStatusChanged.bind(this),
    );
    this._bbbGW.on(
      C.CAM_BROADCAST_STOP_SYS_MSG,
      this._handleCamBroadcastStop.bind(this)
    );

    this.webhookReceiver = new LiveKitWebhookReceiver(
      this.liveKitSDK,
      this.liveKitRTC,
      this.roomServiceClient,
      LIVEKIT_HOST,
      LIVEKIT_KEY,
      LIVEKIT_SECRET,
      WEBHOOK_PORT,
      WEBHOOK_PATH,
      this._bbbGW, {
        rtcAgent: RTC_AGENT_OPTS,
        unpublishOnMute: UNPUBLISH_ON_MUTE,
      }
    );
    this.webhookReceiver.init();
    this.webhookReceiver.on(
      'participant_joined',
      this._handleParticipantJoined.bind(this)
    );
    this.webhookReceiver.on(
      'participant_left',
      this._handleParticipantLeft.bind(this)
    );
  }

  async _handleParticipantJoined (event) {
    this.setParticipantAlias(event);
  }

  async _handleParticipantLeft (event) {
    const { identity } = event.participant;
    this.deleteParticipantAlias(identity);
  }

  async _handleGenerateLiveKitTokenReq (payload) {
    const {
      meetingId,
      userId: identity,
      userName,
      grant,
      metadata,
    } = payload;

    const room = this._getRoom(meetingId);

    if (!room.bbbParsedMetadata) room.bbbParsedMetadata = parseLiveKitMetadata(room);

    const pMetadata = {
      ...metadata,
      ...room.bbbParsedMetadata,
      bbb_domain: BBB_DOMAIN,
    };

    try {
      const token = await this._createAccessToken(
        identity,
        userName,
        grant,
        pMetadata,
      );
      Logger.debug('LiveKitController: Token created', {
        meetingId,
        identity,
        token,
        grant,
      });
      this._bbbGW.publish(Messaging.generateGenerateLiveKitTokenRespMsg(
        meetingId,
        identity,
        token,
        grant,
      ), C.TO_AKKA_APPS_CHAN_2x);
    } catch (error) {
      Logger.error('LiveKitController: Error creating token', error);
    }
  }

  _createAccessToken (identity, userName, grant, metadata) {
    const { AccessToken } = this.liveKitSDK;
    const token = new AccessToken(
      LIVEKIT_KEY,
      LIVEKIT_SECRET, {
        identity,
        name: userName,
        ttl: TOKEN_TTL,
        metadata: JSON.stringify(metadata),
      }
    );

    token.addGrant(grant);

    return token.toJwt();
  }
}

module.exports = LiveKitController;
