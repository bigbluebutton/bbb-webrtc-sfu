'use strict';

const EventEmitter = require('events').EventEmitter;
const config = require('config');
const BaseManager = require('../base/base-manager.js');
const Logger = require('../common/logger.js');
const C = require('../bbb/messages/Constants.js');
const Messaging = require('../bbb/messages/Messaging.js');
const LiveKitEventGateway = require('./livekit-event-gateway.js');
const LiveKitSipTrunkManager = require('./livekit-sip-trunk-manager.js');
const LiveKitEgressManager = require('./livekit-egress-manager.js');
const LiveKitWebRTCRecorderManager = require('./livekit-recorder-manager.js');
const LiveKitAgentManager = require('./livekit-agent-manager.js');
const LiveKitBbbManager = require('./livekit-bbb-manager.js');
const { PrometheusAgent, SFULK_NAMES, LIVEKIT_METRICS } = require('./metrics/livekit-metrics.js');
const {
  isUsingAudioBridge,
  isUsingCameraBridge,
  isUsingScreenShareBridge,
  parseLiveKitMetadata,
  bbbIdToLKId,
  isLKParticipantSid,
  getUserIdFromParticipant,
  trackSourceToString,
} = require('./utils.js');

const {
  enabled: LIVEKIT_ENABLED = false,
  host: LIVEKIT_HOST,
  bbbDomain: BBB_DOMAIN,
  tokenTTL: RAW_TOKEN_TTL = 3600,
  key: LIVEKIT_KEY,
  secret: LIVEKIT_SECRET,
  // TODO: reinstate this once we have a safe way to limit participants
  systemParticipantsLimit: SYS_PARTICIPANTS_LIMIT = 10,
  roomCreationTimeout: ROOM_CREATION_TIMEOUT = 7000,
  rtcAgent: RTC_AGENT_OPTS = {
    enabled: false,
    autoSubscribe: false,
    subscriptionSources: LiveKitAgentManager.DEFAULT_SUBSCRIPTION_SOURCES,
    permissions: LiveKitAgentManager.DEFAULT_PERMISSIONS,
  },
  sip: {
    enabled: SIP_ENABLED = false,
    trunk: SIP_TRUNK_CFG = {},
    dispatch: SIP_DISPATCH_CFG = {},
    dtmfActions: SIP_DTMF_ACTIONS = {},
    requirePin: SIP_REQUIRE_PIN = false,
    energyFilter: SIP_ENERGY_FILTER = {},
  } = {},
  webhook: {
    port: WEBHOOK_PORT = 3040,
    path: WEBHOOK_PATH = '/livekit-webhook',
  } = {},
  eventSource: EVENT_SOURCE = 'webhook',
  egress: {
    enabled: EGRESS_ENABLED = false,
    startTimeout,
    retryInterval,
  },
  recordingAdapter: RECORDING_ADAPTER = 'egress',
  permissionChecks: {
    // WIP
    publishMicrophone: PUBLISH_MICROPHONE_PERM_CHECK = false,
    publishCamera: PUBLISH_CAMERA_PERM_CHECK = false,
    publishScreen: PUBLISH_SCREEN_PERM_CHECK = false,
  } = {},
  captureOnExternalEvents: {
    enabled: CAPTURE_ON_EXTERNAL_EVENTS_ENABLED = false,
    events: CAPTURE_ON_EXTERNAL_EVENTS = [],
  } = {},
} = config.has('livekit') ? config.get('livekit') : {};

// The SDK's AccessToken also accepts jwt duration strings ('4h'), but akka's
// ttlSec (Int) and its refresh pacing need seconds, and gen + resp must agree.
// Normalize it at load: numbers and bare numeric strings are seconds,
// duration strings are converted, anything else (or a non-positive value)
// falls back to 3600 with a warning.
const normalizeTokenTTLSeconds = (value) => {
  const DURATION_FACTORS = {
    ms: 1 / 1000, s: 1, m: 60, h: 3600, d: 86400, w: 604800,
  };
  let seconds = null;

  if (typeof value === 'number') {
    seconds = value;
  } else if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
    if (match) seconds = Number(match[1]) * DURATION_FACTORS[(match[2] || 's').toLowerCase()];
  }

  if (!Number.isFinite(seconds) || seconds <= 0) {
    Logger.warn('LiveKitController: invalid livekit.tokenTTL, using 3600s', {
      tokenTTL: value,
    });
    return 3600;
  }

  return Math.max(1, Math.round(seconds));
};
const TOKEN_TTL = normalizeTokenTTLSeconds(RAW_TOKEN_TTL);

class LiveKitController extends BaseManager {
  // Maps TrackSource string aliases to their protobuf enum ints (see
  // livekit.TrackSource), used to sanitize grants before handing them to the SDK.
  static TRACK_SOURCE_NAME_TO_INT = {
    unknown: 0,
    camera: 1,
    microphone: 2,
    screen_share: 3,
    screen_share_audio: 4,
  }

  static DEFAULT_BBB_USER_LK_PERMISSIONS = {
    canPublish: true,
    canSubscribe: true,
    agent: false,
    canPublishData: false,
    canPublishSources: [],
    canUpdateOwnMetadata: false,
    hidden: false,
    ingressAdmin: false,
    recorder: false,
    roomAdmin: false,
    roomCreate: false,
    roomJoin: true,
    roomList: false,
    roomRecord: false,
  }

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
    this.eventGateway = null;
    this.sipTrunkManager = null;
    this.egressManager = null;
    this.webrtcRecorderManager = null;
    this.agentManager = null;
    this.bbbManager = null;
    this._intEvtBus = new EventEmitter();
    this._roomMap = new Map();
    // participantIdMap is used to map participant identities to their sids and vice versa.
    this._participantIdMap = new Map();
    // Map<roomName, Map<identity, participantInfo>>
    this._participantMap = new Map();
    this.roomRecordingStatusMap = new Map();
  }

  _getRoom (meetingId) {
    return this._roomMap.get(meetingId);
  }

  _setRoom (meetingId, room) {
    if (!room.bbbParsedMetadata) room.bbbParsedMetadata = parseLiveKitMetadata(room);
    this._roomMap.set(meetingId, room);
    this._intEvtBus.emit(`room_created:${meetingId}`, room);
  }

  _hasRoom (meetingId) {
    return this._roomMap.has(meetingId);
  }

  _deleteRoom (meetingId) {
    this._roomMap.delete(meetingId);
  }

  _setParticipant (roomName, identity, info) {
    let inner = this._participantMap.get(roomName);
    if (!inner) {
      inner = new Map();
      this._participantMap.set(roomName, inner);
    }
    inner.set(identity, info);
  }

  _getParticipant (roomName, identity) {
    return this._participantMap.get(roomName)?.get(identity);
  }

  _deleteParticipant (roomName, identity) {
    const inner = this._participantMap.get(roomName);
    if (!inner) return false;
    const had = inner.delete(identity);
    if (inner.size === 0) this._participantMap.delete(roomName);
    return had;
  }

  _forEachParticipantInRoom (roomName, fn) {
    const inner = this._participantMap.get(roomName);
    if (!inner) return;
    inner.forEach((info, identity) => fn(info, identity, roomName));
  }

  _deleteRoomParticipants (roomName) {
    this._participantMap.delete(roomName);
  }

  _hasParticipant (roomName, identity) {
    return this._participantMap.get(roomName)?.has(identity) === true;
  }

  _waitForRoom (meetingId) {
    if (this._hasRoom(meetingId)) return Promise.resolve(this._getRoom(meetingId));

    return new Promise((resolve) => {
      const eventName = `room_created:${meetingId}`;

      const onRoomCreated = (room) => {
        clearTimeout(timeout);
        resolve(room);
      };

      const timeout = setTimeout(() => {
        this._intEvtBus.removeListener(eventName, onRoomCreated);
        resolve(null);
      }, ROOM_CREATION_TIMEOUT);

      this._intEvtBus.once(eventName, onRoomCreated);
    });
  }

  _isRoomUsingLiveKit(meetingId, source = null) {
    const room = this._getRoom(meetingId);

    if (!room) return false;

    // If no source is specified, check if any LiveKit bridge is used (i.e.:
    // room is present and has LiveKit metadata)
    if (!source) return !!room.bbbParsedMetadata;

    switch (source) {
      case this.liveKitRTC.TrackSource.SOURCE_MICROPHONE:
        return isUsingAudioBridge(room?.bbbParsedMetadata);
      case this.liveKitRTC.TrackSource.SOURCE_CAMERA:
        return isUsingCameraBridge(room?.bbbParsedMetadata);
      case this.liveKitRTC.TrackSource.SOURCE_SCREEN_SHARE:
        return isUsingScreenShareBridge(room?.bbbParsedMetadata);
      default:
        return !!room.bbbParsedMetadata;
    }
  }

  // Converts an unsafe identity to a form that is safe to be used with
  // RoomServiceClient APIs. An unsafe identity may be:
  // - a participant sid (for LK participants created by BBB)
  // - a BBB-formatted user ID from external users (eg. v_12345)
  _getAPISafeIdentity (unsafeIdentity) {
    let identity = unsafeIdentity;

    // RoomServiceClient's getParticipant() expects a LK participant identity,
    // not sid. Lookup the alias if the identity is a sid.
    if (isLKParticipantSid(identity)) {
      const alias = this.getParticipantAlias(identity);
      if (alias) identity = alias;
    }

    return identity;
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
        this.eventGateway,
        this.roomRecordingStatusMap,
        this._bbbGW,
        this._roomMap,
        this._participantMap,
      );
      this.webrtcRecorderManager.init();
    } else if (RECORDING_ADAPTER === 'egress' && EGRESS_ENABLED) {
      this.egressManager = new LiveKitEgressManager(
        this.liveKitSDK,
        LIVEKIT_HOST,
        LIVEKIT_KEY,
        LIVEKIT_SECRET,
        this.eventGateway,
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

    this.eventGateway = new LiveKitEventGateway(
      this.liveKitSDK,
      this.liveKitRTC,
      this.roomServiceClient,
      LIVEKIT_HOST,
      LIVEKIT_KEY,
      LIVEKIT_SECRET, {
        eventSource: EVENT_SOURCE,
        webhookPort: WEBHOOK_PORT,
        webhookPath: WEBHOOK_PATH,
      }
    );
    this.eventGateway.init();
    this._observe();

    this.bbbManager = new LiveKitBbbManager(
      this.liveKitSDK,
      this.roomServiceClient,
      this._bbbGW,
      this._roomMap, {
        publishCameraPermCheck: PUBLISH_CAMERA_PERM_CHECK,
        publishScreenPermCheck: PUBLISH_SCREEN_PERM_CHECK,
      },
    );

    if (SIP_ENABLED) {
      this.sipTrunkManager = new LiveKitSipTrunkManager(
        this.liveKitSDK,
        LIVEKIT_HOST,
        LIVEKIT_KEY,
        LIVEKIT_SECRET, {
          trunkOptions: SIP_TRUNK_CFG?.options || {},
          dispatchOptions: SIP_DISPATCH_CFG?.options || {},
        }
      );
      this.sipTrunkManager.init();
    }

    this._initRecordingAdapter();

    if (RTC_AGENT_OPTS.enabled) {
      this.agentManager = new LiveKitAgentManager(
        this.liveKitSDK,
        this.liveKitRTC,
        this.roomServiceClient,
        LIVEKIT_HOST,
        LIVEKIT_KEY,
        LIVEKIT_SECRET,
        this.eventGateway,
        this._bbbGW, {
          autoSubscribe: RTC_AGENT_OPTS.autoSubscribe,
          permissions: RTC_AGENT_OPTS.permissions,
          subscriptionSources: RTC_AGENT_OPTS.subscriptionSources,
          dtmfActions: SIP_DTMF_ACTIONS,
          energyFilterOptions: SIP_ENERGY_FILTER,
        }
      );
      this.agentManager.init();
    }

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
    if (this.agentManager) await this.agentManager.stop();
    if (this.eventGateway) this.eventGateway.stop();
    this._participantIdMap.clear();
    // Clear all rooms' participant entries on shutdown
    for (const [roomName] of this._participantMap) {
      this._deleteRoomParticipants(roomName);
    }
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

      if (this.eventGateway) this.eventGateway.handleMeetingCreated(event, room.metadata);

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

  // A LK twirp not_found is one of the desired end states for:
  // - handleEjectUserFromVoiceConfSysMsg
  // - handleUpdateLiveKitParticipantPermissions
  // Participant is already gone - so it has to be distinguishable from a failure.
  static _isNotFound (error) {
    return error?.code === 'not_found'
      || error?.status === 404
      || error?.message?.includes('participant does not exist');
  }

  async _handleEjectUserFromVoiceConfSysMsg (payload) {
    const { meetingId, voiceUserId, voiceConf } = payload;
    const ack = (outcome) => this._bbbGW.publish(
      Messaging.generateEjectUserFromVoiceConfRespMsg(meetingId, voiceConf, voiceUserId, outcome),
      C.TO_AKKA_APPS_CHAN_2x,
    );

    if (!this._isRoomUsingLiveKit(meetingId, this.liveKitRTC.TrackSource.SOURCE_MICROPHONE)) {
      // A room we do know but that is not on the LiveKit audio bridge belongs to
      // FreeSWITCH, so stay silent there.
      if (!this._hasRoom(meetingId)) ack(C.MEDIA_ACTION_OUTCOME.ROOM_ABSENT);

      return;
    }

    const identity = this._getAPISafeIdentity(bbbIdToLKId(voiceUserId));

    try {
      Logger.trace('LiveKitController: EjectUserFromVoiceConfSysMsg', {
        meetingId,
        voiceConf,
        voiceUserId,
        identity,
      });

      await this.roomServiceClient.removeParticipant(meetingId, identity);

      Logger.info('LiveKitController: User ejected from voice conf', {
        meetingId,
        voiceConf,
        voiceUserId,
        identity,
      });
      ack(C.MEDIA_ACTION_OUTCOME.APPLIED);
    } catch (error) {
      const notFound = LiveKitController._isNotFound(error);
      const logLevel = notFound ? 'debug' : 'error';
      const reason = notFound ? C.MEDIA_ACTION_OUTCOME.PARTICIPANT_ABSENT : C.MEDIA_ACTION_OUTCOME.FAILED;

      Logger[logLevel]('LiveKitController: Error handling EjectUserFromVoiceConfSysMsg', {
        meetingId,
        voiceConf,
        voiceUserId,
        identity,
        errorMessage: error?.message,
        errorStack: error?.stack,
      });
      ack(reason);
    }
  }

  // Re-applies a participant's permissions on their live session, keyed by BBB
  // intId. LiveKit writes the change into the participant's claim grants and
  // refreshes the token it holds, so it survives an ordinary SDK reconnect.
  async _handleUpdateLiveKitParticipantPermissions (payload) {
    const { meetingId, userId, grant } = payload;
    const ack = (outcome) => this._bbbGW.publish(
      Messaging.generateUpdateLiveKitParticipantPermissionsRespMsg(meetingId, userId, grant, outcome),
      C.TO_AKKA_APPS_CHAN_2x,
    );

    if (!this._isRoomUsingLiveKit(meetingId)) {
      Logger.warn('LiveKitController: dropped participant permission update, room not present', {
        meetingId,
        userId,
      });
      ack(C.MEDIA_ACTION_OUTCOME.ROOM_ABSENT);

      return;
    }

    const identity = this._getAPISafeIdentity(bbbIdToLKId(userId));

    try {
      // Field by field rather than spread: akka's LiveKitGrant carries members
      // (room, roomJoin, ingressAdmin, ...) that are not part of ParticipantPermission,
      // and protobuf-es drops unknown keys silently rather than rejecting them. Names
      // here must be ParticipantPermission's own - note canUpdateMetadata, which akka
      // calls canUpdateOwnMetadata.
      const permission = {
        canPublish: !!grant?.canPublish,
        canSubscribe: !!grant?.canSubscribe,
        canPublishData: !!grant?.canPublishData,
        canPublishSources: grant?.canPublishSources ?? [],
        canUpdateMetadata: !!grant?.canUpdateOwnMetadata,
        hidden: !!grant?.hidden,
        recorder: !!grant?.recorder,
        agent: !!grant?.agent,
      };

      await this.roomServiceClient.updateParticipant(meetingId, identity, { permission });

      Logger.info('LiveKitController: updated participant permissions', {
        meetingId,
        userId,
        identity,
        canPublish: permission.canPublish,
        canSubscribe: permission.canSubscribe,
      });
      ack(C.MEDIA_ACTION_OUTCOME.APPLIED);
    } catch (error) {
      const notFound = LiveKitController._isNotFound(error);
      const logLevel = notFound ? 'debug' : 'error';
      const reason = notFound ? C.MEDIA_ACTION_OUTCOME.PARTICIPANT_ABSENT : C.MEDIA_ACTION_OUTCOME.FAILED;

      Logger[logLevel]('LiveKitController: Error handling UpdateLiveKitParticipantPermissionsSysMsg', {
        meetingId,
        userId,
        identity,
        canPublish: !!grant?.canPublish,
        errorMessage: error.message,
        errorStack: error.stack,
      });
      ack(reason);
    }
  }

  async _handleMuteUserInVoiceConf (payload) {
    const { meetingId, intId: userId, mute, voiceConf } = payload;

    if (!this._isRoomUsingLiveKit(meetingId, this.liveKitRTC.TrackSource.SOURCE_MICROPHONE)) return;

    const identity = this._getAPISafeIdentity(bbbIdToLKId(userId));

    // Prometheus: timers for tracking mute op durations
    let endFullTimer, endGetParticipantTimer, endMutePublishedTrackTimer;
    const histogramMetric = mute
      ? LIVEKIT_METRICS[SFULK_NAMES.TIME_TO_MUTE]
      : LIVEKIT_METRICS[SFULK_NAMES.TIME_TO_UNMUTE];

    try {
      endFullTimer = histogramMetric.startTimer({ operation: 'full' });
      endGetParticipantTimer = histogramMetric.startTimer({ operation: 'getParticipant' });
      endMutePublishedTrackTimer = histogramMetric.startTimer({ operation: 'mutePublishedTrack' });
    } catch (error) {
      Logger.warn('LiveKitController: Error handling metrics for MuteUserInVoiceConfSysMsg', {
        errorMessage: error.message,
        errorStack: error.stack,
      });
    }

    // Business logic
    try {
      Logger.trace('LiveKitController: MuteUserInVoiceConfSysMsg', {
        meetingId,
        userId,
        identity,
        mute,
      });
      const participant = await this.roomServiceClient.getParticipant(meetingId, identity);

      if (endGetParticipantTimer) endGetParticipantTimer();

      const targetTracks = participant.tracks.filter(track => {
        return trackSourceToString(this.liveKitSDK, track.source) === 'microphone'
          && track.muted !== mute;
      });

      if (targetTracks.length > 0) {
        await Promise.all(targetTracks.map((track) => {
          return this.roomServiceClient.mutePublishedTrack(meetingId, identity, track.sid, mute);
        }));
      }

      if (endMutePublishedTrackTimer) endMutePublishedTrackTimer();

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

      if (endFullTimer) endFullTimer();
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
        Logger.info('LiveKitController: Room deleted', { meetingId, voiceConf });
      }
    } catch (error) {
      Logger.warn('LiveKitController: Error deleting room', error);
    } finally {
      if (this.sipTrunkManager) {
        this.sipTrunkManager.deleteDispatchRule({ id: meetingId });

        if (voiceConf) this.sipTrunkManager.deleteInboundTrunk({ name: voiceConf });
      }

      this._deleteRoom(meetingId);

      // Prune participantMap and participantIdMap for the ended meeting
      this._forEachParticipantInRoom(meetingId, (participantData) => {
        if (participantData.identity) {
          this.deleteParticipantAlias(participantData.identity);
        } else if (participantData.sid) {
          this.deleteParticipantAlias(participantData.sid);
        }
      });
      this._deleteRoomParticipants(meetingId);

      if (this.eventGateway) this.eventGateway.handleMeetingEnded(payload);
    }
  }

  _handleBBBRecordingStatusChanged ({ meetingId, recording }) {
    this.roomRecordingStatusMap.set(meetingId, recording);

    if (this.egressManager) this.egressManager.handleRecordingStatusChanged(meetingId, recording);
    if (this.webrtcRecorderManager) this.webrtcRecorderManager.handleRecordingStatusChanged(meetingId, recording);
  }

  _handlePluginPersistEvent (payload = {}) {
    const { meetingId, eventName, payloadJson = {} } = payload;

    if (!CAPTURE_ON_EXTERNAL_EVENTS.includes(eventName)) return;

    const enabled = !!payloadJson.enabled;

    Logger.info('LiveKitController: external capture status change', {
      meetingId,
      eventName,
      enabled,
    });
    PrometheusAgent.increment(SFULK_NAMES.EXTERNAL_CAPTURE_STATUS_CHANGES, {
      event: eventName,
      enabled: `${enabled}`,
    });

    if (this.webrtcRecorderManager) {
      this.webrtcRecorderManager.handleExternalCaptureStatusChanged(meetingId, enabled, eventName);
    }
  }

  async _handleCamBroadcastStop ({ meetingId, userId, streamId }) {
    if (!this._isRoomUsingLiveKit(meetingId, this.liveKitRTC.TrackSource.SOURCE_CAMERA)) return;

    const identity = this._getAPISafeIdentity(bbbIdToLKId(userId));

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

  async _handleScreenBroadcastStop ({ meetingId, userId, streamId, voiceConf }) {
    if (!this._isRoomUsingLiveKit(meetingId, this.liveKitRTC.TrackSource.SOURCE_SCREEN_SHARE)) return;

    const identity = this._getAPISafeIdentity(bbbIdToLKId(userId));
    let width, height = 0;
    let sid = streamId;

    try {
      const participant = await this.roomServiceClient.getParticipant(meetingId, identity);
      const basePermissions = participant?.permission
        ? participant.permission
        : LiveKitController.DEFAULT_BBB_USER_LK_PERMISSIONS;
      const targetTrack = participant.tracks.find(track => track.sid === streamId);

      if (!targetTrack) return;

      if (!participant?.permission) {
        Logger.warn('LiveKitController: Participant missing permissions on ScreenBroadcastStopSysMsg, using defaults', {
          meetingId,
          userId,
          identity,
          streamId,
          defaultPermissions: basePermissions,
        });
      }

      width = targetTrack?.width || 0;
      height = targetTrack?.height || 0;
      sid = targetTrack?.sid;

      await this.roomServiceClient.mutePublishedTrack(meetingId, identity, sid, true);
      // Force screen share to be unpublished via the permissions API
      await this.roomServiceClient.updateParticipant(meetingId, identity, {
        permission: {
          ...basePermissions,
          canPublish: true,
          canPublishSources: [
            this.liveKitRTC.TrackSource.SOURCE_MICROPHONE,
            this.liveKitRTC.TrackSource.SOURCE_CAMERA
          ],
        },
      });
      // Restore previous participant permissions
      await this.roomServiceClient.updateParticipant(meetingId, identity, {
        permission: { ...basePermissions },
      });

      Logger.info('LiveKitController: unpublished screen due to ScreenBroadcastStopSysMsg', {
        meetingId,
        userId,
        identity,
        streamId,
        sid,
        previousPermissions: basePermissions,
      });
    } catch (error) {
      Logger.warn('LiveKitController: Error handling ScreenBroadcastStopSysMsg', {
        meetingId,
        userId,
        identity,
        streamId,
        errorMessage: error.message,
        errorStack: error.stack,
      });
    } finally {
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
      C.REMOVE_LIVEKIT_PARTICIPANT_SYS_MSG,
      this._handleRemoveLiveKitParticipant.bind(this)
    );
    this._bbbGW.on(
      C.MUTE_USER_IN_VOICE_CONF_SYS_MSG,
      this._handleMuteUserInVoiceConf.bind(this)
    );
    this._bbbGW.on(
      C.UPDATE_LIVEKIT_PARTICIPANT_PERMISSIONS_SYS_MSG,
      this._handleUpdateLiveKitParticipantPermissions.bind(this)
    );
    this._bbbGW.on(
      C.EJECT_USER_FROM_VOICE_CONF_SYS_MSG,
      this._handleEjectUserFromVoiceConfSysMsg.bind(this),
    );
    this._bbbGW.on(
      C.RECORDING_STATUS_CHANGED_EVT_MSG,
      this._handleBBBRecordingStatusChanged.bind(this),
    );
    this._bbbGW.on(
      C.CAM_BROADCAST_STOP_SYS_MSG,
      this._handleCamBroadcastStop.bind(this)
    );
    this._bbbGW.on(
      C.SCREEN_BROADCAST_STOP_SYS_MSG,
      this._handleScreenBroadcastStop.bind(this)
    );

    if (CAPTURE_ON_EXTERNAL_EVENTS_ENABLED) {
      this._bbbGW.on(
        C.PLUGIN_PERSIST_EVENT_EVT_MSG,
        this._handlePluginPersistEvent.bind(this),
      );
    }

    this.eventGateway.on(
      'participant_joined',
      this._handleLiveKitParticipantJoined.bind(this)
    );
    this.eventGateway.on(
      'participant_left',
      this._handleLiveKitParticipantLeft.bind(this)
    );
    this.eventGateway.on(
      'track_published',
      this._handleLiveKitTrackPublished.bind(this)
    );
    this.eventGateway.on(
      'track_unpublished',
      this._handleLiveKitTrackUnpublished.bind(this)
    );
  }

  async _handleLiveKitParticipantJoined (event) {
    this.setParticipantAlias(event);

    try {
      const userId = getUserIdFromParticipant(event.participant);
      const roomName = event.room?.name;

      // Valid user and roomName are required to store it. Sanity check this
      // since it hooks may not always be fully populated.
      if (userId && roomName) {
        this._setParticipant(roomName, userId, {
          roomName,
          participant: event.participant,
          identity: event.participant?.identity,
          sid: event.participant?.sid,
          joinedAt: Date.now(),
        });
      } else {
        throw new Error('Invalid user or roomName');
      }
    } catch (error) {
      Logger.error('LiveKitController: error storing participant data', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }

    if (this.bbbManager) this.bbbManager.handleParticipantJoined(event);
  }

  async _handleLiveKitParticipantLeft (event) {
    const { identity } = event.participant;
    this.deleteParticipantAlias(identity);

    try {
      const userId = getUserIdFromParticipant(event.participant);
      const roomName = event.room?.name;

      if (roomName) {
        if (this._hasParticipant(roomName, userId)) this._deleteParticipant(roomName, userId);
        if (this._hasParticipant(roomName, identity)) this._deleteParticipant(roomName, identity);
      }
    } catch (error) {
      Logger.debug('LiveKitController: error removing participant from map', {
        errorMessage: error.message,
        errorStack: error.stack,
        event,
      });
    }

    if (this.bbbManager) this.bbbManager.handleParticipantLeft(event);
  }

  async _handleLiveKitTrackPublished(event) {
    if (this.bbbManager) this.bbbManager.handleTrackPublished(event);
  }

  async _handleLiveKitTrackUnpublished(event) {
    if (this.bbbManager) this.bbbManager.handleTrackUnpublished(event);
  }

  async _handleGenerateLiveKitTokenReq (payload) {
    const {
      meetingId,
      userId: identity,
      userName,
      roomRef,
      grant,
      metadata = {},
    } = payload;

    if (!roomRef || !roomRef.roomName || !roomRef.purpose) {
      Logger.error('LiveKitController: rejecting GenerateLiveKitTokenReq with missing roomRef', {
        meetingId,
        identity,
      });
      return;
    }

    // The token's join target (grant.room) must be the room whose
    // metadata/purpose it carries, or the token gen silently joins
    // a different room.
    if (grant?.room !== roomRef.roomName) {
      Logger.error('LiveKitController: rejecting GenerateLiveKitTokenReq with grant.room != roomRef.roomName', {
        meetingId,
        identity,
        grantRoom: grant?.room,
        roomRef,
      });
      PrometheusAgent.increment(SFULK_NAMES.TOKEN_GEN_ERRORS, {
        errorMessage: 'grant_roomref_mismatch',
      });
      return;
    }

    const targetRoomName = roomRef.roomName;

    try {
      const room = this._hasRoom(targetRoomName)
        ? this._getRoom(targetRoomName)
        : await this._waitForRoom(targetRoomName);

      let extMetadata = {};

      if (room) {
        if (!room.bbbParsedMetadata) room.bbbParsedMetadata = parseLiveKitMetadata(room);
        extMetadata = room.bbbParsedMetadata;
      } else {
        Logger.warn('LiveKitController: Room not found for token generation', {
          meetingId,
          identity,
          targetRoomName,
        });
        PrometheusAgent.increment(SFULK_NAMES.TOKEN_GEN_ERRORS, {
          errorMessage: 'room_not_found_fallback',
        });
        // Room lookup timed out: synthesize the bbb_* keys the voice-conf
        // join path relies on (notably bbb_audioBridge) so a token mint racing room
        // creation still yields a functional participant. akka-provided
        // metadata takes precedence via the spread.
        extMetadata = {
          bbb_meetingId: roomRef.roomName,
          bbb_voiceConf: metadata?.bbb_voiceConf || metadata?.voiceConf,
          bbb_audioBridge: metadata?.bbb_audioBridge || 'livekit',
          bbb_domain: BBB_DOMAIN,
        };
      }

      const pMetadata = {
        ...extMetadata,
        ...metadata,
        bbb_roomPurpose: roomRef.purpose,
      };

      const token = await this._createAccessToken(
        identity,
        userName,
        grant,
        pMetadata,
      );
      Logger.debug('LiveKitController: Token created', {
        meetingId,
        identity,
        roomRef,
        grant,
        metadata: pMetadata,
      });
      this._bbbGW.publish(Messaging.generateGenerateLiveKitTokenRespMsg(
        meetingId,
        identity,
        roomRef,
        token,
        grant,
        TOKEN_TTL,
      ), C.TO_AKKA_APPS_CHAN_2x);
    } catch (error) {
      Logger.error('LiveKitController: Error creating token', {
        meetingId,
        identity,
        roomRef,
        errorMessage: error?.message,
        errorStack: error?.stack,
      });
      PrometheusAgent.increment(SFULK_NAMES.TOKEN_GEN_ERRORS, {
        errorMessage: error?.message || 'unknown_error',
      });
    }
  }

  async _handleRemoveLiveKitParticipant (payload) {
    const { roomName, userId } = payload;

    if (!roomName || !userId) {
      Logger.warn('LK: RemoveLiveKitParticipantSysMsg missing roomName/userId', { roomName, userId });
      return;
    }

    const identity = this._getAPISafeIdentity(bbbIdToLKId(userId));

    try {
      await this.roomServiceClient.removeParticipant(roomName, identity);
      Logger.info('LK: removed participant on request', { roomName, userId, identity });
    } catch (error) {
      // LK SDK throws a TwirpError (status 404 / code 'not_found') when the
      // participant is already gone; removal is idempotent, so this is expected.
      if (error?.status === 404 || error?.code === 'not_found') {
        Logger.debug('LK: removeParticipant target already gone', { roomName, userId, identity });
        return;
      }
      Logger.error('LK: removeParticipant failed', { roomName, userId, identity, error: error.message });
    }
  }

  // The SDK's toJwt only accepts protobuf enum ints.
  // Coerce legacy { no, name } objects and string aliases to ints and drop
  // whatever cannot be resolved.
  _normalizeGrant (grant) {
    if (!grant || !Array.isArray(grant.canPublishSources)) return grant;

    return {
      ...grant,
      canPublishSources: grant.canPublishSources.reduce((acc, s) => {
        if (typeof s === 'number') {
          acc.push(s);
        } else if (s && typeof s === 'object' && typeof s.no === 'number') {
          acc.push(s.no);
        } else if (typeof s === 'string') {
          const trimmed = s.trim();
          if (/^\d+$/.test(trimmed)) {
            acc.push(parseInt(trimmed, 10));
          } else if (LiveKitController.TRACK_SOURCE_NAME_TO_INT[trimmed.toLowerCase()] != null) {
            acc.push(LiveKitController.TRACK_SOURCE_NAME_TO_INT[trimmed.toLowerCase()]);
          } else {
            Logger.warn('LiveKitController: dropping unresolvable canPublishSources entry', { source: s });
          }
        } else {
          Logger.warn('LiveKitController: dropping unresolvable canPublishSources entry', { source: s });
        }
        return acc;
      }, []),
    };
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

    token.addGrant(this._normalizeGrant(grant));

    return token.toJwt();
  }
}

module.exports = LiveKitController;
