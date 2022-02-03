const errors = require('../base/errors');
const config = require('config');
const Messaging = require('../bbb/messages/Messaging');
const C = require('../bbb/messages/Constants');

const PERMISSION_PROBES = config.get('permissionProbes');

const getCamBroadcastPermission = (
  gateway,
  meetingId,
  userId,
  streamId,
  sfuSessionId
) => {
  if (!PERMISSION_PROBES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onResp = (payload) => {
      if (meetingId === payload.meetingId
        && userId === payload.userId
        && streamId === payload.streamId
        && payload.allowed) {
        return resolve();
      }

      return reject(errors.SFU_UNAUTHORIZED);
    }

    const msg = Messaging.generateGetCamBroadcastPermissionReqMsg(
      meetingId,
      userId,
      streamId,
      sfuSessionId
    );

    gateway.once(C.GET_CAM_BROADCAST_PERM_RESP_MSG+sfuSessionId, onResp);
    gateway.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  });
}

const getCamSubscribePermission = (gateway, meetingId, userId, streamId, sfuSessionId) => {
  if (!PERMISSION_PROBES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onResp = (payload) => {
      if (meetingId === payload.meetingId
        && userId === payload.userId
        && payload.allowed) {
        return resolve();
      }

      return reject(errors.SFU_UNAUTHORIZED);
    }

    const msg = Messaging.generateGetCamSubscribePermissionReqMsg(
      meetingId,
      userId,
      streamId,
      sfuSessionId
    );

    const suffix = `${sfuSessionId}/${streamId}`;
    const enrichedEventId = `${C.GET_CAM_SUBSCRIBE_PERM_RESP_MSG}/${suffix}`
    gateway.once(enrichedEventId, onResp);
    gateway.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  });
}

module.exports = {
  getCamBroadcastPermission,
  getCamSubscribePermission,
}
