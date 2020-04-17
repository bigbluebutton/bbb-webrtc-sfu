'use strict';

const bbb = require('bbb-promise');

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const LOG_PREFIX = "[stream]";

const DockerSpawner = require('./containers/docker');
const KubernetesSpawner = require('./containers/kubernetes');

const KEEPALIVE_INTERVAL = 20000;
const MAX_MISSED_KEEPALIVES = 3;

let getJoinUrl = (server, meetingId) => {

  let room = server.monitoring.getMeetingInfo(meetingId);
  let options = config.has('bbb-stream.bot_join_options') ? config.get('bbb-stream.bot_join_options') : {};

  return room.then(function(meeting) {
    let response = meeting.response;

    return Promise.resolve(server.administration.join(config.get('bbb-stream.bot_name'), response.meetingID[0], response.attendeePW[0], options));
  });

}

const getContainerSpawner = (imageName, streamType, id, process) => {
  const containerType = config.get('bbb-stream.container_type');

  if (!containerType || containerType === 'docker') {
      return new DockerSpawner(imageName, streamType, id, process);
  }

  if (containerType === 'kubernetes') {
    return new KubernetesSpawner(imageName, streamType, id, process);
  }

};

module.exports = class Stream extends BaseProvider {
  constructor(_bbbGW, _id, _meetingId, _confname, _streamUrl, _streamType) {
    super();
    this.sfuApp = C.STREAM_APP;
    this.bbbGW = _bbbGW;
    this.id = _id;
    this.meetingId = _meetingId;
    this.confname = _confname;
    this.streamUrl = _streamUrl;
    this.streamType = _streamType;
    this.keepAliveInterval = null;
    this._missedKeepAlives = 0;

    this.onStopCallback = () => {};
    this.onStartCallback = () => {};

    this.botInTheHouse = false;

    this.imageName = config.get('bbb-stream.image_name');
    let bigbluebutton_url = config.get('bbb-stream.bigbluebutton_url');
    let secret = config.get('bbb-stream.bigbluebutton_secret');

    this.server = bbb.server(bigbluebutton_url, secret);

    this.containerSpawner = getContainerSpawner(this.imageName, this.streamType, this.id, this);
  }

  async start (callback) {
    Logger.info(LOG_PREFIX, "Starting streaming instance for", this.id, "type is:", this.streamType);

    try {
      getJoinUrl(this.server, this.meetingId).then((url) => {
        this.startContainer(url);

        this.keepAliveInterval = this.createStreamKeepAlive();
      });
      return callback(null);
    }
    catch (err) {
      return callback(this._handleError(LOG_PREFIX, err));
    }
  };

  async stop (reason = null) {
    Logger.info(LOG_PREFIX, 'Releasing stream for ', this.meetingId);

    try {
      clearInterval(this.keepAliveInterval);

      return this.stopContainer()
        .then(() => {
	  if (reason) {
            this.onStopCallback(reason);
	  }
	}).
        catch((err) => {
          Logger.error(LOG_PREFIX, "Problem stopping container", err);
	});
    }
    catch (err) {
      this.onStopCallback(err);
      Promise.reject(this._handleError(LOG_PREFIX, err, this.meetingId));
    }
  };

  startContainer(url) {
    return this.containerSpawner.startContainer(url, this.streamUrl);
  }

  stopContainer() {
    return this.containerSpawner.stopContainer();
  }

  // Take care of stream keepalive
  ping () {
    this._missedKeepAlives = 0;

    // Send the started message if the bot gets in the room
    if (!this.botInTheHouse) {
      this.botInTheHouse = true;

      this.onStartCallback();
    }
  }

  createStreamKeepAlive() {
    return setInterval(() => {
      this.missKeepAlive();

      Logger.info(LOG_PREFIX, 'Lost keepalive for ', this.meetingId, ' n: ', this.missedKeepAlives());
      if (this.missedKeepAlives() >= MAX_MISSED_KEEPALIVES) {
        Logger.warn('Missed all keepalives from the bot, tearing this down');
	this.stop('keepalive');
      }
    }, KEEPALIVE_INTERVAL);
  };

  missKeepAlive() {
    this._missedKeepAlives += 1;
  };

  missedKeepAlives() {
    return this._missedKeepAlives;
  };

  // Register an event to be called on stream stopping
  onStop (cb) {
    if (typeof cb == 'function') {
      this.onStopCallback = cb;
    } else {
      Logger.error(LOG_PREFIX, 'Passed an invalid function into onStop', cb);
    }
  }

  onStart (cb) {
    if (typeof cb == 'function') {
      this.onStartCallback = cb;
    } else {
      Logger.error(LOG_PREFIX, 'Passed an invalid function into onStart', cb);
    }
  }
};
