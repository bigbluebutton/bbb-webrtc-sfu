'use strict';

const config = require('config');
const BaseManager = require('../base/base-manager.js');
const Logger = require('../common/logger.js');
const C = require('../bbb/messages/Constants.js');
const Messaging = require('../bbb/messages/Messaging.js');
const LiveKitWebhookReceiver = require('./livekit-webhook-receiver.js');
const LiveKitSipTrunkManager = require('./livekit-sip-trunk-manager.js');
const LiveKitEgressManager = require('./livekit-egress-manager.js');
const { parseLiveKitMetadata } = require('./utils.js');

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
    inbound: SIP_INBOUND_CFG = {},
  } = {},
  webhook: {
    port: WEBHOOK_PORT = 3040,
    path: WEBHOOK_PATH = '/livekit-webhook',
  } = {},
  egress: {
    enabled: EGRESS_ENABLED = false,
  },
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
    this.roomRecordingStatusMap = new Map();
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
          inboundOptions: SIP_INBOUND_CFG,
        }
      );
      this.sipTrunkManager.init();
    }

    if (EGRESS_ENABLED) {
      this.egressManager = new LiveKitEgressManager(
        this.liveKitSDK,
        LIVEKIT_HOST,
        LIVEKIT_KEY,
        LIVEKIT_SECRET,
        this.webhookReceiver,
        this.roomRecordingStatusMap,
        this._bbbGW,
      );
      this.egressManager.init();
    }

    Logger.info('LiveKitController started', {
      host: LIVEKIT_HOST,
      tokenTTL: TOKEN_TTL,
    });
  }

  async stop () {
    if (this.sipTrunkManager) this.sipTrunkManager.stop();
    if (this.egressManager) this.egressManager.stop();
    if (this.webhookReceiver) this.webhookReceiver.stop();
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
        bbb_dialNumber: props?.voiceProp?.dialNumber,
        bbb_muteOnStart: props?.voiceProp?.muteOnStart,
        bbb_domain: BBB_DOMAIN,
      };
      const { maxUsers: maxParticipants = 0 } = props?.usersProp?.maxUsers || {};
      const { meetingExpireWhenLastUserLeftInMinutes  = 0 } = props?.durationProps || {};
      const { meetingExpireIfNoUserJoinedInMinutes = 0 } = props?.durationProps || {};
      const departureTimeout = meetingExpireWhenLastUserLeftInMinutes * 60;
      // See https://docs.livekit.io/server-sdk-js/interfaces/CreateOptions.html
      const options = {
        name: meetingId,
        metadata: JSON.stringify(metadata),
      };

      if (maxParticipants && maxParticipants >= 0) options.maxParticipants = maxParticipants + SYS_PARTICIPANTS_LIMIT;
      if (departureTimeout && departureTimeout >= 0) options.departureTimeout = departureTimeout;
      if (meetingExpireIfNoUserJoinedInMinutes && meetingExpireIfNoUserJoinedInMinutes >= 0) options.emptyTimeout = meetingExpireIfNoUserJoinedInMinutes * 60;

      await this.roomServiceClient.createRoom(options);

      if (this.sipTrunkManager && props?.voiceProp?.dialNumber) {
        try {
          if (!this.sipTrunkManager.hasTrunk(props.voiceProp.dialNumber)) {
            await this.sipTrunkManager.createInboundTrunk(props.voiceProp.dialNumber, [
              props.voiceProp.dialNumber,
            ]);
          }

          if (!this.sipTrunkManager.hasDispatchRule(meetingId)) {
            await this.sipTrunkManager.createDispatchRule(
              props.voiceProp.dialNumber,
              meetingId,
              props.voiceProp.voiceConf
            );
          }

          Logger.debug('LiveKitController: SIP trunk created', {
            dialNumber: props.voiceProp.dialNumber,
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
    const { meetingId, intId: userId, mute } = payload;

    try {
      Logger.trace('LiveKitController: MuteUserInVoiceConfSysMsg', {
        meetingId,
        userId,
        mute,
      });
      const participant = await this.roomServiceClient.getParticipant(meetingId, userId);
      const participantMetadata = parseLiveKitMetadata(participant);
      const targetTracks = participant.tracks.filter(track => {
        return this.liveKitSDK.trackSourceToString(track.source) === 'microphone'
          && track.muted !== mute;
      });

      await Promise.all(targetTracks.map((track) => {
        return this.roomServiceClient.mutePublishedTrack(meetingId, userId, track.sid, mute);
      }));
      Logger.debug('LiveKitController: User toggled mute', {
        meetingId,
        voiceConf: participantMetadata?.bbb_voiceConf || participantMetadata?.voiceConf,
        userId,
        voiceUserId: participant?.sid,
        mute,
        microphoneTrackIds: targetTracks.map(track => track.sid),
      });
      this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
        participantMetadata?.bbb_voiceConf || participantMetadata?.voiceConf,
        participant?.sid, // voiceUserId
        mute,
      ), C.FROM_VOICE_CONF);
    } catch (error) {
      Logger.error('LiveKitController: error handling MuteUserInVoiceConfSysMsg', {
        meetingId,
        userId,
        mute,
        errorMessage: error.message,
        errorStack: error.stack,
      });
    }
  }

  async _handleMeetingEnded (payload) {
    try {
      const { meetingId } = payload;

      await this.roomServiceClient.deleteRoom(meetingId);
      Logger.info('LiveKitController: Room deleted', { meetingId });
    } catch (error) {
      Logger.warn('LiveKitController: Error deleting room', error);
    }
  }

  _handleBBBRecordingStatusChanged ({ meetingId, recording }) {
    this.roomRecordingStatusMap.set(meetingId, recording);
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
      this._handleBBBRecordingStatusChanged,
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
  }

  async _handleGenerateLiveKitTokenReq (payload) {
    const {
      meetingId,
      userId: identity,
      userName,
      grant,
      metadata,
    } = payload;

    const pMetadata = {
      ...metadata,
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
