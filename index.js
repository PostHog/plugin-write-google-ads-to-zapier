async function setupPlugin({config, global}) {
    global.posthogUrl = config.postHogUrl
    global.apiToken = config.postHogApiToken
    global.projectToken = config.postHogProjectToken
    global.syncScoresIntoPosthog = global.posthogUrl && global.apiToken && global.projectToken
}


function addDays(date, days) {
    var result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

async function runEveryMinute({config, global, storage}) {
    if (!global.syncScoresIntoPosthog) {
        console.log('Not syncing Hubspot Scores into PostHog - config not set.')
        return
    }

    const TIME_KEY = 'queryStartTime'
    const CATCHUP_DAYS = 2
    const _lastRunTime = await storage.get(TIME_KEY)

    let queryStartTime = _lastRunTime ? new Date(_lastRunTime) : new Date(2021, 7, 1)
    if (queryStartTime < new Date(2021, 6, 1)) {
        queryStartTime = new Date(2021, 6, 1)
    }

    const queryEnd = addDays(queryStartTime, CATCHUP_DAYS) > new Date() ? new Date() : addDays(queryStartTime, CATCHUP_DAYS)

    const actions = [11196, 11038, 11037, 11036]
    console.log(`AWAKE AND QUERYING: ${queryStartTime} - ${queryEnd}`)
    const conversionEvents = []
    for (const actionId of actions) {
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
    for (const event of conversionEvents) {
        console.log(`[period=${queryStartTime}-${queryEnd}] Processed ${numProcessed} / ${conversionEvents.length} events, writes: ${writes}`)

        const distinctId = event['distinct_id']
        const eventProps = event['properties']

        let gclid = eventProps.gclid || eventProps.$initial_gclid || distinctIdToGclid[distinctId]

        // there's no gclid and we haven't already queried this persons' properties
        if (queriedPersons.has(distinctId)) {
            console.log('cache hit! :D ')
        }
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
                action_id: "todo",
                gclid: gclid,
                conversion_name: "todo",
                timestamp: event.sent_at || event.timestamp
            }

            await fetch('https://hooks.zapier.com/hooks/catch/8898847/bd66stu/', {
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



