'use strict';

const bbb = require('bbb-promise');

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const LOG_PREFIX = "[stream]";

const {Docker} = require('node-docker-api');

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

let getJoinUrl = (server, meetingId) => {

  let room = server.monitoring.getMeetingInfo(meetingId);
  let options = {
    'userdata-html5recordingbot': true,
    'joinViaHtml5': true
  };

  return room.then(function(meeting) {
    let response = meeting.response;

    return Promise.resolve(server.administration.join("Streaming BOT", response.meetingID[0], response.attendeePW[0], options));
  });

}

module.exports = class Stream extends BaseProvider {
  constructor(_bbbGW, _id, _meetingId, _streamUrl) {
    super();
    this.sfuApp = C.STREAM_APP;
    this.bbbGW = _bbbGW;
    this.id = _id;
    this.meetingId = _meetingId;
    this.streamUrl = _streamUrl;
    this.containers = {};

    let bigbluebutton_url = config.get('bbb-stream.bigbluebutton_url');
    let secret = config.get('bbb-stream.bigbluebutton_secret');

    this.server = bbb.server(bigbluebutton_url, secret);
  }

  async start (callback) {
    Logger.info(LOG_PREFIX, "Starting streaming instance for", this.id);

    try {
      getJoinUrl(this.server, this.meetingId).then((url) => {
        this.startContainer(url);
      });
      return callback(null);
    }
    catch (err) {
      return callback(this._handleError(LOG_PREFIX, err));
    }
  };

  async stop () {
    Logger.info(LOG_PREFIX, 'Releasing stream for ', this.meetingId);

    try {
      await this.stopContainer();
      return Promise.resolve();
    }
    catch (err) {

      return Promise.reject(this._handleError(LOG_PREFIX, err, this.userId));
    }
  };

  // Take care of stream keepalive
  ping () {

  }

  //
  startContainer(meetingUrl) {
    const Image = config.get('bbb-stream.image_name');

    docker.container.create({
      Image,
      Env: [ `MEETING_URL=${meetingUrl}`, `STREAM_URL=${this.streamUrl}` ]
    })
    .then((c) => {
      this.container = c;
      c.start();
      return c;
     })
     .then(c => c.logs({
      follow: true, stdout: true, stderr: true
    }))
    .then(stream => {
      stream.on('data', info => Logger.info(info.toString('utf8')));
      stream.on('error', err => Logger.info(err.toString('utf8')));
    })
    .catch(error => Logger.error(error));
  }

  stopContainer() {
    return this.container
      .stop()
      .delete();
  };

};
