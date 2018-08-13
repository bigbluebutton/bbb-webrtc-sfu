'use strict';

const rid = require('readable-id');
const config = require('config');
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
    console.log("CHOSEN HOST", host);
    host.client = await this._upstartMediaServerClient(host);
    return host;
  }

  _upstartMediaServerClient (host) {
    return new Promise((resolve, reject) => {
      try {
        const { url, ip } = host;
        console.log("CONNECTING TO", url);
        if (host.client == null) {
          mediaServerClient(url, {failAfter: 1}, (error, client) => {
            if (error) {
              return reject(this._handleError(error));
            }
            resolve(client);
          })
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  decrementHostStreams (hostId, nature) {
    const host = this.hosts.find(host => host.id == hostId);
    host[nature]--;
    console.log(host.id, host.url, host.ip, host.video, host.audio);
  }

  incrementHostStreams (hostId, nature) {
    const host = this.hosts.find(host => host.id == hostId);
    host[nature]++;
    console.log(host.id, host.url, host.ip, host.video, host.audio);
  }
}

module.exports = new Balancer();
