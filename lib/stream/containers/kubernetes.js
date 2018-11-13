const k8s = require('@kubernetes/client-node');

const config = require('config');

const Logger = require('../../utils/Logger');

const LOG_PREFIX = "[k8s]";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sJobsApi = kc.makeApiClient(k8s.Batch_v1Api);
const k8sPodsApi = kc.makeApiClient(k8s.Core_v1Api);

const watch = new k8s.Watch(kc);

const jobTemplate = config.get('bbb-stream.k8s.template');
const jobNamespace = config.get('bbb-stream.k8s.namespace');

const K8S_POD_URL = '/api/v1/namespaces/default/pods/';
const K8S_JOB_URL = '/apis/batch/v1/namespaces/default/jobs';

let jobNumber = 0;

module.exports = class KubernetesSpawner {
  constructor(imageName, process) {
    this.imageName = imageName;
    this.process = process;
    this.uid = null;
    this.events = null;
    this.podName = null;
    this.jobName = null;

    this.running = false;
  }

  async startContainer(link, streamUrl) {
    let jobObject = {...jobTemplate};

    jobObject.spec.template.spec.containers[0].env[0].value = link;
    jobObject.spec.template.spec.containers[0].env[1].value = streamUrl;
    jobObject.metadata = { name: jobObject.metadata.name + jobNumber }; 

    jobNumber += 1;

    this.jobName = jobObject.metadata.name;

    await this._setupEvents();

    await k8sJobsApi.createNamespacedJob(jobNamespace, jobObject)
    .then((res) => {
      this.uid = res.body.metadata.uid;
      this.running = true;
    })
    .catch((err) => {
      Logger.error(LOG_PREFIX, 'ERROR creating container');
      this.process.onStopCallback(err);
    });
  }

  stopContainer() {
    const options = {
      gracePeriodSeconds: 0,
      propagationPolicy: 'Background',
      force: true
    };

    return k8sJobsApi.deleteNamespacedJob(this.jobName, jobNamespace, options, null, null, 0).then(() => {
      Logger.info(LOG_PREFIX, "Deleted stream job", this.jobName);

      this.running = false;

      k8sPodsApi.deleteNamespacedPod(this.podName, jobNamespace, options, null, null, 0)
      .then((res) => {
	Logger.info(LOG_PREFIX, "Successfully delete container", this.podName); 
        this._abortEvents();
      }).
      catch((err) => {
        this._abortEvents();
      });
    })
    .catch((err) => {
      Logger.error(LOG_PREFIX, "Problem deleting container", err);
      this._abortEvents();
    });
  }

  async _setupEvents() {
    let eventStream = (type, obj) => {
      if (!this.running && type !== 'DELETED') {
        Logger.info(LOG_PREFIX, "Ignoring events because it's not running anymore");
	return;
      }

      // console.log(obj);
      if (type == 'ADDED') {
        if (obj.kind == 'Pod' && (this.jobName + '-') === obj.metadata.generateName) {
	  this.podName = obj.metadata.name;
	}
      } else if (type == 'MODIFIED') {
        //
      } else if (type == 'DELETED') {
        //
	if (obj.kind == 'Job' && this.jobName === obj.metadata.name) {
          Logger.info(LOG_PREFIX, 'Send post-stop callback');
          this.process.onStopCallback();
        }
      } else {
        Logger.error(LOG_PREFIX, 'unknown type: ' + type);
      }
    };
    let errFunc = (err) => {
      Logger.info(LOG_PREFIX, "Stopped monitoring events err:", err);
    };

    this.podEvents = await watch.watch(K8S_POD_URL, {}, eventStream, errFunc); 
    this.jobEvents = await watch.watch(K8S_JOB_URL, {}, eventStream, errFunc);
  }

  _abortEvents() {
    this.jobEvents.abort();
    this.podEvents.abort();
    this.jobEvents = null;
    this.podEvents = null;
  }
}


