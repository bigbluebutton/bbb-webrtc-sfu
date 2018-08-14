'use strict';

const rid = require('readable-id');
const config = require('config');
const Logger = require('../../../utils/Logger');
const KMS_ARRAY = config.get('kurento');
const VIDEO_TRANSPOSING_CEILING = config.get('video-transposing-ceiling');
const AUDIO_TRANSPOSING_CEILING = config.get('audio-transposing-ceiling');
const mediaServerClient = require('kurento-client');
let instance = null;

class Balancer {
  constructor () {
    if (instance == null) {
      this.hosts = KMS_ARRAY.map(host => (
        {
          id: rid(),
          url: host.url,
          ip: host.ip,
          video: 0,
          audio: 0,
          client: null
        }));
      instance = this;
    }

    return instance;
  }

  _fetchAvailableHost () {
    let host = this.hosts.find(host => host.video < VIDEO_TRANSPOSING_CEILING &&
      host.audio < AUDIO_TRANSPOSING_CEILING);

    // Round robin if all instances are fully loaded
    if (host == null) {
      host = this.hosts.shift();
      this.hosts.push(host);
    }

    return host;
  }

  async getHost () {
    const host = this._fetchAvailableHost();
    Logger.info("[mcs-balancer] Chosen host is", host.id, host.url, host.ip, host.video, host.audio);
    host.client = await this._upstartMediaServerClient(host);
    return host;
  }

  _upstartMediaServerClient (host) {
    return new Promise((resolve, reject) => {
      try {
        const { url, ip } = host;
        if (host.client == null) {
          mediaServerClient(url, {failAfter: 1}, (error, client) => {
            if (error) {
              return reject(this._handleError(error));
            }
            resolve(client);
          })
        }
        else {
          return resolve();
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  decrementHostStreams (hostId, nature) {
    const host = this.hosts.find(host => host.id == hostId);
    host[nature]--;
    Logger.info("[mcs-balancer] Host", host.id, "streams decremented", { audio: host.audio }, { video: host.video });
  }

  incrementHostStreams (hostId, nature) {
    const host = this.hosts.find(host => host.id == hostId);
    host[nature]++;
    Logger.info("[mcs-balancer] Host", host.id, "streams incremented", { audio: host.audio }, { video: host.video });
  }
}

module.exports = new Balancer();
