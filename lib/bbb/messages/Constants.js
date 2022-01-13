"use strict";

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
        LISTEN_ONLY_APP: 'audio',

        // SFU requisition roles
        SEND_ROLE: 'send',
        RECV_ROLE: 'recv',
        SEND_RECV_ROLE: 'sendrecv',

        // Provider events
        VIDEO_NEGOTIATED: "videoNegotiated",
        VIDEO_STOPPED: "videoStopped",

        // Redis channels
        TO_BBB_MEETING_CHAN: "bigbluebutton:to-bbb-apps:meeting",
        FROM_BBB_MEETING_CHAN: "bigbluebutton:from-bbb-apps:meeting",
        TO_AKKA_APPS_CHAN_2x: "to-akka-apps-redis-channel",
        FROM_SCREENSHARE: 'from-screenshare',
        TO_SCREENSHARE: 'to-sfu-screenshare',
        FROM_VIDEO: 'from-sfu-video',
        TO_VIDEO: 'to-sfu-video',
        FROM_AUDIO: 'from-sfu-audio',
        TO_AUDIO: 'to-sfu-audio',
        TO_AKKA_APPS: 'to-akka-apps-redis-channel',
        FROM_AKKA_APPS: 'from-akka-apps-redis-channel',
        FROM_LISTEN_ONLY: 'from-sfu-listen-only',
        TO_LISTEN_ONLY: 'to-sfu-listen-only',
        FROM_SFU: 'from-sfu-redis-channel',
        TO_SFU: 'to-sfu-redis-channel',

        // RedisWrapper events
        REDIS_MESSAGE : "redis_message",
        CLIENT_REQ: "client_req",
        GATEWAY_MESSAGE: "gateway_message",

        RECORDING_STATUS_REQUEST_MESSAGE_2x: "GetRecordingStatusReqMsg",
        RECORDING_STATUS_REPLY_MESSAGE_2x: "GetRecordingStatusRespMsg",

        // Message identifiers 1x
        GLOBAL_AUDIO_CONNECTED: "user_connected_to_global_audio",
        GLOBAL_AUDIO_DISCONNECTED: "user_disconnected_from_global_audio",
        DISCONNECT_ALL_USERS: "disconnect_all_users_message",
        DISCONNECT_USER: "disconnect_user_message",

        //Message identifiers 2x
        SCREENSHARE_RTMP_BROADCAST_STARTED_2x: "ScreenshareRtmpBroadcastStartedVoiceConfEvtMsg",
        SCREENSHARE_RTMP_BROADCAST_STOPPED_2x: "ScreenshareRtmpBroadcastStoppedVoiceConfEvtMsg",
        GLOBAL_AUDIO_CONNECTED_2x: "UserConnectedToGlobalAudioMsg",
        GLOBAL_AUDIO_DISCONNECTED_2x: "UserDisconnectedFromGlobalAudioMsg",
        DISCONNECT_ALL_USERS_2x: "DisconnectAllClientsSysMsg",
        USER_CAM_BROADCAST_STOPPED_2x: "UserBroadcastCamStopMsg",
        USER_CAM_BROADCAST_STARTED_2x: "UserBroadcastCamStartedEvtMsg",
        PRESENTER_ASSIGNED_2x: "PresenterAssignedEvtMsg",
        USER_JOINED_VOICE_CONF_MESSAGE_2x: "UserJoinedVoiceConfToClientEvtMsg",
        USER_LEFT_MEETING_2x: "UserLeftMeetingEvtMsg",
        GET_GLOBAL_AUDIO_PERM_REQ_MSG: "GetGlobalAudioPermissionReqMsg",
        GET_GLOBAL_AUDIO_PERM_RESP_MSG: "GetGlobalAudioPermissionRespMsg",
        GET_SCREEN_BROADCAST_PERM_REQ_MSG: "GetScreenBroadcastPermissionReqMsg",
        GET_SCREEN_BROADCAST_PERM_RESP_MSG: "GetScreenBroadcastPermissionRespMsg",
        GET_SCREEN_SUBSCRIBE_PERM_REQ_MSG: "GetScreenSubscribePermissionReqMsg",
        GET_SCREEN_SUBSCRIBE_PERM_RESP_MSG: "GetScreenSubscribePermissionRespMsg",
        SCREEN_BROADCAST_STOP_SYS_MSG: "ScreenBroadcastStopSysMsg",
        GET_CAM_BROADCAST_PERM_REQ_MSG: "GetCamBroadcastPermissionReqMsg",
        GET_CAM_BROADCAST_PERM_RESP_MSG: "GetCamBroadcastPermissionRespMsg",
        GET_CAM_SUBSCRIBE_PERM_REQ_MSG: "GetCamSubscribePermissionReqMsg",
        GET_CAM_SUBSCRIBE_PERM_RESP_MSG: "GetCamSubscribePermissionRespMsg",
        CAM_STREAM_UNSUBSCRIBE_SYS_MSG: "CamStreamUnsubscribeSysMsg",
        CAM_BROADCAST_STOP_SYS_MSG: "CamBroadcastStopSysMsg",

        STREAM_IS_RECORDED: "StreamIsRecordedMsg",

        START_WEBCAM_SHARE: "StartWebRTCShareEvent",
        STOP_WEBCAM_SHARE: "StopWebRTCShareEvent",

        // Redis messages fields
        USER_ID : "user_id",
        OPTIONS: "options",
        VOICE_CONF_ID : "voice_conf_id",
        USER_ID_2x : "userId",
        MEETING_ID_2x: "meetingId",
        VOICE_CONF_2x: "voiceConf",
        SFU_SESSION_ID: "sfuSessionId",
        STREAM_ID: "streamId",
        SUBSCRIBER_STREAM_ID: "subscriberStreamId",

        // Akka Apps 2x
        REQUESTED_BY: "requestedBy",

        //  Screenshare 2x
        CONFERENCE_NAME: "voiceConf",
        SCREENSHARE_CONF: "screenshareConf",
        STREAM_URL: "stream",
        VIDEO_WIDTH: "vidWidth",
        VIDEO_HEIGHT: "vidHeight",
        HAS_AUDIO: "hasAudio",

        // Audio
        NAME: "name",
        USERID: "userid",

        // RTP params
        MEETING_ID : "meeting_id",
        VOICE_CONF : "voice_conf",

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
        LISTENONLY_PROCESS_PREFIX: '[ListenOnlyProcess]',
        LISTENONLY_MANAGER_PREFIX: '[ListenOnlyManager]',
        LISTENONLY_PROVIDER_PREFIX: '[ListenOnly]',
        SCREENSHARE_PROCESS_PREFIX: '[ScreenshareProcess]',
        SCREENSHARE_MANAGER_PREFIX: '[ScreenshareManager]',
        SCREENSHARE_PROVIDER_PREFIX: '[ScreenshareProvider]',
        VIDEO_PROCESS_PREFIX: '[VideoProcess]',
        VIDEO_MANAGER_PREFIX: '[VideoManager]',
        VIDEO_PROVIDER_PREFIX: '[VideoProvider]',
        AUDIO_PROCESS_PREFIX: '[AudioProcess]',
        AUDIO_MANAGER_PREFIX: '[AudioManager]',
        AUDIO_PROVIDER_PREFIX: '[AudioProvider]',
        FULLAUDIO_PROCESS_PREFIX: '[FullAudioProcess]',
        FULLAUDIO_MANAGER_PREFIX: '[FullAudioManager]',

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

