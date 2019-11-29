const {Docker} = require('node-docker-api');
const config = require('config');

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

const Logger = require('../../utils/Logger');

const LOG_PREFIX = "[docker]";

module.exports = class DockerSpawner {
  constructor(imageName, streamType, meetingId, process) {
    this.imageName = imageName;
    this.container = null;
    this.containerDied = null;
    this.process = process;
    this.streamType = streamType;
    this.meetingId = meetingId;
  }

  startContainer(link, streamUrl) {

    const gopValues = config.get('bbb-stream.gop');
    const gop = gopValues[this.streamType] || gopValues.rtmp;

    try {
      docker.container.create({
        Image: this.imageName,
        Env: [ `LINK=${link}`, `OUTPUT=${streamUrl}`, `FORMAT=rtmp`, `GOP=${gop}` ],
        HostConfig: {
          AutoRemove: true,
        },
        name: `streaming_${this.meetingId}`,
      })
      .then((c) => {
        this.container = c;
        Logger.debug(LOG_PREFIX, 'Created container', c.id);
        c.start();
        return c;
       })
      .then(() => {
        this.setupEvents();
      });
    } catch(error) {
      Logger.error(error);
    }
  }

  stopContainer() {
    return this.containerDied ?
      Promise.resolve() :
      this.container.delete({force: true});
  };

  setupEvents () {

    const promisifyStream = stream => new Promise((resolve, reject) => {
      stream.on('data', (data) => {
        let dataJson = JSON.parse(data.toString());

        if (dataJson.id == this.container.id) {
          Logger.debug('Container message', dataJson.status);

          if (dataJson.status == 'die') {
            this.containerDied = true;
            this.process.onStopCallback(dataJson);
          }

          // Let's start when the bot is actually in the room
          if (dataJson.status == 'start') {
            // TODO: do we need to do anything when the container starts?
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
}
