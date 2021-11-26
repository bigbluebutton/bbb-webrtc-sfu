const ScreenshareRTMPBroadcastStartedEventMessage2x =
  require('./screenshare/ScreenshareRTMPBroadcastStartedEventMessage2x.js');
const ScreenshareRTMPBroadcastStoppedEventMessage2x =
  require('./screenshare/ScreenshareRTMPBroadcastStoppedEventMessage2x.js');
const UserCamBroadcastStoppedEventMessage2x =
  require('./video/UserCamBroadcastStoppedEventMessage2x.js');
const WebRTCShareEvent = require('./recording/WebRTCShareEvent.js');
const RecordingStatusRequestMessage2x =
  require('./recording/RecordingStatusRequestMessage2x.js');
const UserConnectedToGlobalAudio2x =
  require('./audio/UserConnectedToGlobalAudio2x.js');
const UserDisconnectedFromGlobalAudio2x =
  require('./audio/UserDisconnectedFromGlobalAudio2x.js');
const GetGlobalAudioPermissionReqMsg =
  require('./audio/GetGlobalAudioPermissionReqMsg.js');
const GetScreenBroadcastPermissionReqMsg =
  require('./screenshare/GetScreenBroadcastPermissionReqMsg.js');
const GetScreenSubscribePermissionReqMsg=
  require('./screenshare/GetScreenSubscribePermissionReqMsg.js');
const GetCamBroadcastPermissionReqMsg =
  require('./video/GetCamBroadcastPermissionReqMsg.js');
const GetCamSubscribePermissionReqMsg =
  require('./video/GetCamSubscribePermissionReqMsg.js');
const CamStreamSubscribedInSfuEvtMsg =
  require('./video/CamStreamSubscribedInSfuEvtMsg.js');
const CamStreamUnsubscribedInSfuEvtMsg =
  require('./video/CamStreamUnsubscribedInSfuEvtMsg.js');
const CamBroadcastStoppedInSfuEvtMsg =
  require('./video/CamBroadcastStoppedInSfuEvtMsg.js');

module.exports = {
  generateScreenshareRTMPBroadcastStartedEvent2x: (
    conferenceName, screenshareConf, streamUrl, vw, vh, timestamp, hasAudio
  ) => {
    return (new ScreenshareRTMPBroadcastStartedEventMessage2x(
      conferenceName, screenshareConf, streamUrl, vw, vh, timestamp, hasAudio
    )).toJson();
  },

  generateScreenshareRTMPBroadcastStoppedEvent2x: (
    conferenceName, screenshareConf, streamUrl, vw, vh, timestamp
  ) => {
    return (new ScreenshareRTMPBroadcastStoppedEventMessage2x(
      conferenceName, screenshareConf, streamUrl, vw, vh, timestamp)
    ).toJson();
  },

  generateUserCamBroadcastStoppedEventMessage2x: (meetingId, userId, streamUrl) => {
    return (new UserCamBroadcastStoppedEventMessage2x(meetingId, userId, streamUrl))
      .toJson();
  },

  generateWebRTCShareEvent: (
    name, meetingId, streamUrl, timestampHR, timestampUTC
  ) => {
    return (new WebRTCShareEvent(name, meetingId, streamUrl, timestampHR, timestampUTC)).payload;
  },

  // FIXME what the asjdkasjdl is that default userId parameter
  generateRecordingStatusRequestMessage: (meetingId, userId = '') => {
    return (new RecordingStatusRequestMessage2x(meetingId, userId)).toJson();
  },

  generateUserConnectedToGlobalAudioMessage: (voiceConf, userId, name) => {
    return (new UserConnectedToGlobalAudio2x(voiceConf, userId, name)).toJson();
  },

  generateUserDisconnectedFromGlobalAudioMessage: (voiceConf, userId, name) => {
    return (new UserDisconnectedFromGlobalAudio2x(voiceConf, userId, name)).toJson();
  },

  generateGetGlobalAudioPermissionReqMsg: (
    meetingId, voiceConf, userId, sfuSessionId
  ) => {
    return (new GetGlobalAudioPermissionReqMsg(meetingId, voiceConf, userId, sfuSessionId)).toJson();
  },

  generateGetScreenBroadcastPermissionReqMsg: (
    meetingId, voiceConf, userId, sfuSessionId
  ) => {
    return (new GetScreenBroadcastPermissionReqMsg(meetingId, voiceConf, userId, sfuSessionId)).toJson();
  },

  generateGetScreenSubscribePermissionReqMsg: (
    meetingId, voiceConf, userId, streamId, sfuSessionId
  ) => {
    return (new GetScreenSubscribePermissionReqMsg(
      meetingId, voiceConf, userId, streamId, sfuSessionId
    )).toJson();
  },

  generateGetCamBroadcastPermissionReqMsg: (
    meetingId, userId, sfuSessionId
  ) => {
    return (new GetCamBroadcastPermissionReqMsg(meetingId, userId, sfuSessionId)).toJson();
  },

  generateGetCamSubscribePermissionReqMsg: (
    meetingId, userId, streamId, sfuSessionId
  ) => {
    return (new GetCamSubscribePermissionReqMsg(
      meetingId, userId, streamId, sfuSessionId
    )).toJson();
  },

  generateCamStreamSubscribedInSfuEvtMsg: (
    meetingId, userId, streamId, subscriberStreamId, sfuSessionId
  ) => {
    return (new CamStreamSubscribedInSfuEvtMsg(
      meetingId, userId, streamId, subscriberStreamId, sfuSessionId
    )).toJson();
  },

  generateCamStreamUnsubscribedInSfuEvtMsg: (
    meetingId, userId, streamId, subscriberStreamId, sfuSessionId
  ) => {
    return (new CamStreamUnsubscribedInSfuEvtMsg(
      meetingId, userId, streamId, subscriberStreamId, sfuSessionId
    )).toJson();
  },

  generateCamBroadcastStoppedInSfuEvtMsg: (
    meetingId, userId, streamId
  ) => {
    return (new CamBroadcastStoppedInSfuEvtMsg(
      meetingId, userId, streamId
    )).toJson();
  },
}
