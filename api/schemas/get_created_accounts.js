exports.GET = {
    description: 'get all accounts created by one creator',
    summary: 'get created accounts',
    tags: ['history'],
    querystring: {
        type: 'object',
        properties: {
            "account": {
                description: 'creator account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        }
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "query_time": {
                    type: "number"
                },
                "total": {
                    type: "object",
                    properties: {
                        "value": {type: "number"},
                        "relation": {type: "string"}
                    }
                },
                "accounts": {
                    type: "array",
                    items: {
                        type: 'object',
                        properties: {
                            'name': {type:'string'},
                            'timestamp': {type:'string'},
                            'trx_id': {type:'string'}
                        }
                    }
                },
                "skip": {
                    description: 'skip [n] actions (pagination)',
                    type: 'integer',
                    minimum: 0
                },
                "limit": {
                    description: 'limit of [n] actions per page',
                    type: 'integer',
                    minimum: 1
                }
            }
        }
    }
};
