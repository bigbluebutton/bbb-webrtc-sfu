const Constants = require('./Constants.js');

// Messages

let OutMessage = require('./OutMessage.js');

let StartTranscoderRequestMessage =
    require('./transcode/StartTranscoderRequestMessage.js')(Constants);
let StopTranscoderRequestMessage =
    require('./transcode/StopTranscoderRequestMessage.js')(Constants);
let StartTranscoderSysReqMsg =
    require('./transcode/StartTranscoderSysReqMsg.js')();
let StopTranscoderSysReqMsg =
    require('./transcode/StopTranscoderSysReqMsg.js')();
let DeskShareRTMPBroadcastStartedEventMessage =
    require('./screenshare/DeskShareRTMPBroadcastStartedEventMessage.js')(Constants);
let DeskShareRTMPBroadcastStoppedEventMessage =
    require('./screenshare/DeskShareRTMPBroadcastStoppedEventMessage.js')(Constants);
let ScreenshareRTMPBroadcastStartedEventMessage2x =
    require('./screenshare/ScreenshareRTMPBroadcastStartedEventMessage2x.js')(Constants);
let ScreenshareRTMPBroadcastStoppedEventMessage2x =
    require('./screenshare/ScreenshareRTMPBroadcastStoppedEventMessage2x.js')(Constants);
let UserCamBroadcastStoppedEventMessage2x =
    require('./video/UserCamBroadcastStoppedEventMessage2x.js')(Constants);
let WebRTCShareEvent = require('./video/WebRTCShareEvent.js')(Constants);
let RecordingStatusRequestMessage2x =
    require('./recording/RecordingStatusRequestMessage2x.js')(Constants);
let UserConnectedToGlobalAudio =
    require('./audio/UserConnectedToGlobalAudio.js')(Constants);
let UserDisconnectedFromGlobalAudio =
    require('./audio/UserDisconnectedFromGlobalAudio.js')(Constants);
let UserConnectedToGlobalAudio2x =
    require('./audio/UserConnectedToGlobalAudio2x.js')(Constants);
let UserDisconnectedFromGlobalAudio2x =
    require('./audio/UserDisconnectedFromGlobalAudio2x.js')(Constants);

/**
 * @classdesc
 * Messaging utils to assemble JSON/Redis BigBlueButton messages
 * @constructor
 */
function Messaging() {}

Messaging.prototype.generateStartTranscoderRequestMessage =
  function(meetingId, transcoderId, params) {
  let statrm = new StartTranscoderSysReqMsg(meetingId, transcoderId, params);
  return statrm.toJson();
}

Messaging.prototype.generateStopTranscoderRequestMessage =
  function(meetingId, transcoderId) {
  let stotrm = new StopTranscoderSysReqMsg(meetingId, transcoderId);
  return stotrm.toJson();
}

Messaging.prototype.generateDeskShareRTMPBroadcastStartedEvent =
  function(conferenceName, streamUrl, vw, vh, timestamp) {
  let stadrbem = new DeskShareRTMPBroadcastStartedEventMessage(conferenceName, streamUrl, vw, vh, timestamp);
  return stadrbem.toJson();
}

Messaging.prototype.generateDeskShareRTMPBroadcastStoppedEvent =
  function(conferenceName, streamUrl, vw, vh, timestamp) {
  let stodrbem = new DeskShareRTMPBroadcastStoppedEventMessage(conferenceName, streamUrl, vw, vh, timestamp);
  return stodrbem.toJson();
}

Messaging.prototype.generateScreenshareRTMPBroadcastStartedEvent2x =
  function(conferenceName, screenshareConf, streamUrl, vw, vh, timestamp, hasAudio) {
  let stadrbem = new ScreenshareRTMPBroadcastStartedEventMessage2x(conferenceName, screenshareConf, streamUrl, vw, vh, timestamp, hasAudio);
  return stadrbem.toJson();
}

Messaging.prototype.generateScreenshareRTMPBroadcastStoppedEvent2x =
  function(conferenceName, screenshareConf, streamUrl, vw, vh, timestamp) {
  let stodrbem = new ScreenshareRTMPBroadcastStoppedEventMessage2x(conferenceName, screenshareConf, streamUrl, vw, vh, timestamp);
  return stodrbem.toJson();
}

Messaging.prototype.generateUserCamBroadcastStoppedEventMessage2x =
  function(meetingId, userId, streamUrl) {
  let stodrbem = new UserCamBroadcastStoppedEventMessage2x(meetingId, userId, streamUrl);
  return stodrbem.toJson();
}

Messaging.prototype.generateWebRTCShareEvent =
  function(name, meetingId, streamUrl, timestampHR, timestampUTC) {
  let stodrbem = new WebRTCShareEvent(name, meetingId, streamUrl, timestampHR, timestampUTC);
  return stodrbem.payload;
}

Messaging.prototype.generateRecordingStatusRequestMessage =
  function(meetingId, userId = '') {
    let rsqm = new RecordingStatusRequestMessage2x(meetingId, userId);
    return rsqm.toJson();
}

Messaging.prototype.generateUserConnectedToGlobalAudioMessage =
  function(voiceConf, userId, name) {
  let msg;
  switch (Constants.COMMON_MESSAGE_VERSION) {
    case "1.x":
      msg = new UserConnectedToGlobalAudio(voiceConf, userId, name);
      break;
    default:
      msg = new UserConnectedToGlobalAudio2x(voiceConf, userId, name);
  }
  return msg.toJson();
}

Messaging.prototype.generateUserDisconnectedFromGlobalAudioMessage =
  function(voiceConf, userId, name) {
  let msg;
  switch (Constants.COMMON_MESSAGE_VERSION) {
    case "1.x":
      msg = new UserDisconnectedFromGlobalAudio(voiceConf, userId, name);
      break;
    default:
      msg = new UserDisconnectedFromGlobalAudio2x(voiceConf, userId, name);
  }
  return msg.toJson();
}

module.exports = new Messaging();
