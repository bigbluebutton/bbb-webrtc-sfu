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

const KEEPALIVE_INTERVAL = 15000;
const MAX_MISSED_KEEPALIVES = 3;

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
    this.container = null;
    this.containerDied = null;
    this.keepAliveInterval = null;
    this._missedKeepAlives = 0;

    this.onStopCallback = () => {};
    this.onStartCallback = () => {};

    this.botInTheHouse = false;

    this.imageName = config.get('bbb-stream.image_name');
    let bigbluebutton_url = config.get('bbb-stream.bigbluebutton_url');
    let secret = config.get('bbb-stream.bigbluebutton_secret');

    this.server = bbb.server(bigbluebutton_url, secret);
  }

  async start (callback) {
    Logger.info(LOG_PREFIX, "Starting streaming instance for", this.id);

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
          this.onStopCallback(reason);
	})
    }
    catch (err) {
      this.onStopCallback(err);
      Promise.reject(this._handleError(LOG_PREFIX, err, this.meetingId));
    }
  };

  // Take care of stream keepalive
  ping () {
    this._missedKeepAlives = 0;

    // Send the started message if the bot gets in the room
    if (!this.botInTheHouse) {
      this.botInTheHouse = true;

      this.onStart();
    }
  }

  startContainer(meetingUrl) {
    docker.container.create({
      Image: this.imageName,
      Env: [ `MEETING_URL=${meetingUrl}`, `STREAM_URL=${this.streamUrl}` ]
    })
    .then((c) => {
      this.container = c;
      Logger.debug(LOG_PREFIX, 'Created container', c.id);
      c.start();
      return c;
     })
    .then(() => {
      this.setupEvents(docker);
    })
    .catch(error => Logger.error(error));
  }

  setupEvents (docker) {

    const promisifyStream = stream => new Promise((resolve, reject) => {
      stream.on('data', (data) => {
	let dataJson = JSON.parse(data.toString());

	if (dataJson.id == this.container.id) {
	  Logger.debug('Container message', dataJson.status);

	  if (dataJson.status == 'die') {
	    this.containerDied = true;
	    this.stop(dataJson);
	  }

	  // Let's start whenthe bot is actually in the room
	  if (dataJson.status == 'start') {
            // this.onStartCallback();
	  }
	}
      });
    });

    docker.events({
      since: ((new Date().getTime() / 1000) - 60).toFixed(0)
    })
    .then(stream => promisifyStream(stream))
    .catch(error => Logger.error(LOG_PREFIX, 'container error', error));
  }

  stopContainer() {
    return this.containerDied ?
      Promise.resolve() :
      this.container.delete({force: true});
  };

  createStreamKeepAlive() {
    return setInterval(() => {
      this.missKeepAlive();

      Logger.info(LOG_PREFIX, 'Lost keepalive for ', this.meetingId, ' n: ', this.missedKeepAlives());
      if (this.missedKeepAlives() >= MAX_MISSED_KEEPALIVES) {
        Logger.warn('Missed all keepalives from the bot, tearing this down');
	this.stop();
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
