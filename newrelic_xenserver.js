/*
 # Description

 XenServer Monitor Plugin for Newrelic
 Fetches metrics from Xen Hosts and VM and pushes to NewRelic over https.

 - CPU Usage
 - Memory Usage
 - Network Activity (Rx/Tx Mbps per interface)
 - Drive Activity (Throughput, IOPS, IO Wait, Latency)
 - Xen Hosts Data (XAPI Memory, dom0 load)

 The amount of metrics available will depend on your XenServer version.
 The module has been tested with Xen 6.2, 6.5 and 7.0.

 ----

 # Requirements

 Node.JS/NPM
 XenServers

 ----

 # Installation

 Install NodeJs and NPM (https://nodejs.org/en/download/package-manager/)
 Download plugin from GitHub and extract
 Inside the plugin directory, install the required npm modules (npm install async xen-api xml2js)

 Configure

 - xenConfig
 - Pool Master(s)
 - Username/Password (Same as XenCenter)
 - Specify timezone offset in tzOffset (if the timezone differs between the node.js server vs XenServers)

 - newRelicConfig
 - Newrelic license key and host name of the server this script will run it.

 We use PM2 (http://pm2.keymetrics.io) as a node process manager, which enables node.js script to run forever,
 gather logs, and to run at boot.

 npm install pm2@latest -g
 pm2 start xen_monitor.js

 pm2 stop 0
 pm2 restart 0
 pm2 reload 0

 To start at boot: pm2 startup, followed by pm2 save

 ---

 # License

 As-Is. Use at your own risk etc.

 ----

 # Support

 Use github page for support issues.

 ----

 */

var xenConfig = [];
xenConfig.push({ poolMaster: 'pool master host name', tzOffset: 0, user: 'root', password: 'password'});
xenConfig.push({ poolMaster: 'pool master 2 host name', tzOffset: 0, user: 'root', password: 'password'});

// NewRelic Plugin Configuration
var newRelicConfig = { host: 'this servers host name', licenseKey: 'license key'};

//-----------------------------
// Nothing to configure below
//-----------------------------

"use strict"
var xenapi = require('xen-api');
var async = require('async');
var request = require('request');
var xml2js = require('xml2js');
var util = require('util');

// Interal Data
var xapi = {}; // Each xapi connection
var xenData = {}; // Data on hosts

xenData['host'] = {};
xenData['host_OpaqueRef'] = {};
xenData['vm'] = {};
xenData['vm_OpaqueRef'] = {};
xenData['network'] = {};
xenData['network_OpaqueRef'] = {};
xenData['vif'] = {};
xenData['vif_OpaqueRef'] = {};
xenData['vifByVM'] = {};
xenData['pif'] = {};
xenData['pifByHost'] = {};
xenData['pif_OpaqueRef'] = {};
xenData['sr'] = {};
xenData['srShort'] = {};
xenData['sr_OpaqueRef'] = {};

var parsedMetrics = {}; // Storage for parsedMetrics


// Connect to Pool Masters
function connectXen() {
    console.log("connectXen()");
    async.each(xenConfig, function(config, callback) {

        xapi[config.poolMaster] = new xenapi.createClient({
            url: config.poolMaster,
            auth: {user: config.user, password: config.password},
            readOnly: false
        });

        xapi[config.poolMaster].connect().then(function () {
            callback();
        }).catch(function (error) {
            console.error(error);
            callback(error);
        });
    }, function (err) {
        if (err) {
            // One of the iterations produced an error.
            console.log('A connection failed to process');
        } else {

            // On startup, fetch and post
            getXenHosts(function () {
                getXenMetrics(function () {
                    newrelicPost();

                });
            });

            // Setup intervals.
            // Every 10 minutes update Hosts
            setInterval(function () {
                getXenHosts(function () {});
            }, 600000);

            // Every minute getXenMetrics, followed by newrelicPost 30s later
            // We execute newrelicPost seperate from getXenMetrics
            setInterval(function () {
                getXenMetrics(function () {});

                setTimeout(function () {
                    newrelicPost();
                }, 30000); //30

            }, 60000); //60
        }
    });
}

function getXenHosts(callback) {
    console.log("getXenHosts()");

    async.each(xenConfig, function (config, callback) { // For each pool
        async.series([
                // Hosts info
                function(callback) {
                    xapi[config.poolMaster].call('host.get_all_records').then(function(records) {
                        //console.log(records);
                        Object.keys(records).forEach(function(key) {
                            var host = records[key];
                            xenData['host'][host.uuid] = { poolMaster: config.poolMaster, label: host.name_label, address: host.address, tzOffset: config.tzOffset};
                            xenData['host_OpaqueRef'][key] = host.uuid;
                        });
                        callback();
                    }).catch(function (error) {
                        console.log("host" + error);
                        callback(error);
                    });
                },
                // VM
                function(callback) {
                    xapi[config.poolMaster].call('VM.get_all_records').then(function (records) {
                        //console.log(records);
                        Object.keys(records).forEach(function (key) {
                            var vm = records[key];
                            var uuidHost = xenData['host_OpaqueRef'][vm.resident_on];

                            if (vm.is_a_template==false && vm.is_control_domain==false) {
                                xenData['vm'][vm.uuid] = { label: vm.name_label, vif: vm.VIFs, resident_on: uuidHost };
                                xenData['vm_OpaqueRef'][key] = vm.uuid;
                            }
                        });

                        callback();
                    }).catch(function (error) {
                        console.log("vm" + error);
                        callback(error);
                    });
                },
                // Network labels
                function(callback) {
                    xapi[config.poolMaster].call('network.get_all_records').then(function (records) {
                        //console.log(records);
                        Object.keys(records).forEach(function (key) {
                            var network = records[key];
                            xenData['network'][network.uuid] = { label: network.name_label };
                            xenData['network_OpaqueRef'][key] = network.uuid;
                        });
                        //console.log(xenData);
                        callback();
                    }).catch(function (error) {
                        console.log("network" + error);
                        callback(error);
                    });
                },
                // VIF
                function(callback) {
                    xapi[config.poolMaster].call('VIF.get_all_records').then(function (records) {
                        //console.log(records);
                        Object.keys(records).forEach(function (key) {
                            var vif = records[key];
                            var uuidVm = xenData['vm_OpaqueRef'][vif.VM];
                            var uuidNetwork = xenData['network_OpaqueRef'][vif.network];
                            var label;
                            try {
                                label = xenData['network'][xenData['network_OpaqueRef'][vif.network]].label;
                            } catch (err) {
                                label = "Unnamed";
                            }

                            var data = { network: uuidNetwork, label: label, device: vif.device, VM: uuidVm, MAC: vif.MAC };
                            xenData['vif'][vif.uuid] = data;
                            xenData['vif_OpaqueRef'][key] = vif.uuid;

                            // PIF by Host/Device (for lookup)
                            if (!xenData['vifByVM'][uuidVm]) { xenData['vifByVM'][uuidVm] = {}; } //only intilize when new
                            xenData['vifByVM'][uuidVm][vif.device] = data;

                        });
                        //console.log(xenData);
                        callback();
                    }).catch(function (error) {
                        console.log("vif" + error);
                        callback(error);
                    });
                },
                // PIF
                function(callback) {
                    xapi[config.poolMaster].call('PIF.get_all_records').then(function (records) {
                        //console.log(records);

                        Object.keys(records).forEach(function (key) {
                            var pif = records[key];
                            var uuidHost = xenData['host_OpaqueRef'][pif.host];
                            var uuidNetwork = xenData['network_OpaqueRef'][pif.network];
                            var label;
                            try {
                                label = xenData['network'][xenData['network_OpaqueRef'][pif.network]].label;
                            } catch (err) {
                                label = "Unnamed";
                            }

                            var data = { network: uuidNetwork, label: label,  device: pif.device, MAC: pif.MAC, host: uuidHost }; // both network and host both OpaqueRef
                            xenData['pif'][pif.uuid] = data;
                            xenData['pif_OpaqueRef'][key] = pif.uuid;

                            // PIF by Host/Device (for lookup)
                            if (!xenData['pifByHost'][uuidHost]) { xenData['pifByHost'][uuidHost] = {}; } //only intilize when new
                            xenData['pifByHost'][uuidHost][pif.device] = data;

                        });
                        //console.log(xenData);
                        callback();
                    }).catch(function (error) {
                        console.log("pif" + error);
                        callback(error);
                    });
                },
                // SR labels
                function(callback) {
                    xapi[config.poolMaster].call('SR.get_all_records').then(function (records) {
                        //console.log(records);

                        Object.keys(records).forEach(function (key) {
                            var sr = records[key];

                            var data = { label: sr.name_label };
                            xenData['sr'][sr.uuid] = data;
                            xenData['sr_OpaqueRef'][key] = sr.uuid;

                            // SR by Host/Device (for lookup)
                            var srShortArray = sr.uuid.split("-");
                            xenData['srShort'][srShortArray[0]] = data;

                        });
                        callback();
                    }).catch(function (error) {
                        console.log("sr" + error);
                        callback(error);
                    });
                }
            ],
            // Complete Series
            function(err) {
                if (err) {
                    callback(err);
                } else {
                    callback();
                }
            });
        // Complete Async
    }, function (err) {
        if (err) {
            console.log("complete " + err);
        } else {
            // fetch new metrics asap
            //console.log("complete" + config);
            callback();
        }
    });
}

function getXenMetrics(callback) {
    console.log("getXenMetrics()");
    async.each(Object.keys(xenData['host']), function (uuid, callback) {
        var host = xenData['host'][uuid];
        var sessionId = xapi[host.poolMaster]._sessionId;
        var start = Math.floor((new Date().getTime() + host.tzOffset*60*1000)/1000) - (3*60); // 3 minutes ago to force minute data in response

        var url = "http://" + host.address + "/rrd_updates?session_id=" + sessionId + "&start=" + start + "&host=true&cf=AVERAGE&interval=60";
        //console.log(host.label + " " + url);

        request(url, function (err, response, body) {
            if (!err && response.statusCode == 200) {

                var parser = new xml2js.Parser();
                parser.parseString(body, function (err, result) {
                    if (err) {
                        callback(err);
                    } else {
                        // Fetch Latest entry only
                        var columns = result.xport.meta[0].legend[0].entry;
                        var rows = result.xport.data[0].row[0].v;
                        var rawMetrics = toObject(columns, rows);

                        parseXenMetrics(uuid, rawMetrics); // pass in host uuid and rawmetrics

                        callback(); // complete!
                    }
                });
            } else {
                console.log("getXenMetrics" + err);
                callback(err);
            }
        });

    }, function (err) {
        if (err) {
            console.log(err); // One of the iterations produced an error.
        } else {
            //console.log("getXenMetrics complete");
            callback();
        }
    });
}

function parseXenMetrics(uuidHost, metrics) {
    //console.log(util.inspect(metrics, false, null));

    var updateMetrics = [];
    var summaryData = [];

    for (var xx = 0, keys = Object.keys(metrics); xx < keys.length; xx++) {
        var key = keys[xx];
        var value = metrics[key];
        var keyArray = key.split(":");

        var mode = keyArray[0]; // (AVERAGE/MIN/MAX)
        var type = keyArray[1]; // (vm/host)
        var uuid = keyArray[2]; // uuid
        var metricArray = [];
        try {
            metricArray = keyArray[3].split("_");
        } catch (err) {
            console.log("keyArray" + err);
        }

        // Decide if to process
        var process = true;
        if (type == 'vm') {
            if (xenData['vm'][uuid] == null) {
                process = false;
            }
            if (xenData['vm'][uuid]) {
                if (xenData['vm'][uuid].resident_on != uuidHost) {
                    process = false;
                }
            }
        }
        if (type == 'host') {
            if (xenData['host'][uuid] == null) {
                process = false;
            }
        }

        if (process==true) {

            var metricString = "";
            if (!summaryData[type]) { summaryData[type] = []; }
            if (!summaryData[type][uuid]) { summaryData[type][uuid] = []; }

            value = parseFloat(value);

            //------------------
            // VIF
            //------------------
            if (metricArray[0] == "vif") { //vif_3_tx
                value = value * 8; // bytes to bits
                value = Math.round(value * 100) / 100;

                var label;
                try {
                    label = xenData['vifByVM'][uuid][metricArray[1]].label.replace("/", "-");
                } catch (err) {
                    label = "Unnamed";
                    console.log("Unnamed" + key);
                }

                metricString = "network/eth/" + label + " (vif" + metricArray[1] + ")";
                metricString += "/" + metricArray[2] + "[bits/second]";

                if (metricArray[2]=="rx") {
                    if (!summaryData[type][uuid]['network_rx']) { summaryData[type][uuid]['network_rx'] = []; }
                    summaryData[type][uuid]['network_rx'].push(value);
                } else if (metricArray[2]=="tx") {
                    if (!summaryData[type][uuid]['network_tx']) { summaryData[type][uuid]['network_tx'] = []; }
                    summaryData[type][uuid]['network_tx'].push(value);
                }

                //------------------
                // PIF
                //------------------
            } else if (metricArray[0] == "pif") { // pif_eth5_rx, pif_aggr_rx, pif_lo_rx
                value = value * 8;
                value = Math.round(value * 100) / 100;

                if (metricArray[1] == "aggr") {
                    metricString = "network/total/" + metricArray[2] + "[bits/second]";
                } else if (metricArray[1] == "lo") {
                    metricString = "network/local/" + metricArray[2] + "[bits/second]";
                } else {

                    var label;
                    try {
                        label = xenData['pifByHost'][uuid][metricArray[1]].label.replace("/", "-");
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }

                    metricString = "network/eth/" + label + " (" + metricArray[1] + ")";
                    metricString += "/" + metricArray[2] + "[bits/second]";

                }
                //------------------
                // CPU
                //------------------
            } else if (metricArray[0].substring(0, 3) == "cpu" || metricArray[0].substring(0, 3) == "CPU") {

                value = value * 100;
                value = Math.round(value * 100) / 100;

                var cpuArray = metricArray[0].split("-");
                if (metricArray[0]=="cpu" && metricArray[1]=="avg") { //[ 'cpu', 'avg' ]
                    metricString = "cpu/cpuAverage/Average CPU[%]";
                } else if (cpuArray[1]!=undefined) { // CPU7-avg-freq, cpu7-P15
                    // ignore for now
                } else if (metricArray[1]==undefined) { // CPU data
                    metricString = "cpu/byCpu/" + metricArray[0] + "[%]";
                    if (!summaryData[type][uuid]['cpu']) { summaryData[type][uuid]['cpu'] = []; }
                    summaryData[type][uuid]['cpu'].push(value);
                }

                //------------------
                // Disk Host
                //------------------
            } else if (type == "host" && (metricArray[0] == "iowait" || metricArray[0] == "iops" || metricArray[0] == "io" || metricArray[0] == "write" || metricArray[0] == "read" || metricArray[0] == "inflight" || metricArray[0] == "io_errors")) {

                if (metricArray[0] == "inflight") {
                    var label;
                    try {
                        label = xenData['srShort'][metricArray[1]].label.replace("/", "-")
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }
                    metricString = "disks/inflight/" + label + "[requests]";
                } else if (metricArray[0] == "iowait") {
                    var label;
                    try {
                        label = xenData['srShort'][metricArray[1]].label.replace("/", "-")
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }
                    metricString = "disks/iowait/" + label + "[second/second]";
                } else if (metricArray[0] == "iops") {
                    if (metricArray[1]=="total") {
                        metricString = "disks/iops_total/";
                    } else {
                        metricString = "disks/iops/";
                    }

                    var label;
                    try {
                        label = xenData['srShort'][metricArray[2]].label.replace("/", "-")
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }

                    metricString += label + "/" + metricArray[1] + "[requests/second]";
                } else if (metricArray[0] == "io") {
                    if (metricArray[2]=="total") {
                        metricString = "disks/io_throughput_total/";
                    } else {
                        metricString = "disks/io_throughput/";
                    }

                    var label;
                    try {
                        label = xenData['srShort'][metricArray[3]].label.replace("/", "-")
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }

                    metricString += label + "/" + metricArray[2] + "[bytes/second]";
                    value = value * 1048580; //mebibyte to byte
                    value = Math.round(value * 100) / 100;
                } else if ((metricArray[0] == "write" || metricArray[0] == "read") && metricArray[1] == "latency") {

                    var label;
                    try {
                        label = xenData['srShort'][metricArray[2]].label.replace("/", "-")
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }

                    metricString = "disks/latency/" + label + "/" + metricArray[0] + "[ms]";
                    value = value / 1000;
                } else if ((metricArray[0] == "write" || metricArray[0] == "read")) {

                    var label;
                    try {
                        label = xenData['srShort'][metricArray[1]].label.replace("/", "-")
                    } catch (err) {
                        label = "Unnamed";
                        console.log("Unnamed" + key);
                    }

                    metricString = "disks/write_read/" + label + "/" + metricArray[0] + "[bytes/second]";

                }

            } else if (type == "vm" && metricArray[0] == "vbd") {

                if (metricArray[2] == "inflight") {
                    metricString = "disks/inflight/" + metricArray[1] + "[requests]";
                } else if (metricArray[2] == "iowait") {
                    metricString = "disks/iowait/" + metricArray[1] + "[second/second]";
                } else if (metricArray[2] == "iops") {
                    if (metricArray[1]=="total") {
                        metricString = "disks/iops_total/";
                    } else {
                        metricString = "disks/iops/";
                    }
                    metricString += metricArray[1] + "/" +  metricArray[3] + "[requests/second]";
                } else if (metricArray[2] == "io") {
                    if (metricArray[4]=="total") {
                        metricString = "disks/io_throughput_total/";
                    } else {
                        metricString = "disks/io_throughput/";
                    }
                    metricString += metricArray[1] + "/" + metricArray[4] + "[bytes/second]";
                    value = value * 1048580; //mebibyte to byte
                    value = Math.round(value * 100) / 100;
                } else if ((metricArray[2] == "write" || metricArray[2] == "read") && metricArray[3] == "latency") {
                    metricString = "disks/latency/" + metricArray[1] + "/" + metricArray[2] + "[ms]";
                    value = value / 1000;
                } else if ((metricArray[2] == "write" || metricArray[2] == "read")) {
                    metricString = "disks/write_read/" + metricArray[1] + "/" + metricArray[2] + "[bytes/second]";
                }

                //------------------
                // Memory
                //------------------
            } else if (metricArray[0] == "memory") {

                if (type == "host" && metricArray[1] == "reclaimed") {
                    // Skip for now
                } else if (type == "host" && metricArray[1]=="total") {
                    metricString = "memory/total[bytes]";
                } else if (type == "host" && metricArray[1]=="free") {
                    metricString = "memory/free[bytes]";
                    metricString = "memory/" + metricArray[1] + "[bytes]";
                } else if (type == "vm" && metricArray[1]==undefined) {
                    metricString = "memory/total[bytes]";
                } else if (type == "vm" && metricArray[1]=="internal") {
                    metricString = "memory/free[bytes]";
                }

                if (type=="host") {
                    value = value * 1000; //kb to byte
                }

                value = Math.floor(value);

                //------------------
                // XAPI
                //------------------
            } else if (metricArray[0] == "xapi") {

                if (metricArray[1]=="open") {
                    metricString = "xapi/open_fds[fds]";
                } else if (metricArray[1]=="memory") {
                    metricString = "xapi/memory/usage[bytes]";
                    value = value * 1000; //kb to byte
                    value = Math.floor(value);
                } else if (metricArray[1]=="free") {
                    metricString = "xapi/memory/free[bytes]";
                    value = value * 1000; //kb to byte
                    value = Math.floor(value);
                } else if (metricArray[1]=="live") {
                    metricString = "xapi/memory/live[bytes]";
                    value = value * 1000; //kb to byte
                    value = Math.floor(value);
                } else if (metricArray[1]=="allocation") {
                    metricString = "xapi/memory/allocation[bytes]";
                    value = value * 1000; //kb to byte
                    value = Math.floor(value);
                }

                //------------------
                // Pool
                //------------------
            } else if (metricArray[0] == "pool") {

                if (metricArray[1]=="task") {
                    metricString = "pool/tasks[tasks]";
                } else if (metricArray[1]=="session") {
                    metricString = "pool/session[sessions]";
                }
                //------------------
                // Avg Load
                //------------------
            } else if (metricArray[0] == "loadavg") {

                metricString = "loadavg/Load Average[Load Average]";

                //------------------
                //  Tapdisk
                //------------------
            } else if (metricArray[0] == "Tapdisks") {
                // Skip
                //------------------
                //Everything else
                //------------------
            } else {
                metricString = metricArray[0];

                for (var i = 1, len = metricArray.length; i < len; i++) {
                    if (metricArray[i] != 'kib') { // don't keep kib
                        metricString += "/" + metricArray[i];
                    }
                }
            }

            if (metricString) {
                if (!parsedMetrics[type]) { parsedMetrics[type] = {}; }
                if (!parsedMetrics[type][uuid]) { parsedMetrics[type][uuid] = {}; }
                parsedMetrics[type][uuid]["Component/" + metricString] = value;

                // For post processing, store the uuid of updated metrics
                if (!updateMetrics[type]) { updateMetrics[type] = {}; }
                if (!updateMetrics[type][uuid]) { updateMetrics[type][uuid] = {}; }
                updateMetrics[type][uuid];

            }
        }
    }

    //------------------
    // Post Processing Metrics
    //------------------
    //console.log(util.inspect(summaryData, false, null));

    for (var x = 0, keys = Object.keys(updateMetrics); x < keys.length; x++) {
        var type = keys[x];
        for (var i = 0, keys2 = Object.keys(updateMetrics[type]); i < keys2.length; i++) {
            var uuid = keys2[i];

            try {

                if (parsedMetrics[type][uuid]["Component/memory/total[bytes]"]>=0 && parsedMetrics[type][uuid]["Component/memory/free[bytes]"]>=0) {
                    parsedMetrics[type][uuid]["Component/memory/used[bytes]"] = (parsedMetrics[type][uuid]["Component/memory/total[bytes]"] - parsedMetrics[type][uuid]["Component/memory/free[bytes]"]);
                    parsedMetrics[type][uuid]["Component/memory_percent/used[%]"] = (parsedMetrics[type][uuid]["Component/memory/used[bytes]"]/parsedMetrics[type][uuid]["Component/memory/total[bytes]"])*100;
                }

                if (type=='vm') {
                    if (summaryData[type][uuid].network_rx) {
                        parsedMetrics[type][uuid]["Component/network/total/rx[bits/second]"] = sum(summaryData[type][uuid].network_rx);
                    }
                    if (summaryData[type][uuid].network_tx) {
                        parsedMetrics[type][uuid]["Component/network/total/tx[bits/second]"] = sum(summaryData[type][uuid].network_tx);
                    }
                    if (summaryData[type][uuid].cpu) {
                        parsedMetrics[type][uuid]["Component/cpu/cpuAverage/Average CPU[%]"] = average(summaryData[type][uuid].cpu);
                    }
                }

            } catch (err) {
                console.log("post processing" + err);
            }
        }
    }

    return;

}

function newrelicPost() {
    console.log("newrelicPost()");

    var data = {};
    data['agent'] = {};
    data['components'] = [];

    data['agent']['host'] = newRelicConfig.host;
    data['agent']['version'] = '1.0.1';

    //console.log(util.inspect(parsedMetrics, false, null));

    // Build Components
    for (var x = 0, keys = Object.keys(parsedMetrics); x < keys.length; x++) {
        var type = keys[x];
        for (var i = 0, keys2 = Object.keys(parsedMetrics[type]); i < keys2.length; i++) {
            var uuid = keys2[i];
            var label;
            try {
                label = xenData[type][uuid].label.replace("/", "-");
                if (type=="host") {
                    label = "Host: " + label;
                }
                if (type=="vm") {
                    label = "VM: " + label;
                }
            } catch (err) {
                console.log(err);
                label = uuid;
            }

            var component = {};
            component.name = label;
            component.guid = 'com.mobilenations.xen-hosts';
            component.duration = 60;
            component.metrics = parsedMetrics[type][uuid];
            data['components'].push(component);

        }
    }

    //console.log(util.inspect(data, false, null));

    request({
        url: 'https://platform-api.newrelic.com/platform/v1/metrics',
        method: 'POST',
        json: data,
        headers: {
            'X-License-Key': newRelicConfig.licenseKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
    }, function(error, response, body){
        if(error) {
            console.log(error);
        } else {
            console.log(response.statusCode, body);
        }
    });


}

// Start Up.
connectXen();

// Helper JS
function toObject(names, values) {
    var result = {};
    for (var i = 0; i < names.length; i++)
        result[names[i]] = values[i];
    return result;
}

function average(input) {
    var total = 0;
    for(var i = 0; i < input.length; i++) {
        total += input[i];
    }
    var avg = total / input.length;
    avg = Math.round(avg * 100) / 100;
    return avg;
}

function sum(input) {
    var total = 0;
    for(var i = 0; i < input.length; i++) {
        total += input[i];
    }
    total = Math.round(total * 100) / 100;
    return total;
}