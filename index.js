async function setupPlugin({config, global}) {
    global.posthogUrl = config.postHogUrl.replace(/\/$/, '')
    global.apiToken = config.postHogApiToken
    global.projectToken = config.postHogProjectToken
    global.zapierUrl = config.zapierUrl
    global.actionIdToName = {}
    config.actionIdToName.split(',').forEach(pair => {
        const [actionId, conversionName] = pair.split(':')
        global.actionIdToName[parseInt(actionId)] = conversionName
    })
    global.defaultStartTime = new Date(config.defaultStartTime)
    const isConfigValid = global.posthogUrl
        && global.apiToken
        && global.projectToken
        && global.zapierUrl
        && Object.keys(global.actionIdToName).length
        && isValidDate(global.defaultStartTime)
    if (!isConfigValid) {
        throw new Error('One or more required config fields is missing or invalid.')
    }
}

function isValidDate(date) {
    return date.toString() !== 'Invalid Date'
}

function addDays(date, days) {
    const result = new Date(date)
    result.setDate(result.getDate() + days)
    return result
}

function formatTimestampForGoogle(date){
    const result = new Date(date)
    if (isValidDate(result)) {
        result.setMilliseconds(0)
        return result.toISOString().replace(/\.\d+Z$/, '+0000')
    } else {
        console.warn(`Received invalid date "${date}"`)
        return date
    }
}

function extractGclidFromEvent(event) {
    const eventProperties = event.properties || {}
    const personProperties = event.person?.properties || {}

    if ('gclid' in eventProperties) {
        return eventProperties.gclid
    }
    if ('gclid' in personProperties) {
        return personProperties.gclid
    }
    if ('$initial_gclid' in personProperties) {
        return personProperties.$initial_gclid
    }
    if ('$set' in eventProperties) {
        const { $set } = eventProperties
        if ('gclid' in $set) {
            return $set.gclid
        }
        if ('$initial_gclid' in $set) {
            return $set.$initial_gclid
        }
    }
    if ('$set_once' in eventProperties) {
        const { $set_once } = eventProperties
        if ('gclid' in $set_once) {
            return $set_once.gclid
        }
        if ('$initial_gclid' in $set_once) {
            return $set_once.$initial_gclid
        }
    }

    return null
}

async function runEveryMinute({ global, storage }) {
    const TIME_KEY = 'googleAdsLastQueryStartTime'
    const CATCHUP_DAYS = 1
    const _lastRunTime = await storage.get(TIME_KEY)

    let queryStartTime = _lastRunTime ? new Date(_lastRunTime) : global.defaultStartTime

    const queryEnd = addDays(queryStartTime, CATCHUP_DAYS) > new Date() ? new Date() : addDays(queryStartTime, CATCHUP_DAYS)

    console.log(`AWAKE AND QUERYING: ${queryStartTime} - ${queryEnd}`)
    const conversionEvents = []
    for (const actionId of Object.keys(global.actionIdToName)) {
        let fetchUrl = `${global.posthogUrl}/api/event/?limit=1000&token=${global.projectToken}&action_id=${actionId}&after=${queryStartTime.toISOString()}&before=${queryEnd.toISOString()}`
        while (fetchUrl) {
            const _updateRes = await fetch(
                fetchUrl,
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${global.apiToken}`,
                        Accept: 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            )
            const asJson = await _updateRes.json()
            for (const eventJson of asJson['results']) {
                eventJson.actionId = actionId
            }
            conversionEvents.push(...asJson['results'])
            console.log(`LOADED Action id: ${actionId}, next: ${asJson['next']}; results: ${asJson['results'].length}, period: ${queryStartTime} - ${queryEnd}`)
            fetchUrl = asJson['next']
        }
    }

    console.log(`Loaded ${conversionEvents.length} conversion events `)
    let numProcessed = 0
    let writes = 0
    const distinctIdToGclid = {}
    const queriedPersons = new Set()
    console.log(`Begin processing events for Period: ${queryStartTime} - ${queryEnd}`)
    for (const event of conversionEvents) {
        if (numProcessed % 10 === 0) {
            console.log(`Processed ${numProcessed} / ${conversionEvents.length} events, writes to zapier: ${writes}`)
        }

        const distinctId = event['distinct_id']

        let gclid = extractGclidFromEvent(event) || distinctIdToGclid[distinctId]

        // there's no gclid and we haven't already queried this persons' properties
        if (!gclid && !queriedPersons.has(distinctId)) {
            let fetchUrl = `${global.posthogUrl}/api/person/?distinct_id=${distinctId}&token=${global.projectToken}`
            const _personRes = await fetch(
                fetchUrl,
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${global.apiToken}`,
                        Accept: 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            )

            const personResJson = await _personRes.json()
            for (const personJson of personResJson['results']) {
                const properties = personJson.properties
                gclid = properties.gclid || properties.$initial_gclid
                if (gclid) {
                    break // we found a gclid
                }
            }
        }

        if (gclid) {
            distinctIdToGclid[distinctId] = gclid
            const payload = {
                action_id: event.actionId,
                gclid: gclid,
                conversion_name: global.actionIdToName[event.actionId],
                timestamp: formatTimestampForGoogle(event.sent_at || event.timestamp)
            }

            await fetch(global.zapierUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),

            })

            writes += 1

            console.log(`WRITE TO ZAPIER: ${JSON.stringify(payload)}`)
        }

        numProcessed += 1

    }
    await storage.set(TIME_KEY, queryEnd)
    console.log(`UPDATED TIME TO: ${queryEnd}`)
}
