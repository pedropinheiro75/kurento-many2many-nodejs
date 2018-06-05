/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = null;
var presenters = {};
var viewers = {};
var noPresenterMessage = 'No active presenter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2many'
});

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {

	var sessionId = nextUniqueId();
	console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error', error);
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'presenter':
			startPresenter(sessionId, message.presenterName, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					console.log('error: ', error);
					return ws.send(JSON.stringify({
						id : 'presenterResponse',
						response : 'rejected',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'presenterResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;
        case 'getPresenters':
             var allPresenters = [];
             for (var presenter in presenters) {
                 allPresenters.push({
                     sessionID: presenters[presenter].id,
                     name: presenters[presenter].presenterName
                 })
             }
             ws.send(JSON.stringify({
                 id: 'getPresentersResponse',
                 presenters: allPresenters
             }));
             break;
        case 'viewer':
			startViewer(sessionId, ws, message.sdpOffer, message.presenterID, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'viewerResponse',
						response : 'rejected',
						message : error
					}));
				}

				ws.send(JSON.stringify({
					id : 'viewerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate, message.presenterID);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }
    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function startPresenter(sessionID, presenterName, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionID);

	// if (sessionID in presenters) {
	// 	stop(sessionID);
	// 	return callback("Another user is currently acting as presenter. Try again later ...");
	// }

    presenters[sessionID] = {
		id : sessionID,
		pipeline : null,
		webRtcEndpoint : null,
		presenterName: presenterName
	};

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			console.log('error: ', error);
			stop(sessionID);
			return callback(error);
		}

		if (!(sessionID in presenters)) {
			console.log('dfs');
			stop(sessionID);
			return callback(noPresenterMessage);
		}

		kurentoClient.create('MediaPipeline', function(error, pipeline) {
			if (error) {
                console.log('error: ', error);
				stop(sessionID);
				return callback(error);
			}

			if (!(sessionID in presenters)) {
				console.log('sdas');
				stop(sessionID);
				return callback(noPresenterMessage);
			}

            presenters[sessionID].pipeline = pipeline;
			pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
				if (error) {
                    console.log('error: ', error);
					stop(sessionID);
					return callback(error);
				}

				if (!(sessionID in presenters)) {
					stop(sessionID);
					return callback(noPresenterMessage);
				}

                presenters[sessionID].webRtcEndpoint = webRtcEndpoint;

                if (candidatesQueue[sessionID]) {
                    while(candidatesQueue[sessionID].length) {
                        var candidate = candidatesQueue[sessionID].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                    ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });

				webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
					if (error) {
						stop(sessionID);
						return callback(error);
					}

                    if (!(sessionID in presenters)) {
						stop(sessionID);
						return callback(noPresenterMessage);
					}

					callback(null, sdpAnswer);
				});

                webRtcEndpoint.gatherCandidates(function(error) {
                    if (error) {
                        stop(sessionID);
                        return callback(error);
                    }
                });
            });
        });
	});
}

function startViewer(sessionId, ws, sdpOffer, presenterID, callback) {
	clearCandidatesQueue(sessionId);

	if (!(presenterID in presenters)) {
		stop(sessionId);
		return callback(noPresenterMessage);
	}

	presenters[presenterID].pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

        if (!(presenterID in viewers)) {
            viewers[presenterID] = {};
        }

		viewers[presenterID][sessionId] = {
            "webRtcEndpoint" : webRtcEndpoint,
            "ws" : ws
        };
		console.log(viewers);

		if (!(presenterID in presenters)) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		if (candidatesQueue[sessionId]) {
			while(candidatesQueue[sessionId].length) {
				var candidate = candidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });

		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (!(presenterID in presenters)) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

            presenters[presenterID].webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (!(presenterID in presenters)) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				callback(null, sdpAnswer);
		        webRtcEndpoint.gatherCandidates(function(error) {
		            if (error) {
			            stop(sessionId);
			            return callback(error);
		            }
		        });
		    });
	    });
	});
}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

function stop(sessionId) {
	if (sessionId in presenters && presenters[sessionId].id == sessionId) {
		for (var i in viewers[sessionId]) {
			var viewer = viewers[sessionId][i];
			if (viewer.ws) {
				viewer.ws.send(JSON.stringify({
					id : 'stopCommunication'
				}));
			}
		}
        presenters[sessionId].pipeline.release();
        delete presenters[sessionId];
		delete viewers[sessionId];
	} else {
		for (var presenterId in viewers) {
			for (var viewerID in viewers[presenterId]) {
				if (viewerID == sessionId) {
                    viewers[presenterId][viewerID].webRtcEndpoint.release();
                    delete viewers[presenterId][viewerID];
				}
			}
		}
	}

	clearCandidatesQueue(sessionId);

    // if (viewers.length < 1 && !presenter) {
    //     console.log('Closing kurento client');
    //     kurentoClient.close();
    //     kurentoClient = null;
    // }
}

function onIceCandidate(sessionId, _candidate, presenterID) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (presenters[presenterID] && presenters[presenterID].id === sessionId && presenters[presenterID].webRtcEndpoint) {
        console.info('Sending presenter candidate');
        presenters[presenterID].webRtcEndpoint.addIceCandidate(candidate);
    }
    else if ((presenterID in viewers) && (sessionId in viewers[presenterID]) && viewers[presenterID][sessionId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        viewers[presenterID][sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
