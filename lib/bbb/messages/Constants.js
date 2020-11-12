"use strict";

const config = require('config');
/**
 * @classdesc
 * Message constants for the communication with BigBlueButton
 * @constructor
 */
  function Constants () {
    return {
        // Media elements
        WEBRTC: "WebRtcEndpoint",
        RTP: "RtpEndpoint",
        AUDIO: "AUDIO",
        VIDEO: "VIDEO",
        ALL: "ALL",
        RECORDING_PROFILE_WEBM_VIDEO_ONLY: 'WEBM_VIDEO_ONLY',
        RECORDING_PROFILE_MKV_VIDEO_ONLY: 'MKV_VIDEO_ONLY',
        RECORDING_PROFILE_WEBM_FULL: 'WEBM',
        RECORDING_PROFILE_MKV_FULL: 'MKV',
        RECORDING_FORMAT_WEBM: 'webm',
        RECORDING_FORMAT_MKV: 'mkv',

        // SFU app types
        SCREENSHARE_APP:  'screenshare',
        VIDEO_APP: 'video',
        AUDIO_APP: 'audio',

        // SFU requisition roles
        SEND_ROLE: 'send',
        RECV_ROLE: 'recv',
        SEND_RECV_ROLE: 'sendrecv',

        // Provider events
        VIDEO_SOURCE_ADDED: "videoSourceAdded",
        VIDEO_NEGOTIATED: "videoNegotiated",
        VIDEO_STOPPED: "videoStopped",

        // Redis channels
        FROM_BBB_TRANSCODE_SYSTEM_CHAN : "bigbluebutton:from-bbb-transcode:system",
        TO_BBB_TRANSCODE_SYSTEM_CHAN: "bigbluebutton:to-bbb-transcode:system",
        TO_BBB_MEETING_CHAN: "bigbluebutton:to-bbb-apps:meeting",
        FROM_BBB_MEETING_CHAN: "bigbluebutton:from-bbb-apps:meeting",
        TO_AKKA_APPS_CHAN_2x: "to-akka-apps-redis-channel",
        FROM_SCREENSHARE: config.get('from-screenshare'),
        TO_SCREENSHARE: config.get('to-screenshare'),
        FROM_VIDEO: config.get('from-video'),
        TO_VIDEO: config.get('to-video'),
        FROM_AUDIO: config.get('from-audio'),
        TO_AUDIO: config.get('to-audio'),
        TO_AKKA_APPS: config.get('to-akka'),
        FROM_AKKA_APPS: config.get('from-akka'),

        TO_HTML5: config.get('to-html5'),

        // RedisWrapper events
        REDIS_MESSAGE : "redis_message",
        WEBSOCKET_MESSAGE: "ws_message",
        GATEWAY_MESSAGE: "gateway_message",

        RECORDING_STATUS_REQUEST_MESSAGE_2x: "GetRecordingStatusReqMsg",
        RECORDING_STATUS_REPLY_MESSAGE_2x: "GetRecordingStatusRespMsg",

        // Message identifiers 1x
        START_TRANSCODER_REQUEST: "start_transcoder_request_message",
        START_TRANSCODER_REPLY: "start_transcoder_reply_message",
        STOP_TRANSCODER_REQUEST: "stop_transcoder_request_message",
        STOP_TRANSCODER_REPLY: "stop_transcoder_reply_message",
        DESKSHARE_RTMP_BROADCAST_STARTED: "deskshare_rtmp_broadcast_started_message",
        DESKSHARE_RTMP_BROADCAST_STOPPED: "deskshare_rtmp_broadcast_stopped_message",
        GLOBAL_AUDIO_CONNECTED: "user_connected_to_global_audio",
        GLOBAL_AUDIO_DISCONNECTED: "user_disconnected_from_global_audio",
        DISCONNECT_ALL_USERS: "disconnect_all_users_message",
        DISCONNECT_USER: "disconnect_user_message",

        //Message identifiers 2x
        SCREENSHARE_RTMP_BROADCAST_STARTED_2x: "ScreenshareRtmpBroadcastStartedVoiceConfEvtMsg",
        SCREENSHARE_RTMP_BROADCAST_STOPPED_2x: "ScreenshareRtmpBroadcastStoppedVoiceConfEvtMsg",
        START_TRANSCODER_REQ_2x: "StartTranscoderSysReqMsg",
        START_TRANSCODER_RESP_2x: "StartTranscoderSysRespMsg",
        STOP_TRANSCODER_REQ_2x: "StopTranscoderSysReqMsg",
        STOP_TRANSCODER_RESP_2x: "StopTranscoderSysRespMsg",
        GLOBAL_AUDIO_CONNECTED_2x: "UserConnectedToGlobalAudioMsg",
        GLOBAL_AUDIO_DISCONNECTED_2x: "UserDisconnectedFromGlobalAudioMsg",
        DISCONNECT_ALL_USERS_2x: "DisconnectAllClientsSysMsg",
        USER_CAM_BROADCAST_STOPPED_2x: "UserBroadcastCamStopMsg",
        USER_CAM_BROADCAST_STARTED_2x: "UserBroadcastCamStartedEvtMsg",
        PRESENTER_ASSIGNED_2x: "PresenterAssignedEvtMsg",
        USER_JOINED_VOICE_CONF_MESSAGE_2x: "UserJoinedVoiceConfToClientEvtMsg",
        USER_LEFT_MEETING_2x: "UserLeftMeetingEvtMsg",

        STREAM_IS_RECORDED: "StreamIsRecordedMsg",

        START_WEBCAM_SHARE: "StartWebRTCShareEvent",
        STOP_WEBCAM_SHARE: "StopWebRTCShareEvent",

        // Redis messages fields
        //  Transcoder 1x
        USER_ID : "user_id",
        OPTIONS: "options",
        VOICE_CONF_ID : "voice_conf_id",
        TRANSCODER_ID : "transcoder_id",

        // Transcoder 2x
        USER_ID_2x : "userId",
        TRANSCODER_ID_2x : "transcoderId",
        MEETING_ID_2x: "meetingId",

        // Akka Apps 2x
        REQUESTED_BY: "requestedBy",

        //  Screenshare 2x
        CONFERENCE_NAME: "voiceConf",
        SCREENSHARE_CONF: "screenshareConf",
        STREAM_URL: "stream",
        TIMESTAMP: "timestamp",
        VIDEO_WIDTH: "vidWidth",
        VIDEO_HEIGHT: "vidHeight",
        HAS_AUDIO: "hasAudio",

        // Audio
        NAME: "name",
        USERID: "userid",

        // RTP params
        MEETING_ID : "meeting_id",
        VOICE_CONF : "voice_conf",
        KURENTO_ENDPOINT_ID : "kurento_endpoint_id",
        PARAMS : "params",
        MEDIA_DESCRIPTION: "media_description",
        LOCAL_IP_ADDRESS: "local_ip_address",
        LOCAL_VIDEO_PORT: "local_video_port",
        DESTINATION_IP_ADDRESS : "destination_ip_address",
        DESTINATION_VIDEO_PORT : "destination_video_port",
        REMOTE_VIDEO_PORT : "remote_video_port",
        CODEC_NAME: "codec_name",
        CODEC_ID: "codec_id",
        CODEC_RATE: "codec_rate",
        RTP_PROFILE: "rtp_profile",
        SEND_RECEIVE: "send_receive",
        FRAME_RATE: "frame_rate",
        INPUT: "input",
        KURENTO_TOKEN : "kurento_token",
        SCREENSHARE: "deskShare",
        STREAM_TYPE: "stream_type",
        STREAM_TYPE_SCREENSHARE: "stream_type_deskshare",
        STREAM_TYPE_VIDEO: "stream_type_video",
        RTP_TO_RTMP: "transcode_rtp_to_rtmp",
        TRANSCODER_CODEC: "codec",
        TRANSCODER_TYPE: "transcoder_type",
        CALLERNAME: "callername",

        EVENT_NAME: 'eventName',

        TIMESTAMP: 'timestamp',
        TIMESTAMP_UTC: 'timestampUTC',

        MODULE: 'module',
        MODULE_WEBCAM: 'bbb-webrtc-sfu',

        FILENAME: 'filename',

      // Log prefixes
        BASE_PROCESS_PREFIX: '[BaseProcess]',
        BASE_MANAGER_PREFIX: '[BaseManager]',
        BASE_PROVIDER_PREFIX: '[BaseProvider]',
        SCREENSHARE_PROCESS_PREFIX: '[ScreenshareProcess]',
        SCREENSHARE_MANAGER_PREFIX: '[ScreenshareManager]',
        SCREENSHARE_PROVIDER_PREFIX: '[ScreenshareProvider]',
        VIDEO_PROCESS_PREFIX: '[VideoProcess]',
        VIDEO_MANAGER_PREFIX: '[VideoManager]',
        VIDEO_PROVIDER_PREFIX: '[VideoProvider]',
        AUDIO_PROCESS_PREFIX: '[AudioProcess]',
        AUDIO_MANAGER_PREFIX: '[AudioManager]',
        AUDIO_PROVIDER_PREFIX: '[AudioProvider]',

        // MCS error codes
        MEDIA_SERVER_OFFLINE: 2001,

        // MCS Wrapper events
        MCS_CONNECTED: "MCS_CONNECTED",
        MCS_DISCONNECTED: "MCS_DISCONNECTED",

        // Media states'
        MEDIA_STATE: 'mediaState',
        MEDIA_STATE_ICE: 'onIceCandidate',

        MEDIA_STARTED: 'MEDIA_STARTED',
        MEDIA_NEGOTIATED: 'MEDIA_NEGOTIATED',
        MEDIA_NEGOTIATION_FAILED: 'MEDIA_NEGOTIATION_FAILED',
        MEDIA_STOPPED: 'MEDIA_STOPPED',
        MEDIA_STOPPING: "MEDIA_STOPPING",
        MEDIA_STARTING: 'MEDIA_STARTING',
        MEDIA_PAUSED: 'MEDIA_PAUSE',
        MEDIA_USER_JOINED: 'MEDIA_USER_JOINED'
    }
}

module.exports = Constants();

