const {Api, Serialize} = require('eosjs');
const _ = require('lodash');
const prettyjson = require('prettyjson');
const {AbiDefinitions, RexAbi} = require("../definitions/abi_def");
const async = require('async');
const {debugLog} = require("../helpers/functions");
const {promisify} = require('util');
const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const rClient = manager.redisClient;
const getAsync = promisify(rClient.get).bind(rClient);

const txDec = new TextDecoder();
const txEnc = new TextEncoder();

let ch, api, types, client, cch, rpc, abi;
let ch_ready = false;
let tables = new Map();
let chainID = null;
let act_emit_idx = 1;
let delta_emit_idx = 1;
let block_emit_idx = 1;

let tbl_acc_emit_idx = 1;
let tbl_vote_emit_idx = 1;
let tbl_prop_emit_idx = 1;

let local_block_count = 0;
let allowStreaming = false;
let cachedMap;

let contracts = new Map();
let contractHitMap = new Map();

const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const index_queue_prefix = queue_prefix + ':index';
const index_queues = require('../definitions/index-queues').index_queues;
const n_deserializers = process.env.DESERIALIZERS;
const n_ingestors_per_queue = parseInt(process.env.ES_IDX_QUEUES, 10);
const action_indexing_ratio = parseInt(process.env.ES_AD_IDX_QUEUES, 10);

// Stage 2 consumer prefetch
const deserializerPrefetch = parseInt(process.env.BLOCK_PREFETCH, 10);
const consumerQueue = async.cargo(async.ensureAsync(processPayload), deserializerPrefetch);

const preIndexingQueue = async.queue(async.ensureAsync(sendToIndexQueue), 1);

// Load Modules
const HyperionModuleLoader = require('../modules/index').HyperionModuleLoader;
const mLoader = new HyperionModuleLoader(process.env.PARSER);

const common = {deserializeActionsAtBlock, attachActionExtras, processBlock};

function sendToIndexQueue(data, cb) {
    if (ch_ready) {
        ch.sendToQueue(data.queue, data.content);
        cb();
    } else {
        console.log('Channel is not ready!');
    }
}

// Stage 2 - Deserialization handler
function processPayload(payload, cb) {
    processMessages(payload).then(() => {
        cb();
    }).catch((err) => {
        console.log('NACK ALL', err);
        if (ch_ready) {
            ch.nackAll();
        }
    })
}

// Stage 2 - Deserialization function
async function processMessages(messages) {
    await mLoader.messageParser(common, messages, types, ch, ch_ready);
}

// Stage 2 - Block handler
async function processBlock(res, block, traces, deltas) {
    if (!res['this_block']) {
        console.log(res);
        return null;
    } else {
        let producer = '';
        let ts = '';
        const block_num = res['this_block']['block_num'];
        if (process.env.FETCH_BLOCK === 'true') {
            if (!block) {
                console.log(res);
            }
            producer = block['producer'];
            ts = block['timestamp'];

            // Collect total CPU and NET usage
            let total_cpu = 0;
            let total_net = 0;
            block.transactions.forEach((trx) => {
                total_cpu += trx['cpu_usage_us'];
                total_net += trx['net_usage_words'];
            });

            // const cpu_pct = ((total_cpu / 200000) * 100).toFixed(2);
            // const net_pct = ((total_net / 1048576) * 100).toFixed(2);
            // console.log(`Block: ${res['this_block']['block_num']} | CPU: ${total_cpu} μs (${cpu_pct} %) | NET: ${total_net} bytes (${net_pct} %)`);

            const light_block = {
                block_num: res['this_block']['block_num'],
                producer: block['producer'],
                new_producers: block['new_producers'],
                '@timestamp': block['timestamp'],
                schedule_version: block['schedule_version'],
                cpu_usage: total_cpu,
                net_usage: total_net
            };

            if (process.env.ENABLE_INDEXING === 'true') {
                const data = Buffer.from(JSON.stringify(light_block));
                const q = index_queue_prefix + "_blocks:" + (block_emit_idx);
                preIndexingQueue.push({
                    queue: q,
                    content: data
                });
                block_emit_idx++;
                if (block_emit_idx > n_ingestors_per_queue) {
                    block_emit_idx = 1;
                }
            }
            local_block_count++;
        }

        if (deltas && process.env.PROC_DELTAS === 'true') {
            const t1 = Date.now();
            await processDeltas(deltas, block_num);
            const elapsed_time = Date.now() - t1;
            if (elapsed_time > 10) {
                debugLog(`[WARNING] Delta processing took ${elapsed_time}ms on block ${block_num}`);
            }
        }

        if (traces.length > 0 && process.env.FETCH_TRACES === 'true') {
            const t2 = Date.now();
            for (const trace of traces) {
                const transaction_trace = trace[1];
                const {cpu_usage_us, net_usage_words} = transaction_trace;
                if (transaction_trace.status === 0) {
                    let action_count = 0;
                    const trx_id = transaction_trace['id'].toLowerCase();
                    const _actDataArray = [];
                    const _processedTraces = [];
                    const action_traces = transaction_trace['action_traces'];
                    // console.log(transaction_trace['partial']);
                    const t3 = Date.now();
                    for (const action_trace of action_traces) {
                        if (action_trace[0] === 'action_trace_v0') {
                            const action = action_trace[1];
                            const trx_data = {trx_id, block_num, producer, cpu_usage_us, net_usage_words};
                            const status = await mLoader.actionParser(common, ts, action, trx_data, _actDataArray, _processedTraces, transaction_trace);
                            if (status) {
                                action_count++;
                            }
                        }
                    }
                    const _finalTraces = [];

                    if (_processedTraces.length > 0) {
                        const digestMap = new Map();
                        // console.log(`----------- TRX ${trx_id} ------------------`);
                        for (let i = 0; i < _processedTraces.length; i++) {
                            const receipt = _processedTraces[i].receipt;
                            const act_digest = receipt['act_digest'];
                            if (digestMap.has(act_digest)) {
                                digestMap.get(act_digest).push(receipt);
                            } else {
                                const _arr = [];
                                _arr.push(receipt);
                                digestMap.set(act_digest, _arr);
                            }
                        }
                        _processedTraces.forEach(data => {
                            const digest = data['receipt']['act_digest'];
                            if (digestMap.has(digest)) {
                                // Apply notified accounts to first trace instance
                                const tempTrace = data;
                                tempTrace['receipts'] = [];
                                tempTrace['notified'] = [];
                                const tempSet = new Set();
                                digestMap.get(digest).forEach(val => {
                                    tempSet.add(val.receiver);
                                    tempTrace['code_sequence'] = val.code_sequence;
                                    tempTrace['abi_sequence'] = val.abi_sequence;
                                    delete val['code_sequence'];
                                    delete val['abi_sequence'];
                                    delete val['act_digest'];
                                    tempTrace['receipts'].push(val);
                                });
                                tempTrace['notified'] = Array.from(tempSet);
                                delete tempTrace['receipt'];
                                delete tempTrace['receiver'];
                                _finalTraces.push(tempTrace);
                                digestMap.delete(digest);
                            }
                        });
                        // console.log(prettyjson.render(_finalTraces));
                        // console.log(`---------------------------------------------`);
                    }

                    // Submit Actions after deduplication
                    for (const uniqueAction of _finalTraces) {
                        const payload = Buffer.from(JSON.stringify(uniqueAction));
                        if (process.env.ENABLE_INDEXING === 'true') {
                            const q = index_queue_prefix + "_actions:" + (act_emit_idx);
                            preIndexingQueue.push({
                                queue: q,
                                content: payload
                            });
                            act_emit_idx++;
                            if (act_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
                                act_emit_idx = 1;
                            }
                        }

                        if (allowStreaming && process.env.STREAM_TRACES === 'true') {
                            ch.publish('', queue_prefix + ':stream', payload, {
                                headers: {
                                    event: 'trace',
                                    account: uniqueAction['act']['account'],
                                    name: uniqueAction['act']['name'],
                                    notified: uniqueAction['notified'].join(",")
                                }
                            });
                        }
                    }

                    const act_elapsed_time = Date.now() - t3;
                    if (act_elapsed_time > 100) {
                        debugLog(`[WARNING] Actions processing took ${act_elapsed_time}ms on trx ${trx_id}`);
                        // console.log(action_traces);
                    }
                }
            }
            const traces_elapsed_time = Date.now() - t2;
            if (traces_elapsed_time > 10) {
                debugLog(`[WARNING] Traces processing took ${traces_elapsed_time}ms on block ${block_num}`);
            }
        }
        return {block_num: res['this_block']['block_num'], size: traces.length};
    }
}

function hitContract(code, block_num) {
    if (contractHitMap.has(code)) {
        contractHitMap.get(code).hits += 1;
        contractHitMap.get(code).last_usage = block_num;
    } else {
        contractHitMap.set(code, {
            hits: 1,
            last_usage: block_num
        });
    }
}

const abi_remapping = {
    "_Bool": "bool"
};

async function getContractAtBlock(accountName, block_num) {
    if (contracts.has(accountName)) {
        let _sc = contracts.get(accountName);
        hitContract(accountName, block_num);
        if ((_sc['valid_until'] > block_num && block_num > _sc['valid_from']) || _sc['valid_until'] === -1) {
            return [_sc['contract'], null];
        }
    }
    const savedAbi = await getAbiAtBlock(accountName, block_num);
    const abi = savedAbi.abi;
    const initialTypes = Serialize.createInitialTypes();
    let types;
    try {
        types = Serialize.getTypesFromAbi(initialTypes, abi);
    } catch (e) {
        let remapped = false;
        for (const struct of abi.structs) {
            for (const field of struct.fields) {
                if (abi_remapping[field.type]) {
                    field.type = abi_remapping[field.type];
                    remapped = true;
                }
            }
        }
        if (remapped) {
            try {
                types = Serialize.getTypesFromAbi(initialTypes, abi);
            } catch (e) {
                console.log('failed after remapping abi');
                console.log(e);
            }
        } else {
            console.log(accountName, block_num);
            console.log(e);
        }
    }
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        actions.set(name, Serialize.getType(types, type));
    }
    const result = {types, actions};
    contracts.set(accountName, {
        contract: result,
        valid_until: savedAbi.valid_until,
        valid_from: savedAbi.valid_from
    });
    return [result, abi];
}

async function deserializeActionsAtBlock(actions, block_num) {
    return Promise.all(actions.map(async ({account, name, authorization, data}) => {
        const contract = (await getContractAtBlock(account, block_num))[0];
        return Serialize.deserializeAction(contract, account, name, authorization, data, txEnc, txDec);
    }));
}

function attachActionExtras(action) {
    mLoader.processActionData(action);
}

function extractDeltaStruct(deltas) {
    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }
    return deltaStruct;
}

async function processDeltas(deltas, block_num) {
    const deltaStruct = extractDeltaStruct(deltas);

    // if (Object.keys(deltaStruct).length > 4) {
    //     console.log(Object.keys(deltaStruct));
    // }

    // Check account deltas for ABI changes
    if (deltaStruct['account']) {
        const rows = deltaStruct['account'];
        for (const account_raw of rows) {
            const serialBuffer = createSerialBuffer(account_raw.data);
            const data = types.get('account').deserialize(serialBuffer);
            const account = data[1];
            if (account['abi'] !== '') {
                try {
                    const initialTypes = Serialize.createInitialTypes();
                    const abiDefTypes = Serialize.getTypesFromAbi(initialTypes, AbiDefinitions).get('abi_def');
                    const jsonABIString = JSON.stringify(abiDefTypes.deserialize(createSerialBuffer(Serialize.hexToUint8Array(account['abi']))));
                    const new_abi_object = {
                        account: account['name'],
                        block: block_num,
                        abi: jsonABIString
                    };
                    debugLog(`[Worker ${process.env.worker_id}] read ${account['name']} ABI at block ${block_num}`);
                    const q = index_queue_prefix + "_abis:1";
                    preIndexingQueue.push({
                        queue: q,
                        content: Buffer.from(JSON.stringify(new_abi_object))
                    });
                    process.send({
                        event: 'save_abi',
                        data: new_abi_object
                    });
                } catch (e) {
                    console.log(e);
                    console.log(account['abi'], block_num, account['name']);
                }
            }
        }
    }

    if (process.env.ABI_CACHE_MODE === 'false' && process.env.PROC_DELTAS === 'true') {

        // Generated transactions
        if (process.env.PROCESS_GEN_TX === 'true') {
            if (deltaStruct['generated_transaction']) {
                const rows = deltaStruct['generated_transaction'];
                for (const gen_trx of rows) {
                    const serialBuffer = createSerialBuffer(gen_trx.data);
                    const data = types.get('generated_transaction').deserialize(serialBuffer);
                    await processDeferred(data[1], block_num);
                }
            }
        }

        // Contract Rows
        if (deltaStruct['contract_row']) {
            const rows = deltaStruct['contract_row'];
            for (const row of rows) {
                const sb = createSerialBuffer(row.data);
                try {
                    const payload = {
                        present: row.present,
                        version: sb.get(),
                        code: sb.getName(),
                        scope: sb.getName(),
                        table: sb.getName(),
                        primary_key: sb.getUint64AsNumber(),
                        payer: sb.getName(),
                        value: sb.getBytes()
                    };
                    if (process.env.INDEX_ALL_DELTAS === 'true' || (payload.code === 'eosio' || payload.table === 'accounts')) {
                        const jsonRow = await processContractRow(payload, block_num);
                        if (jsonRow['data']) {
                            await processTableDelta(jsonRow, block_num);
                        }

                        // if (!payload.present && payload.code === 'eosio.msig') {
                        //     console.log(block_num, jsonRow);
                        // }

                        if (allowStreaming && process.env.STREAM_DELTAS === 'true') {
                            const payload = Buffer.from(JSON.stringify(jsonRow));
                            ch.publish('', queue_prefix + ':stream', payload, {
                                headers: {
                                    event: 'delta',
                                    code: jsonRow.code,
                                    table: jsonRow.table
                                }
                            });
                        }
                    }
                } catch (e) {
                    console.log(block_num, e);
                }
            }
        }

        // TODO: store permission links on a dedicated index
        // if (deltaStruct['permission_link']) {
        //     if (deltaStruct['permission_link'].length > 0) {
        //         for (const permission_link of deltaStruct['permission_link']) {
        //             const serialBuffer = createSerialBuffer(permission_link.data);
        //             const data = types.get('permission_link').deserialize(serialBuffer);
        //             console.log(permission_link);
        //             const payload = {
        //                 present: permission_link.present,
        //                 account: data[1].account,
        //                 code: data[1].code,
        //                 action: data[1]['message_type'],
        //                 permission: data[1]['required_permission']
        //             };
        //             console.log(payload);
        //         }
        //     }
        // }

        // if (deltaStruct['permission']) {
        //     if (deltaStruct['permission'].length > 0) {
        //         for (const permission of deltaStruct['permission']) {
        //             const serialBuffer = createSerialBuffer(permission.data);
        //             const data = types.get('permission').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['contract_index64']) {
        //     if (deltaStruct['contract_index64'].length > 0) {
        //         for (const contract_index64 of deltaStruct['contract_index64']) {
        //             const serialBuffer = createSerialBuffer(contract_index64.data);
        //             const data = types.get('contract_index64').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }
        //
        // if (deltaStruct['contract_index128']) {
        //     if (deltaStruct['contract_index128'].length > 0) {
        //         for (const contract_index128 of deltaStruct['contract_index128']) {
        //             const serialBuffer = createSerialBuffer(contract_index128.data);
        //             const data = types.get('contract_index128').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['account_metadata']) {
        //     if (deltaStruct['account_metadata'].length > 0) {
        //         for (const account_metadata of deltaStruct['account_metadata']) {
        //             const serialBuffer = createSerialBuffer(account_metadata.data);
        //             const data = types.get('account_metadata').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['resource_limits']) {
        //     if (deltaStruct['resource_limits'].length > 0) {
        //         for (const resource_limits of deltaStruct['resource_limits']) {
        //             const serialBuffer = createSerialBuffer(resource_limits.data);
        //             const data = types.get('resource_limits').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['resource_usage']) {
        //     if (deltaStruct['resource_usage'].length > 0) {
        //         for (const resource_usage of deltaStruct['resource_usage']) {
        //             const serialBuffer = createSerialBuffer(resource_usage.data);
        //             const data = types.get('resource_usage').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['resource_limits_state']) {
        //     if (deltaStruct['resource_limits_state'].length > 0) {
        //         for (const resource_limits_state of deltaStruct['resource_limits_state']) {
        //             const serialBuffer = createSerialBuffer(resource_limits_state.data);
        //             const data = types.get('resource_limits_state').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['contract_table']) {
        //     if (deltaStruct['contract_table'].length > 0) {
        //         for (const contract_table of deltaStruct['contract_table']) {
        //             const serialBuffer = createSerialBuffer(contract_table.data);
        //             const data = types.get('contract_table').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }
    }
}

async function processContractRow(row, block) {
    const row_sb = createSerialBuffer(row['value']);
    const tableType = await getTableType(row['code'], row['table'], block);
    if (tableType) {
        try {
            row['data'] = tableType.deserialize(row_sb);
            return _.omit(row, ['value']);
        } catch (e) {
            // write error to CSV
            process.send({
                event: 'ds_error',
                data: {
                    type: 'delta_ds_error',
                    block: block,
                    code: row['code'],
                    table: row['table'],
                    message: e.message
                }
            });
            return row;
        }
    } else {
        return row;
    }
}

async function getTableType(code, table, block) {
    let abi, contract;
    [contract, abi] = await getContractAtBlock(code, block);
    if (!abi) {
        abi = (await getAbiAtBlock(code, block)).abi;
    }
    let this_table, type;
    for (let t of abi.tables) {
        if (t.name === table) {
            this_table = t;
            break;
        }
    }
    if (this_table) {
        type = this_table.type
    } else {
        // console.error(`Could not find table "${table}" in the abi for ${code} at block ${block}`);
        return;
    }
    let cType = contract.types.get(type);
    if (!cType) {
        if (types.has(type)) {
            cType = types.get(type);
        } else {
            if (type === 'self_delegated_bandwidth') {
                cType = contract.types.get('delegated_bandwidth')
            }
        }
        if (!cType) {
            console.log(code, block);
            console.log(`code:${code} | table:${table} | block:${block} | type:${type}`);
            console.log(Object.keys(contract));
            console.log(Object.keys(abi));
        }
    }
    return cType;
}

const tableHandlers = {
    'eosio:voters': async (delta) => {
        delta['@voters'] = {};
        delta['@voters']['is_proxy'] = delta.data['is_proxy'];
        delete delta.data['is_proxy'];
        delete delta.data['owner'];
        if (delta.data['proxy'] !== "") {
            delta['@voters']['proxy'] = delta.data['proxy'];
        }
        delete delta.data['proxy'];
        if (delta.data['producers'].length > 0) {
            delta['@voters']['producers'] = delta.data['producers'];
        }
        delete delta.data['producers'];
        delta['@voters']['last_vote_weight'] = parseFloat(delta.data['last_vote_weight']);
        delete delta.data['last_vote_weight'];
        delta['@voters']['proxied_vote_weight'] = parseFloat(delta.data['proxied_vote_weight']);
        delete delta.data['proxied_vote_weight'];
        delta['@voters']['staked'] = parseInt(delta.data['staked'], 10) / 10000;
        delete delta.data['staked'];
        if (process.env.VOTERS_STATE === 'true') {
            await storeVoter(delta);
        }
    },
    'eosio:global': async (delta) => {
        const data = delta['data'];
        delta['@global.data'] = {
            last_name_close: data['last_name_close'],
            last_pervote_bucket_fill: data['last_pervote_bucket_fill'],
            last_producer_schedule_update: data['last_producer_schedule_update'],
            perblock_bucket: parseFloat(data['perblock_bucket']) / 10000,
            pervote_bucket: parseFloat(data['perblock_bucket']) / 10000,
            total_activated_stake: parseFloat(data['total_activated_stake']) / 10000,
            total_producer_vote_weight: parseFloat(data['total_producer_vote_weight']),
            total_ram_kb_reserved: parseFloat(data['total_ram_bytes_reserved']) / 1024,
            total_ram_stake: parseFloat(data['total_ram_stake']) / 10000,
            total_unpaid_blocks: data['total_unpaid_blocks']
        };
        delete delta['data'];
    },
    'eosio:producers': async (delta) => {
        const data = delta['data'];
        delta['@producers'] = {
            total_votes: parseFloat(data['total_votes']),
            is_active: data['is_active'],
            unpaid_blocks: data['unpaid_blocks']
        };
        delete delta['data'];
    },
    'eosio:userres': async (delta) => {
        const data = delta['data'];
        const net = parseFloat(data['net_weight'].split(" ")[0]);
        const cpu = parseFloat(data['cpu_weight'].split(" ")[0]);
        delta['@userres'] = {
            owner: data['owner'],
            net_weight: net,
            cpu_weight: cpu,
            total_weight: parseFloat((net + cpu).toFixed(4)),
            ram_bytes: parseInt(data['ram_bytes'])
        };
        delete delta['data'];
        // console.log(delta);
    },
    'eosio:delband': async (delta) => {
        const data = delta['data'];
        const net = parseFloat(data['net_weight'].split(" ")[0]);
        const cpu = parseFloat(data['cpu_weight'].split(" ")[0]);
        delta['@delband'] = {
            from: data['from'],
            to: data['to'],
            net_weight: net,
            cpu_weight: cpu,
            total_weight: parseFloat((net + cpu).toFixed(4))
        };
        delete delta['data'];
        // console.log(delta);
    },
    'eosio.msig:proposal': async (delta) => {
        // decode packed_transaction
        delta['@proposal'] = {
            proposal_name: delta['data']['proposal_name']
        };
        // console.log('eosio.msig:proposal', delta);
        delete delta['data'];
    },
    'eosio.msig:approvals': async (delta) => {
        delta['@approvals'] = {
            proposal_name: delta['data']['proposal_name'],
            requested_approvals: delta['data']['requested_approvals'],
            provided_approvals: delta['data']['provided_approvals']
        };
        // console.log('eosio.msig:approvals', delta['@approvals']);
        delete delta['data'];
        if (process.env.PROPOSAL_STATE === 'true') {
            await storeProposal(delta);
        }
    },
    'eosio.msig:approvals2': async (delta) => {
        // console.log('eosio.msig:approvals2', delta['data']['requested_approvals']);
        delta['@approvals'] = {
            proposal_name: delta['data']['proposal_name'],
            requested_approvals: delta['data']['requested_approvals'].map((item) => {
                return {actor: item.level.actor, permission: item.level.permission, time: item.time};
            }),
            provided_approvals: delta['data']['provided_approvals'].map((item) => {
                return {actor: item.level.actor, permission: item.level.permission, time: item.time};
            })
        };
        // console.log('eosio.msig:approvals2', delta['@approvals']);
        if (process.env.PROPOSAL_STATE === 'true') {
            await storeProposal(delta);
        }
    },
    '*:accounts': async (delta) => {
        if (typeof delta['data']['balance'] === 'string') {
            try {
                const [amount, symbol] = delta['data']['balance'].split(" ");
                delta['@accounts'] = {
                    amount: parseFloat(amount),
                    symbol: symbol
                };
                delete delta.data['balance'];
            } catch (e) {
                console.log(delta);
                console.log(e);
            }
        }
        if (process.env.ACCOUNT_STATE === 'true') {
            await storeAccount(delta);
        }
    }
};

async function storeProposal(data) {
    const proposalDoc = {
        proposer: data['scope'],
        proposal_name: data['@approvals']['proposal_name'],
        requested_approvals: data['@approvals']['requested_approvals'],
        provided_approvals: data['@approvals']['provided_approvals'],
        executed: data.present === false,
        primary_key: data['primary_key'],
        block_num: data['block_num']
    };
    // console.log('-------------- PROPOSAL --------------');
    // console.log(prettyjson.render(proposalDoc));
    if (process.env.ENABLE_INDEXING === 'true') {
        const q = index_queue_prefix + "_table_proposals:" + (tbl_prop_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(proposalDoc))
        });
        tbl_prop_emit_idx++;
        if (tbl_prop_emit_idx > (n_ingestors_per_queue)) {
            tbl_prop_emit_idx = 1;
        }
    }
}

async function storeVoter(data) {
    const voterDoc = {
        "voter": data['payer'],
        "last_vote_weight": data['@voters']['last_vote_weight'],
        "is_proxy": data['@voters']['is_proxy'],
        "proxied_vote_weight": data['@voters']['proxied_vote_weight'],
        "staked": data['@voters']['staked'],
        "primary_key": data['primary_key'],
        "block_num": data['block_num']
    };
    if (data['@voters']['proxy']) {
        voterDoc.proxy = data['@voters']['proxy'];
    }
    if (data['@voters']['producers']) {
        voterDoc.producers = data['@voters']['producers'];
    }

    // console.log('-------------- VOTER --------------');
    // console.log(prettyjson.render(data));

    if (process.env.ENABLE_INDEXING === 'true') {
        const q = index_queue_prefix + "_table_voters:" + (tbl_vote_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(voterDoc))
        });
        tbl_vote_emit_idx++;
        if (tbl_vote_emit_idx > (n_ingestors_per_queue)) {
            tbl_vote_emit_idx = 1;
        }
    }
}

async function storeAccount(data) {
    const accountDoc = {
        "code": data['code'],
        "scope": data['scope'],
        "primary_key": data['primary_key'],
        "block_num": data['block_num']
    };
    if (data['@accounts']) {
        accountDoc['amount'] = data['@accounts']['amount'];
        accountDoc['symbol'] = data['@accounts']['symbol'];
    }

    // console.log('-------------- ACCOUNT --------------');
    // console.log(prettyjson.render(accountDoc));

    if (process.env.ENABLE_INDEXING === 'true') {
        const q = index_queue_prefix + "_table_accounts:" + (tbl_acc_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(accountDoc))
        });
        tbl_acc_emit_idx++;
        if (tbl_acc_emit_idx > (n_ingestors_per_queue)) {
            tbl_acc_emit_idx = 1;
        }
    }
}

async function processTableDelta(data, block_num) {
    if (data['table']) {
        data['block_num'] = block_num;
        data['primary_key'] = String(data['primary_key']);
        let allowIndex = true;
        let handled = false;
        const key = `${data.code}:${data.table}`;
        if (tableHandlers[key]) {
            await tableHandlers[key](data);
            handled = true;
        }
        if (tableHandlers[`${data.code}:*`]) {
            await tableHandlers[`${data.code}:*`](data);
            handled = true;
        }
        if (tableHandlers[`*:${data.table}`]) {
            await tableHandlers[`*:${data.table}`](data);
            handled = true;
        }
        if (!handled && process.env.INDEX_ALL_DELTAS === 'true') {
            allowIndex = true;
        } else if (handled) {
            allowIndex = true;
        }
        if (process.env.ENABLE_INDEXING === 'true' && allowIndex && process.env.INDEX_DELTAS === 'true') {
            const q = index_queue_prefix + "_deltas:" + (delta_emit_idx);
            preIndexingQueue.push({
                queue: q,
                content: Buffer.from(JSON.stringify(data))
            });
            delta_emit_idx++;
            if (delta_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
                delta_emit_idx = 1;
            }
        }
    }
}

function createSerialBuffer(inputArray) {
    return new Serialize.SerialBuffer({textEncoder: txEnc, textDecoder: txDec, array: inputArray});
}

async function processDeferred(data, block_num) {
    if (data['packed_trx']) {
        const sb_trx = createSerialBuffer(Serialize.hexToUint8Array(data['packed_trx']));
        const data_trx = types.get('transaction').deserialize(sb_trx);
        data = _.omit(_.merge(data, data_trx), ['packed_trx']);
        data['actions'] = await api.deserializeActions(data['actions']);
        data['trx_id'] = data['trx_id'].toLowerCase();
        if (data['delay_sec'] > 0) {
            console.log(`-------------- DELAYED ${block_num} -----------------`);
            console.log(prettyjson.render(data));
        }
    }
}

async function getAbiFromHeadBlock(code) {
    return {abi: await api.getAbi(code), valid_until: null, valid_from: null};
}

async function getAbiAtBlock(code, block_num) {
    const refs = cachedMap[code];
    if (refs) {
        if (refs.length > 0) {
            let lastblock = 0;
            let validity = -1;
            for (const block of refs) {
                if (block > block_num) {
                    validity = block;
                    break;
                } else {
                    lastblock = block;
                }
            }
            const cachedAbiAtBlock = await getAsync(process.env.CHAIN + ":" + lastblock + ":" + code);
            let abi;
            if (!cachedAbiAtBlock) {
                console.log('remote abi fetch [1]', code, block_num);
                return await getAbiFromHeadBlock(code);
            } else {
                try {
                    abi = JSON.parse(cachedAbiAtBlock);
                    return {abi: abi, valid_until: validity, valid_from: lastblock};
                } catch (e) {
                    console.log('failed to parse saved ABI', code, block_num);
                    console.log(cachedAbiAtBlock);
                    console.log('----------  END CACHED ABI ------------');
                    return {abi: null, valid_until: null, valid_from: null};
                }
            }
        } else {
            console.log('remote abi fetch [2]', code, block_num);
            return await getAbiFromHeadBlock(code);
        }
    } else {
        const ref_time = Date.now();
        let _abi;
        try {
            _abi = await api.getAbi(code);
            const elapsed_time = (Date.now() - ref_time);
            if (elapsed_time > 10) {
                console.log(`[DS ${process.env.worker_id}] remote abi fetch [type 3] for ${code} at ${block_num} took too long (${elapsed_time}ms)`);
            }
        } catch (e) {
            if (code === 'eosio.rex') {
                _abi = RexAbi;
            } else {
                console.log(e);
                return {abi: null, valid_until: null, valid_from: null};
            }
        }
        return {abi: _abi, valid_until: null, valid_from: null};
    }
}

function assertQueues() {
    if (ch) {
        ch_ready = true;
        if (preIndexingQueue.paused) {
            preIndexingQueue.resume();
        }
        ch.on('close', () => {
            ch_ready = false;
            preIndexingQueue.pause();
        });
    }

    // input queues
    if (process.env['live_mode'] === 'false') {
        for (let i = 0; i < n_deserializers; i++) {
            ch.assertQueue(queue + ":" + (i + 1), {
                durable: true
            });
        }
    }

    // output
    let qIdx = 0;
    index_queues.forEach((q) => {
        let n = n_ingestors_per_queue;
        if (q.type === 'abi') n = 1;
        qIdx = 0;
        for (let i = 0; i < n; i++) {
            let m = 1;
            if (q.type === 'action' || q.type === 'delta') {
                m = action_indexing_ratio;
            }
            for (let j = 0; j < m; j++) {
                ch.assertQueue(q.name + ":" + (qIdx + 1), {durable: true});
                qIdx++;
            }
        }
    });
}

function initConsumer() {
    if (ch_ready) {
        ch.prefetch(deserializerPrefetch);
        ch.consume(process.env['worker_queue'], (data) => {
            consumerQueue.push(data);
        });
    }
}

async function run() {

    setInterval(() => {
        debugLog(` ${process.env.worker_id} - Contract Map Count: ${contracts.size}`);
        contractHitMap.forEach((value, key) => {
            debugLog(`Code: ${key} - Hits: ${value.hits}`);
            if (value.hits < 100) {
                contracts.delete(key);
            }
        });
    }, 25000);

    cachedMap = JSON.parse(await getAsync(process.env.CHAIN + ":" + 'abi_cache'));
    if (!cachedMap) {
        cachedMap = {};
    }
    rpc = manager.nodeosJsonRPC;
    const chain_data = await rpc.get_info();
    chainID = chain_data.chain_id;
    api = new Api({
        rpc,
        signatureProvider: null,
        chainId: chain_data.chain_id,
        textDecoder: txDec,
        textEncoder: txEnc,
    });

    client = manager.elasticsearchClient;

    // Connect to RabbitMQ (amqplib)
    [ch, cch] = await manager.createAMQPChannels((channels) => {
        [ch, cch] = channels;
        assertQueues();
        initConsumer();
    });

    assertQueues();

    process.on('message', (msg) => {
        if (msg.event === 'initialize_abi') {
            abi = JSON.parse(msg.data);
            const initialTypes = Serialize.createInitialTypes();
            types = Serialize.getTypesFromAbi(initialTypes, abi);
            abi.tables.map(table => tables.set(table.name, table.type));
            // console.log('setting up deserializer on ' + process.env['worker_queue']);
            initConsumer();
        }
        if (msg.event === 'connect_ws') {
            allowStreaming = true;
        }
    });
}

module.exports = {run};
