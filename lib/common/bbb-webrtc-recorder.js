const EventEmitter = require('events').EventEmitter;
const config = require('config');
const RedisWrapper = require('../bbb/pubsub/RedisWrapper.js');
const Logger = require('./logger');

const {
  channels: CHANNELS,
} = config.get('bbbWebrtcRecorder')

const DEFAULT_PUB_CHANNEL = CHANNELS.publish;
const DEFAULT_SUB_CHANNEL = CHANNELS.subscribe;

// TODO centralize gateway and wrapper in commons
class BBBWebRTCRecorder extends EventEmitter {
  constructor(pubChannel, subChannel) {
    super();
    this.pubChannel = pubChannel;
    this.subscribers = {};
    this.publisher = null;
    this._addSubscribeChannel(subChannel);
  }

  checkPublisher() {
    if (!this.publisher) {
      this.publisher = new RedisWrapper();
      this.publisher.startPublisher();
    }
  }

  _addSubscribeChannel (channel) {
    if (this.subscribers[channel]) {
      return this.subscribers[channel];
    }

    let wrobj = new RedisWrapper(channel);
    this.subscribers[channel] = {};
    this.subscribers[channel] = wrobj;
    try {
      wrobj.startSubscriber();
      // TODO constant
      wrobj.on('redis_message', this.incomingMessage.bind(this));
      return Promise.resolve(wrobj);
    } catch (error) {
      Logger.error("Redis channel subscribe failed", { channel, errorMessage: error.message });
      return Promise.reject(error);
    }
  }

  _deserialize (message) {
    if (typeof message === 'object') return message;

    try {
      const dmsg = JSON.parse(message);
      return dmsg;
    } catch (error) {
      Logger.error("Failed to deserialize message, use it raw", { errorMessage: error.message });
      return message;
    }
  }

  _parseResponse(msg) {
    const { id, ...rest } = msg;

    return {
      id,
      payload: rest,
    };
  }

  _publish (message, channel) {
    this.checkPublisher();

    if (typeof this.publisher.publishToChannel === 'function') {
      this.publisher.publishToChannel(message, channel);
    }
  }

  incomingMessage (message) {
    const msg = this._deserialize(message);
    const { id, payload } = this._parseResponse(msg);
    const { recordingSessionId } = payload;
    // Trying to parse both message types, 1x and 2x

    if (id) {
      switch (id) {
        case 'startRecordingResponse':
          // {
          //   id: ‘startRecordingResponse’,
          //   recordingSessionId: <String>, // file name,
          //   status: ‘ok’ | ‘failed’,
          //   error: undefined | <String>,
          //   sdp: <String | undefined>, // answer
          // }
          //
          // falls through
        case 'recordingStopped':
          // {
          //   id: ‘recordingStopped’,
          //   recordingSessionId: <String>, // file name
          //   reason: <String>,
          //   timestampUTC: <Number>, // last written frame timestamp, UTC, wall clock
          //   timestampHR:  <Number> // last written frame timestamp, monotonic system time
          // }
          //
          // falls through
        case 'recordingRtpStatusChanged':
          // {
          //   id: ‘recordingRtpStatusChanged’, // media started or stopped flowing
          //   status: ‘flowing’ | ‘not_flowing’,
          //   recordingSessionId: <String>, // file name
          //   timestampUTC: <Number>, // latest/trigger frame ts, UTC
          //   timestampHR: <Number>, monotonic system time (latest/trigger frame ts),
          // }
          this.emit(`${id}:${recordingSessionId}`, payload);
          break;
        default:
          this.emit(id, { ...payload });
      }
    } else {
      // TODO constant
      this.emit('redis_message', msg);
    }
  }

  // {
  //   id: ‘startRecording’,
  //   recordingSessionId: <String> // requester-defined - error out if collision.
  //   sdp: <String>, // offer
  //   fileName: <String>, // file name INCLUDING format (.webm)
  // }
  // ```
  startRecording (recordingSessionId, fileName, sdp) {
    return new Promise((resolve, reject) => {
      try {
        const b64Offer = Buffer.from(JSON.stringify({ type: 'offer', sdp }))
          .toString('base64');

        this.once(`startRecordingResponse:${recordingSessionId}`, ({
          status,
          error = 'Unknown recording error',
          sdp: b64Answer,
        }) => {
          if (status !== 'ok') {
            reject(new Error(error));
            return;
          }

          try {
            const { sdp: answer } = JSON.parse(Buffer.from(b64Answer, 'base64').toString());
            resolve(answer);
          } catch (error) {
            reject(error);
          }
        });

        this._publish(JSON.stringify({
          id: 'startRecording',
          recordingSessionId,
          sdp: b64Offer,
          fileName,
        }), this.pubChannel);
      } catch (error) {
        reject(error);
      }
    });
  }

  // {
  //   id: ‘stopRecording’,
  //   recordingSessionId: <String>, // file name
  // }
  stopRecording (recordingSessionId) {
    return new Promise((resolve, reject) => {
      try {
        this.once(`recordingStopped:${recordingSessionId}`, ({
          reason,
          timestampUTC,
          timestampHR,
        }) => {
          // TODO use this upstream.
          resolve({ reason, timestampUTC, timestampHR });
        });

        this._publish(JSON.stringify({
          id: 'stopRecording',
          recordingSessionId,
        }), this.pubChannel);
      } catch (error) {
        reject(error);
      }
    });
  }
}

module.exports = {
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
  BBBWebRTCRecorder,
}
