/**
 * @classdesc
 * Message constants for the communication with BigBlueButton
 * @constructor
 */

'use strict'

const config = require('config');

exports.ALL = 'ALL'

exports.STATUS = {}
exports.STATUS.STARTED = "STARTED"
exports.STATUS.STOPPED = "STOPPED"
exports.STATUS.RUNNING = "RUNNING'"
exports.STATUS.STARTING = "STARTING"
exports.STATUS.STOPPING = "STOPPING"
exports.STATUS.RESTARTING = "RESTARTING"

exports.USERS = {}
exports.USERS.SFU = "SFU"
exports.USERS.MCU = "MCU"
exports.USERS.INTERNAL_TRACKING_ID = -1;

exports.MEDIA_TYPE = {}
exports.MEDIA_TYPE.WEBRTC = "WebRtcEndpoint"
exports.MEDIA_TYPE.RTP = "RtpEndpoint"
exports.MEDIA_TYPE.URI = "PlayerEndpoint"
exports.MEDIA_TYPE.RECORDING = "RecorderEndpoint"
exports.MEDIA_TYPE.INTERNAL_UNSUPPORTED = "InternalUnsupportedMedia"

exports.MEDIA_PROFILE = {}
exports.MEDIA_PROFILE.MAIN = 'main'
exports.MEDIA_PROFILE.CONTENT = 'content'
exports.MEDIA_PROFILE.AUDIO = 'audio'
exports.MEDIA_PROFILE.APPLICATION = 'application'
exports.MEDIA_PROFILE.UNSUPPORTED = 'unsupported'
exports.MEDIA_PROFILE.ALL = 'all'

exports.CONNECTION_TYPE = {}
exports.CONNECTION_TYPE.VIDEO = 'VIDEO'
exports.CONNECTION_TYPE.AUDIO = 'AUDIO'
exports.CONNECTION_TYPE.CONTENT = 'CONTENT'
exports.CONNECTION_TYPE.ALL = 'ALL'

exports.NEGOTIATION_ROLE = {}
exports.NEGOTIATION_ROLE.OFFERER = 'offerer';
exports.NEGOTIATION_ROLE.ANSWERER = 'answerer';

exports.DEFAULT_MEDIA_SPECS = config.util.cloneDeep(config.get('conference-media-specs'));

// Media server state changes
exports.EMAP = {
  mediaState: 'MediaState',
  onIceCandidate: 'OnIceCandidate',
  MediaState: 'mediaState',
  OnIceCandidate: 'onIceCandidate',
  mediaServerOnline: 'MediaServerOnline',
  MediaServerOnline: 'mediaServerOnline',
  mediaServerOffline: 'MediaServerOffline',
  MediaServerOffline: 'mediaServerOffline',
  RTP: 'RtpEndpoint',
  WebRTC: 'WebRtcEndpoint',
  URI: 'PlayerEndpoint',
  RECORDING: 'RecorderEndpoint',
  WebRtcEndpoint: 'WebRtcEndpoint',
  RtpEndpoint: 'RtpEndpoint',
  PlayerEndpoint: 'PlayerEndpoint',
  RecorderEndpoint: 'RecorderEndpoint'
}

exports.MEMBERS = {};
exports.MEMBERS.USER = "user";
exports.MEMBERS.MEDIA_SESSION = "mediaSession";
exports.MEMBERS.MEDIA = "media";
exports.MEMBERS.ROOM = "room";

exports.STRATEGIES = {};
exports.STRATEGIES.FREEWILL = "freewill";
exports.STRATEGIES.VOICE_SWITCHING = "voiceSwitching";

// All events traded throughout mcs-core. They can be used by adapters as well
// if declared in the ADAPTER_EVENTS map
const EVENT = {};
EVENT.MEDIA_SERVER_ONLINE = "MediaServerOnline"
EVENT.MEDIA_SERVER_OFFLINE = 2001
EVENT.MEDIA_STATE = {};
EVENT.MEDIA_STATE.MEDIA_EVENT = "MediaState"
EVENT.MEDIA_STATE.CHANGED = "MediaStateChanged"
EVENT.MEDIA_STATE.FLOW_OUT = "MediaFlowOutStateChange"
EVENT.MEDIA_STATE.FLOW_IN = "MediaFlowInStateChange"
EVENT.MEDIA_STATE.ENDOFSTREAM = "EndOfStream"
EVENT.MEDIA_STATE.ICE = "OnIceCandidate"
EVENT.MEDIA_STATE.ICE_GATHERING_DONE = "IceGatheringDone";
EVENT.MEDIA_STATE.ICE_STATE_CHANGE = "IceComponentStateChange";
EVENT.MEDIA_STATE.ICE_CANDIDATE_PAIR_SELECTED = "NewCandidatePairSelected";
EVENT.SERVER_STATE = "ServerState"
EVENT.ROOM_EMPTY = "RoomEmpty"
EVENT.MEDIA_CONNECTED = "mediaConnected";
EVENT.MEDIA_DISCONNECTED = "mediaDisconnected";
EVENT.MEDIA_NEGOTIATED = "mediaNegotiated";
EVENT.MEDIA_RENEGOTIATED = "mediaRenegotiated";
EVENT.MEDIA_MUTED = "muted";
EVENT.MEDIA_UNMUTED = "unmuted";
EVENT.MEDIA_VOLUME_CHANGED = "volumeChanged";
EVENT.MEDIA_START_TALKING = "startTalking";
EVENT.MEDIA_STOP_TALKING = "stopTalking";
EVENT.MEDIA_EXTERNAL_AUDIO_CONNECTED = "mediaExternalAudioConnected";
EVENT.USER_JOINED = "userJoined";
EVENT.USER_LEFT = "userLeft";
EVENT.ROOM_CREATED = "roomCreated";
EVENT.ROOM_DESTROYED = "roomDestroyed";
EVENT.ELEMENT_TRANSPOSED = "elementTransposed";
EVENT.CONTENT_FLOOR_CHANGED = "contentFloorChanged";
EVENT.CONFERENCE_FLOOR_CHANGED = "conferenceFloorChanged";
EVENT.CONFERENCE_NEW_VIDEO_FLOOR = "conferenceNewVideoFloor";
EVENT.SUBSCRIBED_TO = "subscribedTo";
EVENT.KEYFRAME_NEEDED = "keyframeNeeded";
EVENT.RECORDING = {};
EVENT.RECORDING.STOPPED = 'Stopped';
EVENT.RECORDING.STARTED = 'Recording';
EVENT.RECORDING.PAUSED = 'Paused';
EVENT.REMOTE_SDP_RECEIVED = 'REMOTE_SDP_RECEIVED';
EVENT.RESPONSE_SET = 'RESPONSE_SET';
EVENT.REINVITE = "REINVITE";
EVENT.EJECT_USER = "ejectUser";

// Events adapters may use
EVENT.ADAPTER_EVENTS = [
  EVENT.MEDIA_STATE.ICE,
  EVENT.MEDIA_STATE.MEDIA_EVENT,
  EVENT.MEDIA_MUTED,
  EVENT.MEDIA_UNMUTED,
  EVENT.MEDIA_VOLUME_CHANGED,
  EVENT.MEDIA_START_TALKING,
  EVENT.MEDIA_STOP_TALKING,
  EVENT.CONFERENCE_FLOOR_CHANGED,
  EVENT.MEDIA_DISCONNECTED,
  EVENT.KEYFRAME_NEEDED,
];

exports.EVENT = EVENT;

// Error codes
exports.ERROR = {};
exports.ERROR.MIN_CODE = 2000;
exports.ERROR.MAX_CODE = 2999;
exports.ERROR.CONNECTION_ERROR = { code: 2000, message: "MEDIA_SERVER_CONNECTION_ERROR" };
exports.ERROR.MEDIA_SERVER_OFFLINE = { code: 2001, message: "MEDIA_SERVER_OFFLINE" };
exports.ERROR.MEDIA_SERVER_NO_RESOURCES = { code: 2002, message: "MEDIA_SERVER_NO_RESOURCES" };
exports.ERROR.MEDIA_SERVER_REQUEST_TIMEOUT = { code: 2003, message: "MEDIA_SERVER_REQUEST_TIMEOUT" };
exports.ERROR.MEDIA_SERVER_GENERIC_ERROR = { code: 2019, message: "MEDIA_SERVER_GENERIC_ERROR" };
exports.ERROR.ICE_CANDIDATE_FAILED = { code: 2020, message: "ICE_ADD_CANDIDATE_FAILED" };
exports.ERROR.ICE_GATHERING_FAILED = { code: 2021, message: "ICE_GATHERING_FAILED" };
exports.ERROR.ICE_STATE_FAILED = { code: 2022, message: "ICE_STATE_FAILED" };

exports.ERROR.ROOM_GENERIC_ERROR = { code: 2100, message: "ROOM_GENERIC_ERROR" };
exports.ERROR.ROOM_NOT_FOUND = { code: 2101, message: "ROOM_NOT_FOUND" };
exports.ERROR.USER_GENERIC_ERROR = { code: 2110, message: "USER_GENERIC_ERROR" };
exports.ERROR.USER_NOT_FOUND = { code: 2111, message: "USER_NOT_FOUND" };

exports.ERROR.MEDIA_GENERIC_ERROR = { code: 2200, message: "MEDIA_GENERIC_ERROR" };
exports.ERROR.MEDIA_NOT_FOUND = { code: 2201, message: "MEDIA_NOT_FOUND" };
exports.ERROR.MEDIA_INVALID_SDP = { code: 2202, message: "MEDIA_INVALID_SDP" };
exports.ERROR.MEDIA_NO_AVAILABLE_CODEC = { code: 2203, message: "MEDIA_NO_AVAILABLE_CODEC" };
exports.ERROR.MEDIA_INVALID_TYPE = { code: 2204, message: "MEDIA_INVALID_TYPE" };
exports.ERROR.MEDIA_INVALID_OPERATION = { code: 2205, message: "MEDIA_INVALID_OPERATION" };
exports.ERROR.MEDIA_PROCESS_OFFER_FAILED = { code: 2206, message : "MEDIA_PROCESS_OFFER_FAILED" };
exports.ERROR.MEDIA_PROCESS_ANSWER_FAILED = { code: 2207, message : "MEDIA_PROCESS_ANSWER_FAILED" };
exports.ERROR.MEDIA_GENERIC_PROCESS_ERROR = { code: 2208, message: "MEDIA_GENERIC_PROCESS_ERROR" };
exports.ERROR.MEDIA_ADAPTER_OBJECT_NOT_FOUND = { code: 2209, message: "MEDIA_ADAPTER_OBJECT_NOT_FOUND" };
exports.ERROR.MEDIA_CONNECT_ERROR = { code: 2210, message: "MEDIA_CONNECT_ERROR" };
exports.ERROR.MEDIA_ESL_COMMAND_ERROR = { code: 2211, message: "MEDIA_ESL_COMMAND_ERROR" };
exports.ERROR.MEDIA_ESL_AUTHENTICATION_ERROR = { code: 2212, message: "MEDIA_ESL_AUTHENTICATION_ERROR" };
exports.ERROR.MEDIA_ESL_CONNECTION_ERROR = { code: 2213, message: "MEDIA_ESL_CONNECTION_ERROR" };
exports.ERROR.MEDIA_ID_COLLISION = { code: 2214, message: "MEDIA_ID_COLLISION" };

// Balancing strategy constants
exports.BALANCING_STRATEGY = {};
exports.BALANCING_STRATEGY.ROUND_ROBIN = "ROUND_ROBIN";
exports.BALANCING_STRATEGY.MEDIA_TYPE = "MEDIA_TYPE";

// Freeswitch Adapter
exports.FREESWITCH = {};
exports.FREESWITCH.GLOBAL_AUDIO_PREFIX = "GLOBAL_AUDIO_";

// Strings
exports.STRING = {}
exports.STRING.KURENTO = "Kurento"
exports.STRING.FREESWITCH = "Freeswitch"
exports.STRING.USER_AGENT = "MediaController"
exports.STRING.DEFAULT_NAME = "default"
exports.STRING.SIP_USER_AGENT = "SIP.js 0.7.8"
exports.STRING.ANONYMOUS = "ANONYMOUS"
exports.STRING.FS_USER_AGENT_STRING = "Freeswitch_User_Agent"
exports.STRING.XML_MEDIA_FAST_UPDATE = '<?xml version=\"1.0\" encoding=\"utf-8\" ?>' +
                                          '<media_control>' +
                                            '<vc_primitive>' +
                                              '<to_encoder>' +
                                                '<picture_fast_update>' +
                                                '</picture_fast_update>' +
                                              '</to_encoder>' +
                                            '</vc_primitive>' +
                                          '</media_control>'
