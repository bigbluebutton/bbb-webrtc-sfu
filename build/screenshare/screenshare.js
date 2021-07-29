/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const C = require('../bbb/messages/Constants');
const Utils = require('../utils/Utils.js');
const Messaging = require('../bbb/messages/Messaging');
const { Logger } = require('../utils/Logger');
const BaseProvider = require('../base/BaseProvider');
const config = require('config');
const errors = require('../base/errors');
const SHOULD_RECORD = config.get('recordScreenSharing');
const DEFAULT_MEDIA_SPECS = config.get('conference-media-specs');
// Unfreeze the config's default media specs
const DEFAULT_MEDIA_SPECS_UNFROZEN = config.util.cloneDeep(config.get('conference-media-specs'));
const SUBSCRIBER_SPEC_SLAVE = config.has('videoSubscriberSpecSlave')
    ? config.get('videoSubscriberSpecSlave')
    : false;
const KURENTO_REMB_PARAMS = config.util.cloneDeep(config.get('kurentoRembParams'));
const SCREENSHARE_PLAY_START_ENABLED = config.has(`screensharePlayStartEnabled`)
    ? config.get(`screensharePlayStartEnabled`)
    : false;
const SCREENSHARE_SERVER_AKKA_BROADCAST = config.has(`screenshareServerSideAkkaBroadcast`)
    ? config.get(`screenshareServerSideAkkaBroadcast`)
    : true;
const PERMISSION_PROBES = config.get('permissionProbes');
const MEDIA_FLOW_TIMEOUT_DURATION = config.get('mediaFlowTimeoutDuration');
const LOG_PREFIX = "[screenshare]";
module.exports = class Screenshare extends BaseProvider {
    static getCustomMediaSpec(bitrate) {
        const spec = Object.assign({}, DEFAULT_MEDIA_SPECS_UNFROZEN);
        if (bitrate != null) {
            Utils.addBwToSpecContentType(spec, bitrate);
        }
        return spec;
    }
    constructor(id, bbbGW, voiceBridge, userId, vh, vw, meetingId, mcs, hasAudio) {
        super(bbbGW);
        this.sfuApp = C.SCREENSHARE_APP;
        this.mcs = mcs;
        this.presenterMCSUserId;
        this.userId = userId;
        this._connectionId = id;
        this._presenterEndpoint = null;
        this._voiceBridge = voiceBridge;
        this.meetingId = meetingId;
        this._streamUrl = "";
        this._vw = vw;
        this._vh = vh;
        this._presenterCandidatesQueue = [];
        this._viewerUsers = {};
        this._viewerEndpoints = [];
        this._viewersCandidatesQueue = [];
        this.status = C.MEDIA_STOPPED;
        this._rtmpBroadcastStarted = false;
        this.recording = {};
        this.isRecorded = false;
        this._recordingSubPath = 'screenshare';
        this._startRecordingEventFired = false;
        this._stopRecordingEventFired = false;
        this.hasAudio = hasAudio;
        this._mediaFlowingTimeouts = {};
        this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
        this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
    }
    set status(status) {
        this._status = status;
        this.emit(status);
    }
    get status() {
        return this._status;
    }
    _getPartialLogMetadata() {
        return {
            roomId: this._voiceBridge,
            internalMeetingId: this.meetingId,
            status: this.status,
        };
    }
    _getFullPresenterLogMetadata(connectionId) {
        return Object.assign(Object.assign({}, this._getPartialLogMetadata()), { userId: this.presenterMCSUserId, mediaId: this._presenterEndpoint, connectionId, role: `presenter` });
    }
    _getFullViewerLogMetadata(connectionId) {
        const { userId } = this._viewerUsers[connectionId] || {};
        const mediaId = this._viewerEndpoints[connectionId];
        return Object.assign(Object.assign({}, this._getPartialLogMetadata()), { userId,
            mediaId,
            connectionId, role: `viewer` });
    }
    getConnectionIdAndRole(userId) {
        if (this.presenterMCSUserId === userId)
            return { connectionId: this._connectionId, role: C.RECV_ROLE };
        for (const connectionId in this._viewerUsers) {
            if (this._viewerUsers.hasOwnProperty(connectionId)) {
                const user = this._viewerUsers[connectionId];
                if (user.hasOwnProperty('userId') && user['userId'] === userId) {
                    return { connectionId, role: C.RECV_ROLE };
                }
            }
        }
    }
    ;
    /* ======= ICE HANDLERS ======= */
    onIceCandidate(candidate, role, userId, connectionId) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (role) {
                case C.SEND_ROLE:
                    if (this._presenterEndpoint) {
                        try {
                            this.flushCandidatesQueue(this.mcs, [...this._presenterCandidatesQueue], this._presenterEndpoint);
                            this._presenterCandidatesQueue = [];
                            yield this.mcs.addIceCandidate(this._presenterEndpoint, candidate);
                        }
                        catch (error) {
                            Logger.error(LOG_PREFIX, `ICE candidate could not be added to media controller due to ${error.message}.`, Object.assign(Object.assign({}, this._getFullPresenterLogMetadata(connectionId)), { error }));
                        }
                    }
                    else {
                        this._presenterCandidatesQueue.push(candidate);
                    }
                    break;
                case C.RECV_ROLE:
                    let endpoint = this._viewerEndpoints[connectionId];
                    if (endpoint) {
                        try {
                            this.flushCandidatesQueue(this.mcs, [...this._viewersCandidatesQueue[connectionId]], endpoint);
                            this._viewersCandidatesQueue[connectionId] = [];
                            yield this.mcs.addIceCandidate(endpoint, candidate);
                        }
                        catch (error) {
                            Logger.error(LOG_PREFIX, `ICE candidate could not be added to media controller due to ${error.message}.`, Object.assign(Object.assign({}, this._getFullViewerLogMetadata(connectionId)), { error }));
                        }
                    }
                    else {
                        this._viewersCandidatesQueue[connectionId] = [];
                        this._viewersCandidatesQueue[connectionId].push(candidate);
                    }
                    break;
                default:
                    Logger.warn(LOG_PREFIX, "Unknown role", role);
            }
        });
    }
    _onMCSIceCandidate(event, connectionId, endpoint) {
        const { mediaId, candidate } = event;
        if (mediaId !== endpoint) {
            return;
        }
        const isPresenter = this.connectionId === connectionId;
        const logMetadata = isPresenter
            ? this._getFullPresenterLogMetadata(connectionId)
            : this._getFullViewerLogMetadata(connectionId);
        Logger.debug(LOG_PREFIX, "Received ICE candidate from mcs-core", Object.assign(Object.assign({}, logMetadata), { candidate }));
        this.sendToClient({
            connectionId,
            type: C.SCREENSHARE_APP,
            id: 'iceCandidate',
            candidate: candidate
        }, C.FROM_SCREENSHARE);
    }
    /* ======= MEDIA STATE HANDLERS ======= */
    setMediaFlowingTimeout(connectionId) {
        if (!this._mediaFlowingTimeouts[connectionId]) {
            Logger.debug(LOG_PREFIX, `Presenter NOT_FLOWING timeout set`, Object.assign(Object.assign({}, this._getFullPresenterLogMetadata(connectionId)), { MEDIA_FLOW_TIMEOUT_DURATION }));
            this._mediaFlowingTimeouts[connectionId] = setTimeout(() => {
                this._onPresenterMediaNotFlowingTimeout(connectionId);
            }, MEDIA_FLOW_TIMEOUT_DURATION);
        }
    }
    clearMediaFlowingTimeout(connectionId) {
        if (this._mediaFlowingTimeouts[connectionId]) {
            Logger.debug(LOG_PREFIX, `clearMediaFlowingTimeout for presenter ${connectionId}`, this._getFullPresenterLogMetadata(connectionId));
            clearTimeout(this._mediaFlowingTimeouts[connectionId]);
            delete this._mediaFlowingTimeouts[connectionId];
        }
    }
    _onPresenterMediaNotFlowingTimeout(connectionId) {
        Logger.error(LOG_PREFIX, `Presenter WebRTC media NOT_FLOWING timeout reached`, this._getFullPresenterLogMetadata(connectionId));
        this.sendToClient({
            type: C.SCREENSHARE_APP,
            id: 'stopSharing',
            connectionId,
            error: { code: 2211, reason: errors[2211] },
        }, C.FROM_SCREENSHARE);
    }
    ;
    _onPresenterMediaFlowing(connectionId) {
        if (!this._rtmpBroadcastStarted) {
            Logger.info(LOG_PREFIX, "Presenter WebRTC session began FLOWING", this._getFullPresenterLogMetadata(connectionId));
            this._startRtmpBroadcast(this.meetingId);
            if (this.status != C.MEDIA_STARTED) {
                if (this.isRecorded) {
                    this.startRecording();
                }
                this.status = C.MEDIA_STARTED;
                this.sendPlayStart(C.SEND_ROLE, connectionId);
            }
        }
        this.clearMediaFlowingTimeout(connectionId);
    }
    ;
    _onPresenterMediaNotFlowing(connectionId) {
        Logger.debug(LOG_PREFIX, `Presenter WebRTC session is NOT_FLOWING`, this._getFullPresenterLogMetadata(connectionId));
        this.setMediaFlowingTimeout(connectionId);
    }
    sendPlayStart(role, connectionId) {
        if (SCREENSHARE_PLAY_START_ENABLED) {
            this.sendToClient({
                type: C.SCREENSHARE_APP,
                id: 'playStart',
                connectionId,
                role,
            }, C.FROM_SCREENSHARE);
        }
    }
    _onViewerWebRTCMediaFlowing(connectionId) {
        const viewerUser = this._viewerUsers[connectionId];
        if (viewerUser && !viewerUser.started) {
            Logger.info(LOG_PREFIX, `Viewer WebRTC session began FLOWING`, this._getFullViewerLogMetadata(connectionId));
            this.sendPlayStart(C.RECV_ROLE, connectionId);
            viewerUser.started = true;
        }
    }
    _onViewerWebRTCMediaNotFlowing(connectionId) {
        Logger.debug(LOG_PREFIX, `Viewer WebRTC session is NOT_FLOWING`, this._getFullViewerLogMetadata(connectionId));
        // TODO properly implement a handler when we have a client-side reconnection procedure
    }
    _handleIceComponentStateChange(state, logMetadata) {
        const { rawEvent } = state;
        const { componentId: iceComponentId, source: elementId, state: iceComponentState } = rawEvent;
        Logger.debug(LOG_PREFIX, "Screenshare ICE component state changed", Object.assign(Object.assign({}, logMetadata), { elementId,
            iceComponentId,
            iceComponentState }));
    }
    _handleCandidatePairSelected(state, logMetadata) {
        const { rawEvent } = state;
        const { candidatePair, source: elementId } = rawEvent;
        const { localCandidate, remoteCandidate, componentID: iceComponentId } = candidatePair;
        Logger.info(LOG_PREFIX, "Screenshare new candidate pair selected", Object.assign(Object.assign({}, logMetadata), { elementId,
            iceComponentId,
            localCandidate,
            remoteCandidate }));
    }
    _handleIceGatheringDone(state, logMetadata) {
        const { rawEvent } = state;
        const { source: elementId } = rawEvent;
        Logger.debug(LOG_PREFIX, "Screenshare ICE gathering done", Object.assign(Object.assign({}, logMetadata), { elementId }));
    }
    _handleMediaStateChanged(state, logMetadata) {
        const { rawEvent, details } = state;
        const { source: elementId } = rawEvent;
        Logger.debug(LOG_PREFIX, `Screenshare media state changed`, Object.assign(Object.assign({}, logMetadata), { elementId, mediaState: details }));
    }
    _mediaStateWebRTC(event, endpoint, connectionId, flowingCallback, notFlowingCallback) {
        const { mediaId, state } = event;
        if (mediaId !== endpoint) {
            return;
        }
        const { name, details } = state;
        const isPresenter = connectionId === this._connectionId;
        const logMetadata = isPresenter
            ? this._getFullPresenterLogMetadata(connectionId)
            : this._getFullViewerLogMetadata(connectionId);
        switch (name) {
            case "IceComponentStateChange":
                this._handleIceComponentStateChange(state, logMetadata);
                break;
            case "NewCandidatePairSelected":
                this._handleCandidatePairSelected(state, logMetadata);
                break;
            case "IceGatheringDone":
                this._handleIceGatheringDone(state, logMetadata);
                break;
            case "MediaStateChanged":
                this._handleMediaStateChanged(state, logMetadata);
                break;
            case "MediaFlowOutStateChange":
            case "MediaFlowInStateChange":
                if (details === 'FLOWING') {
                    flowingCallback(connectionId);
                }
                else {
                    notFlowingCallback(connectionId);
                }
                break;
            case C.MEDIA_SERVER_OFFLINE:
                if (isPresenter) {
                    Logger.error(LOG_PREFIX, "Presenter WebRTC screensharing session received MEDIA_SERVER_OFFLINE event", Object.assign(Object.assign({}, logMetadata), { event }));
                }
                else {
                    Logger.error(LOG_PREFIX, "Viewer WebRTC screensharing session received MEDIA_SERVER_OFFLINE event", Object.assign(Object.assign({}, logMetadata), { event }));
                }
                this.emit(C.MEDIA_SERVER_OFFLINE, event);
                break;
            default: Logger.trace(LOG_PREFIX, "Unrecognized event", event);
        }
    }
    _mediaStateRecording(event, endpoint) {
        const { mediaId, state } = event;
        if (mediaId !== endpoint) {
            return;
        }
        const { name, details } = state;
        switch (name) {
            case "MediaStateChanged":
                break;
            case "MediaFlowOutStateChange":
            case "MediaFlowInStateChange":
                if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
                    Logger.debug(LOG_PREFIX, `Recording media STOPPED FLOWING on endpoint ${endpoint}`, this._getFullPresenterLogMetadata(this._connectionId));
                }
                else if (details === 'FLOWING') {
                    Logger.debug(LOG_PREFIX, `Recording media STARTED FLOWING on endpoint ${endpoint}`, this._getFullPresenterLogMetadata(this._connectionId));
                    if (!this._startRecordingEventFired) {
                        const { timestampHR, timestampUTC } = state;
                        this.sendStartShareEvent(timestampHR, timestampUTC);
                    }
                }
                break;
            default: Logger.trace(LOG_PREFIX, "Unhandled recording event", event);
        }
    }
    /* ======= RECORDING METHODS ======= */
    startRecording() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                try {
                    const contentCodec = DEFAULT_MEDIA_SPECS.codec_video_content;
                    const recordingProfile = (contentCodec === 'VP8' || contentCodec === 'ANY')
                        ? this.hasAudio
                            ? C.RECORDING_PROFILE_WEBM_FULL
                            : C.RECORDING_PROFILE_WEBM_VIDEO_ONLY
                        : this.hasAudio
                            ? C.RECORDING_PROFILE_MKV_FULL
                            : C.RECORDING_PROFILE_MKV_VIDEO_ONLY;
                    const format = (contentCodec === 'VP8' || contentCodec === 'ANY')
                        ? C.RECORDING_FORMAT_WEBM
                        : C.RECORDING_FORMAT_MKV;
                    const recordingPath = this.getRecordingPath(this.meetingId, this._recordingSubPath, this._voiceBridge, format);
                    const recordingId = yield this.mcs.startRecording(this.presenterMCSUserId, this._presenterEndpoint, recordingPath, { recordingProfile, ignoreThresholds: true, mediaProfile: 'content' });
                    this.recording = { recordingId, filename: recordingPath };
                    this.mcs.onEvent(C.MEDIA_STATE, this.recording.recordingId, (event) => {
                        this._mediaStateRecording(event, this.recording.recordingId);
                    });
                    resolve(this.recording);
                }
                catch (err) {
                    reject(this._handleError(LOG_PREFIX, err));
                }
            }));
        });
    }
    sendStartShareEvent(timestampHR, timestampUTC) {
        const shareEvent = Messaging.generateWebRTCShareEvent('StartWebRTCDesktopShareEvent', this.meetingId, this.recording.filename, timestampHR, timestampUTC);
        this.bbbGW.writeMeetingKey(this.meetingId, shareEvent, function (error) { });
        this._startRecordingEventFired = true;
    }
    /* ======= START PROCEDURES ======= */
    getBroadcastPermission(meetingId, voiceBridge, userId, sfuSessionId, role) {
        if (!PERMISSION_PROBES)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onResp = (payload) => {
                const { meetingId, voiceBridge, userId, allowed } = payload;
                if (meetingId === payload.meetingId
                    && payload.voiceBridge === voiceBridge
                    && payload.userId === userId
                    && payload.allowed) {
                    return resolve();
                }
                return reject(errors.SFU_UNAUTHORIZED);
            };
            const msg = Messaging.generateGetScreenBroadcastPermissionReqMsg(meetingId, voiceBridge, userId, sfuSessionId);
            this.bbbGW.once(C.GET_SCREEN_BROADCAST_PERM_RESP_MSG + sfuSessionId, onResp);
            this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
        });
    }
    getSubscribePermission(meetingId, voiceBridge, userId, streamId, sfuSessionId, role) {
        if (!PERMISSION_PROBES)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onResp = (payload) => {
                const { meetingId, voiceBridge, userId, allowed } = payload;
                if (meetingId === payload.meetingId
                    && payload.voiceBridge === voiceBridge
                    && payload.userId === userId
                    && payload.allowed) {
                    return resolve();
                }
                return reject(errors.SFU_UNAUTHORIZED);
            };
            const msg = Messaging.generateGetScreenSubscribePermissionReqMsg(meetingId, voiceBridge, userId, streamId, sfuSessionId);
            this.bbbGW.once(C.GET_SCREEN_SUBSCRIBE_PERM_RESP_MSG + sfuSessionId, onResp);
            this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
        });
    }
    start(connectionId, bbbUserId, role, descriptor, options = {}) {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            const isConnected = yield this.mcs.waitForConnection();
            if (!isConnected) {
                return reject(errors.MEDIA_SERVER_OFFLINE);
            }
            // Probe akka-apps to see if this is to be recorded
            if (SHOULD_RECORD && role === C.SEND_ROLE) {
                this.isRecorded = yield this.probeForRecordingStatus(this.meetingId, bbbUserId);
            }
            if (role === C.RECV_ROLE) {
                try {
                    Logger.info(LOG_PREFIX, `Starting viewer screensharing session`, this._getFullViewerLogMetadata(connectionId));
                    const sdpAnswer = yield this._startViewer(connectionId, this._voiceBridge, descriptor, bbbUserId, this._presenterEndpoint, options);
                    return resolve(sdpAnswer);
                }
                catch (err) {
                    return reject(this._handleError(LOG_PREFIX, err, role, bbbUserId));
                }
            }
            if (role === C.SEND_ROLE) {
                try {
                    Logger.info(LOG_PREFIX, `Starting presenter screensharing session`, this._getFullPresenterLogMetadata(connectionId));
                    const sdpAnswer = yield this._startPresenter(descriptor, bbbUserId, connectionId, options);
                    return resolve(sdpAnswer);
                }
                catch (err) {
                    return reject(this._handleError(LOG_PREFIX, err, role, bbbUserId));
                }
            }
        }));
    }
    _startPresenter(descriptor, userId, connectionId, options = {}) {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            try {
                this.status = C.MEDIA_STARTING;
                yield this.getBroadcastPermission(this.meetingId, this._voiceBridge, userId, connectionId);
                const presenterMCSUserId = yield this.mcs.join(this._voiceBridge, 'SFU', { externalUserId: userId, autoLeave: true });
                this.presenterMCSUserId = presenterMCSUserId;
                const presenterSdpAnswer = yield this._publishPresenterWebRTCStream(descriptor, options);
                yield this.mcs.setContentFloor(this._voiceBridge, this._presenterEndpoint);
                resolve(presenterSdpAnswer);
            }
            catch (error) {
                Logger.error(LOG_PREFIX, `Error on starting screensharing presenter`, Object.assign(Object.assign({}, this._getFullPresenterLogMetadata(this._connectionId)), { error }));
                return reject(this._handleError(LOG_PREFIX, error));
            }
        }));
    }
    _publishPresenterWebRTCStream(descriptor, options = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let mediaSpecs;
                if (options.bitrate) {
                    mediaSpecs = Screenshare.getCustomMediaSpec(options.bitrate);
                }
                // Get the REMB spec to be used. Screenshare uses the default mixed in with
                // the default spec bitrate. Fetching bitrate by the VP8 codec is just an
                // arbitrary choice that makes no difference.
                // The media specs format isn't flexible enough, so that's what we have
                const kurentoRembParams = Object.assign({}, KURENTO_REMB_PARAMS);
                kurentoRembParams.rembOnConnect = DEFAULT_MEDIA_SPECS.VP8.as_content;
                const mcsOptions = {
                    descriptor,
                    name: this._assembleStreamName('publish', this.userId, this._voiceBridge),
                    mediaProfile: 'content',
                    kurentoRembParams,
                    adapter: options.mediaServer,
                    mediaSpecs,
                };
                const { mediaId, answer } = yield this.mcs.publish(this.presenterMCSUserId, this._voiceBridge, C.WEBRTC, mcsOptions);
                this._presenterEndpoint = mediaId;
                this.mcs.onEvent(C.MEDIA_STATE, this._presenterEndpoint, (event) => {
                    this._mediaStateWebRTC(event, this._presenterEndpoint, this._connectionId, this._onPresenterMediaFlowing.bind(this), this._onPresenterMediaNotFlowing.bind(this));
                });
                this.mcs.onEvent(C.MEDIA_STATE_ICE, this._presenterEndpoint, (event) => {
                    this._onMCSIceCandidate(event, this._connectionId, this._presenterEndpoint);
                });
                const presenterSdpAnswer = answer;
                this.flushCandidatesQueue(this.mcs, [...this._presenterCandidatesQueue], this._presenterEndpoint);
                this._presenterCandidatesQueue = [];
                Logger.info(LOG_PREFIX, `Presenter WebRTC stream was successfully published`, this._getFullPresenterLogMetadata(this._connectionId));
                this.status = C.MEDIA_NEGOTIATED;
                return presenterSdpAnswer;
            }
            catch (err) {
                // Handled in caller @_startPresenter
                this.status = C.MEDIA_NEGOTIATION_FAILED;
                throw err;
            }
        });
    }
    _fetchContentFloor() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { floor } = yield this.mcs.getContentFloor(this._voiceBridge);
                Logger.debug(LOG_PREFIX, `Content floor fetched`, Object.assign({ floor }, this._getPartialLogMetadata()));
                return floor;
            }
            catch (e) {
                throw e;
            }
        });
    }
    _startViewer(connectionId, voiceBridge, descriptor, userId, presenterEndpoint, options = {}) {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            let sdpAnswer;
            this._viewersCandidatesQueue[connectionId] = [];
            try {
                yield this.getSubscribePermission(this.meetingId, voiceBridge, userId, presenterEndpoint, connectionId);
                const mcsUserId = yield this.mcs.join(this._voiceBridge, 'SFU', { externalUserId: userId, autoLeave: true });
                this._viewerUsers[connectionId] = {
                    userId,
                    connectionId,
                    started: false,
                };
                // Get the REMB spec to be used. Screenshare uses the default mixed in with
                // the default spec bitrate. Fetching bitrate by the VP8 codec is just an
                // arbitrary choice that makes no difference.
                // The media specs format isn't flexible enough, so that's what we have
                const kurentoRembParams = Object.assign({}, KURENTO_REMB_PARAMS);
                kurentoRembParams.rembOnConnect = DEFAULT_MEDIA_SPECS.VP8.as_content;
                const mcsOptions = {
                    descriptor,
                    name: this._assembleStreamName('subscribe', userId, this._voiceBridge),
                    mediaProfile: 'content',
                    mediaSpecSlave: SUBSCRIBER_SPEC_SLAVE,
                    kurentoRembParams,
                    adapter: options.mediaServer,
                };
                if (this._presenterEndpoint == null) {
                    const floor = yield this._fetchContentFloor();
                    this._presenterEndpoint = floor ? floor.mediaId : null;
                }
                const { mediaId, answer } = yield this.mcs.subscribe(mcsUserId, this._presenterEndpoint, C.WEBRTC, mcsOptions);
                this._viewerEndpoints[connectionId] = mediaId;
                sdpAnswer = answer;
                this.flushCandidatesQueue(this.mcs, [...this._viewersCandidatesQueue[connectionId]], this._viewerEndpoints[connectionId]);
                this._viewersCandidatesQueue[connectionId] = [];
                this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
                    this._mediaStateWebRTC(event, mediaId, connectionId, this._onViewerWebRTCMediaFlowing.bind(this), this._onViewerWebRTCMediaNotFlowing.bind(this));
                });
                this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
                    this._onMCSIceCandidate(event, connectionId, mediaId);
                });
                Logger.info(LOG_PREFIX, `Viewer WebRTC stream was successfully created`, this._getFullViewerLogMetadata(connectionId));
                return resolve(sdpAnswer);
            }
            catch (error) {
                Logger.error(LOG_PREFIX, `Viewer subscribe failed for ${userId} due to ${error.message}`, Object.assign(Object.assign({}, this._getFullViewerLogMetadata(connectionId)), { error: this._handleError(LOG_PREFIX, error) }));
                return reject(this._handleError(LOG_PREFIX, error));
            }
        }));
    }
    _startRtmpBroadcast(meetingId, output) {
        if (SCREENSHARE_SERVER_AKKA_BROADCAST) {
            this._streamUrl = this._presenterEndpoint;
            const timestamp = Math.floor(new Date());
            const dsrbstam = Messaging.generateScreenshareRTMPBroadcastStartedEvent2x(this._voiceBridge, this._voiceBridge, this._streamUrl, this._vw, this._vh, timestamp, this.hasAudio);
            this.bbbGW.publish(dsrbstam, C.TO_AKKA_APPS);
            this._rtmpBroadcastStarted = true;
            Logger.debug(LOG_PREFIX, "Sent startRtmpBroadcast", this._getPartialLogMetadata());
        }
    }
    /* ======= STOP PROCEDURES ======= */
    clearSessionListeners() {
        this.eventNames().forEach(event => {
            this.removeAllListeners(event);
        });
    }
    _sendStopShareEvent() {
        const timestampUTC = Date.now();
        const timestampHR = Utils.hrTime();
        const shareEvent = Messaging.generateWebRTCShareEvent('StopWebRTCDesktopShareEvent', this.meetingId, this.recording.filename, timestampHR, timestampUTC);
        this.bbbGW.writeMeetingKey(this.meetingId, shareEvent, function (error) { });
        this._stopRecordingEventFired = true;
    }
    _stopRecording() {
        return __awaiter(this, void 0, void 0, function* () {
            // Check if properly started the recording before trying to stop it
            if (this.isRecorded && this.recording && this.recording.recordingId) {
                if (!this._stopRecordingEventFired) {
                    this._sendStopShareEvent();
                }
                try {
                    yield this.mcs.stopRecording(this.presenterMCSUserId, this.recording.recordingId);
                }
                catch (error) {
                    // Logging it in case it still happens, but recording should be stopped
                    // if it errors out inside mcs-core or if we call mcs.leave for this user
                    // so it'll always be stopped. If anything pops here, probably related
                    // to it already being stopped or it wasn't started in the first place
                    Logger.warn(LOG_PREFIX, `Stop recording MAY have failed for presenter ${this.presenterMCSUserId}`, Object.assign(Object.assign({}, this._getFullPresenterLogMetadata(this._connectionId)), { error, recordingId: this.recording.recordingId }));
                }
            }
        });
    }
    _releaseContentFloorIfNeeded() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const currentFloor = yield this._fetchContentFloor(this._voiceBridge);
                if (currentFloor && (currentFloor.mediaId === this._presenterEndpoint
                    || currentFloor.mediaSessionId === this._presenterEndpoint)) {
                    yield this.mcs.releaseContentFloor(this._voiceBridge);
                }
                else {
                    return Promise.resolve();
                }
            }
            catch (error) {
                Logger.error(LOG_PREFIX, `Content floor release failed for room ${this._voiceBridge}`, Object.assign(Object.assign({}, this._getPartialLogMetadata()), { error }));
            }
        });
    }
    stopViewer(id) {
        const viewerUser = this._viewerUsers[id];
        if (viewerUser == null) {
            // User doesn't exist. Probably a stop request glare
            delete this._viewersCandidatesQueue[id];
            delete this._viewerEndpoints[id];
            return Promise.resolve();
        }
        const { userId } = viewerUser;
        const viewerMediaId = this._viewerEndpoints[id];
        Logger.info(LOG_PREFIX, `Stopping screenshare viewer ${userId}`, this._getFullViewerLogMetadata(id));
        if (viewerMediaId) {
            return this.mcs.unsubscribe(userId, viewerMediaId)
                .then(() => {
                Logger.debug(LOG_PREFIX, `Screenshare viewer ${userId} stopped`, this._getFullViewerLogMetadata(id));
                delete this._viewersCandidatesQueue[id];
                delete this._viewerEndpoints[id];
                delete this._viewerUsers[id];
            })
                .catch(error => {
                Logger.error(LOG_PREFIX, `Viewer unsubscribe failed for ${userId} due to ${error.message}`, Object.assign(Object.assign({}, this._getFullViewerLogMetadata(id)), { error }));
                delete this._viewersCandidatesQueue[id];
                delete this._viewerEndpoints[id];
                delete this._viewerUsers[id];
            });
        }
        else {
            Logger.warn(LOG_PREFIX, `Screenshare viewer ${userId} media ID not found, probably already released`, this._getFullViewerLogMetadata(id));
            return Promise.resolve();
        }
    }
    _stopAllViewers() {
        Object.keys(this._viewerUsers).forEach((connectionId) => __awaiter(this, void 0, void 0, function* () {
            yield this.stopViewer(connectionId);
        }));
    }
    // FIXME tether resolve to the Resp even from akka-apps
    _stopRtmpBroadcast(meetingId) {
        return new Promise((resolve, reject) => {
            if (!SCREENSHARE_SERVER_AKKA_BROADCAST)
                return resolve();
            const timestamp = Math.floor(new Date());
            const dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(this._voiceBridge, this._voiceBridge, this._streamUrl, this._vw, this._vh, timestamp);
            this.bbbGW.publish(dsrstom, C.TO_AKKA_APPS);
            Logger.debug(LOG_PREFIX, "Sent stopRtmpBroadcast", this._getPartialLogMetadata());
            resolve();
        });
    }
    // TODO review this one
    _notifyScreenshareEndToBBB() {
        this._stopRtmpBroadcast(this.meetingId).catch(error => {
            // This is an unrecoverable error that should NEVER happen
            Logger.error(LOG_PREFIX, `CRITICAL: failed to send stopRtmpBroadcast`, Object.assign(Object.assign({}, this._getFullPresenterLogMetadata(this._connectionId)), { error }));
        });
    }
    stopPresenter() {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            // Set this right away to avoid trailing stops
            this.status = C.MEDIA_STOPPING;
            // Stop the recording procedures if needed.
            this._stopRecording();
            // Send stopRtmpBroadcast message to akka-apps
            this._notifyScreenshareEndToBBB();
            // Check if the presenter user ID is set. If it is, it means this has
            // been started through this process, so clean things up. If it isn't
            // it means this is a viewer-only session and content has been started
            // externally; so don't try to clean presenter stuff here because that's
            // the job of who started it.
            if (this.presenterMCSUserId) {
                if (this._presenterEndpoint) {
                    yield this._releaseContentFloorIfNeeded();
                    try {
                        yield this.mcs.unpublish(this.presenterMCSUserId, this._presenterEndpoint);
                    }
                    catch (error) {
                        Logger.error(LOG_PREFIX, `Unpublish failed for presenter ${this.presenterMCSUserId} due to ${error.message}`, Object.assign(Object.assign({}, this._getFullPresenterLogMetadata(this._connectionId)), { error }));
                    }
                }
                else {
                    Logger.warn(LOG_PREFIX, `Screenshare presenter mediaId not set on stop`, this._getFullPresenterLogMetadata());
                }
            }
            else {
                Logger.warn(LOG_PREFIX, `Screenshare presenter MCS userId not set on stop`, this._getFullPresenterLogMetadata());
            }
            this._stopAllViewers();
            this._presenterEndpoint = null;
            this._candidatesQueue = null;
            this.status = C.MEDIA_STOPPED;
            this.clearSessionListeners();
            this.clearMediaFlowingTimeout(this._connectionId);
            resolve();
        }));
    }
    stop() {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
            switch (this.status) {
                case C.MEDIA_STOPPED:
                    Logger.warn(LOG_PREFIX, `Screenshare session already stopped`, this._getFullPresenterLogMetadata());
                    return resolve();
                    break;
                case C.MEDIA_STOPPING:
                    Logger.warn(LOG_PREFIX, `Screenshare session already stopping`, this._getFullPresenterLogMetadata());
                    this.once(C.MEDIA_STOPPED, () => {
                        Logger.info(LOG_PREFIX, `Screenshare delayed stop resolution for queued stop call`, this._getFullPresenterLogMetadata());
                        return resolve();
                    });
                    break;
                case C.MEDIA_STARTING:
                    Logger.warn(LOG_PREFIX, `Screenshare session still starting on stop, wait.`, this._getFullPresenterLogMetadata());
                    if (!this._stopActionQueued) {
                        this._stopActionQueued = true;
                        this.once(C.MEDIA_NEGOTIATED, () => {
                            Logger.info(LOG_PREFIX, `Screenshare delayed MEDIA_STARTING stop resolution`, this._getFullPresenterLogMetadata());
                            this.stopPresenter().then(resolve).catch(error => {
                                Logger.info(LOG_PREFIX, `Screenshare delayed MEDIA_STARTING stop failed`, Object.assign({ errorMessage: error.message, errorCode: error.code }, this._getFullPresenterLogMetadata));
                                return resolve();
                            });
                        });
                    }
                    else {
                        this.once(C.MEDIA_STOPPED, () => {
                            Logger.info(LOG_PREFIX, `Screenshare delayed stop resolution for queued stop call`, this._getFullPresenterLogMetadata());
                            return resolve();
                        });
                    }
                    break;
                default:
                    this.stopPresenter().then(resolve).catch(error => {
                        Logger.info(LOG_PREFIX, `Screenshare stop failed`, Object.assign({ errorMessage: error.message, errorCode: error.code }, this._getFullPresenterLogMetadata));
                        return resolve();
                    });
            }
        }));
    }
};
